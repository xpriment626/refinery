import fs from "node:fs";
import path from "node:path";
import type { ModelConfig } from "../env.ts";
import { loadModelConfig } from "../env.ts";
import { createMastraModelCaller, mastraRuntimeMetadata } from "../mastra/runtime.ts";
import type { LocalSpecialist } from "../specialists/types.ts";
import type { ExperimentPaths, ModelCaller } from "./capture.ts";

export interface ArtifactRunResult<T> {
  runId: string;
  runDir: string;
  parsed: T;
}

export interface BaseExperimentOptions {
  runId?: string;
  model?: ModelConfig;
  callModel?: ModelCaller;
}

export function defaultRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function loadDefaultModel(): ModelConfig {
  return loadModelConfig(path.resolve(import.meta.dirname, "../.."));
}

export function redactModel(config: ModelConfig): Omit<ModelConfig, "apiKey"> & {
  apiKeyPresent: boolean;
} {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyPresent: Boolean(config.apiKey),
  };
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Model response did not contain a JSON object.");
  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

export function latestParsed<T>(paths: ExperimentPaths, prefix: string): T | null {
  const dir = path.join(paths.home, "experiments");
  if (!fs.existsSync(dir)) return null;
  const latest = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!latest) return null;
  const parsedPath = path.join(dir, latest, "output.parsed.json");
  if (!fs.existsSync(parsedPath)) return null;
  return JSON.parse(fs.readFileSync(parsedPath, "utf8")) as T;
}

export async function runArtifactExperiment<T>(args: {
  paths: ExperimentPaths;
  runId: string;
  specialist: LocalSpecialist;
  model: ModelConfig;
  prompt: { system: string; user: string };
  inputPayload: Record<string, unknown>;
  parse: (raw: string) => T;
  evalMarkdown: (parsed: T) => string;
  callModel?: ModelCaller;
}): Promise<ArtifactRunResult<T>> {
  const runDir = path.join(args.paths.home, "experiments", args.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "input.json"),
    JSON.stringify(
      {
        run_id: args.runId,
        specialist: args.specialist,
        runtime: mastraRuntimeMetadata(args.specialist),
        model: redactModel(args.model),
        ...args.inputPayload,
        prompt: args.prompt,
      },
      null,
      2,
    ),
  );

  const raw = await (args.callModel ?? createMastraModelCaller(args.specialist))({
    model: args.model,
    system: args.prompt.system,
    user: args.prompt.user,
  });
  fs.writeFileSync(path.join(runDir, "output.raw.md"), raw);

  let parsed: T;
  try {
    parsed = args.parse(raw);
  } catch (e) {
    fs.writeFileSync(
      path.join(runDir, "eval.md"),
      [
        `# ${args.specialist.name} Experiment Eval`,
        "",
        "- Status: parse failed",
        `- Error: ${(e as Error).message}`,
        "- Role boundary: no database writes, proposal creation, or activation attempted.",
        "",
        "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
      ].join("\n"),
    );
    throw e;
  }

  fs.writeFileSync(path.join(runDir, "output.parsed.json"), JSON.stringify(parsed, null, 2));
  fs.writeFileSync(path.join(runDir, "eval.md"), args.evalMarkdown(parsed));
  return { runId: args.runId, runDir, parsed };
}

export function printCliResult<T extends { [key: string]: unknown }>(
  label: string,
  result: ArtifactRunResult<T>,
  count: number,
): void {
  console.log(`${label} experiment saved: ${path.relative(process.cwd(), result.runDir)}`);
  console.log(`Records parsed: ${count}`);
}
