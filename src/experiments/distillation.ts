#!/usr/bin/env node
import { resolvePaths } from "../config.ts";
import { distillationSpecialist } from "../specialists/distillation.ts";
import type { CaptureOutput, CaptureCandidate, ExperimentPaths } from "./capture.ts";
import {
  defaultRunId,
  extractJson,
  latestParsed,
  loadDefaultModel,
  printCliResult,
  runArtifactExperiment,
  type ArtifactRunResult,
  type BaseExperimentOptions,
} from "./shared.ts";

export interface DistilledMemory {
  body: string;
  source_refs: unknown[];
  rationale: string;
}

export interface DistillationOutput {
  distilled: DistilledMemory[];
}

const fixtureCapture: CaptureOutput = {
  candidates: [
    {
      claim:
        "Memory refinement should run over source session history first; existing memories are weak ground-truth comparisons.",
      source_refs: [{ source_id: 1, session_id: "fixture", chunk_index: 0 }],
      why_future_useful:
        "Keeps specialist tests grounded in source evidence rather than already-curated memory files.",
    },
  ],
};

function loadCaptureSeed(paths: ExperimentPaths): CaptureOutput {
  return latestParsed<CaptureOutput>(paths, "capture") ?? fixtureCapture;
}

function prompt(capture: CaptureOutput): { system: string; user: string } {
  return {
    system: [
      distillationSpecialist.prompt,
      "",
      "Return only JSON matching this shape:",
      `{"distilled":[{"body":"...","source_refs":[],"rationale":"..."}]}`,
      "For this smoke test, return exactly one concise distilled memory. Keep strings under 260 characters.",
      "Do not create proposals. Do not activate memory.",
    ].join("\n"),
    user: [
      "Distill this Capture output into one durable, self-contained memory body.",
      "",
      JSON.stringify(capture, null, 2),
    ].join("\n"),
  };
}

export function parseDistillationOutput(raw: string): DistillationOutput {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { distilled?: unknown }).distilled)) {
    throw new Error("Distillation output must contain distilled array.");
  }
  return {
    distilled: (parsed as { distilled: unknown[] }).distilled.map((item, i) => {
      if (!item || typeof item !== "object") throw new Error(`Distilled item ${i} must be an object.`);
      const d = item as Partial<DistilledMemory>;
      if (typeof d.body !== "string" || !d.body.trim()) throw new Error(`Distilled item ${i} missing body.`);
      if (!Array.isArray(d.source_refs)) throw new Error(`Distilled item ${i} missing source_refs array.`);
      if (typeof d.rationale !== "string" || !d.rationale.trim()) {
        throw new Error(`Distilled item ${i} missing rationale.`);
      }
      return { body: d.body, source_refs: d.source_refs, rationale: d.rationale };
    }),
  };
}

function evalMarkdown(parsed: DistillationOutput): string {
  return [
    "# Distillation Experiment Eval",
    "",
    `- Distilled memory count: ${parsed.distilled.length}`,
    `- Items with source refs: ${parsed.distilled.filter((d) => d.source_refs.length > 0).length}`,
    "- Role boundary: distillation-only output; no proposal creation or activation attempted.",
    `- Usability: ${parsed.distilled.some((d) => d.body.length > 30) ? "self-contained memory body present" : "no clearly usable body"}`,
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runDistillationExperiment(
  paths: ExperimentPaths,
  options: BaseExperimentOptions = {},
): Promise<ArtifactRunResult<DistillationOutput>> {
  const capture = loadCaptureSeed(paths);
  const builtPrompt = prompt(capture);
  return runArtifactExperiment({
    paths,
    runId: options.runId ?? defaultRunId("distillation"),
    specialist: distillationSpecialist,
    model: options.model ?? loadDefaultModel(),
    prompt: builtPrompt,
    inputPayload: { capture_seed: capture },
    parse: parseDistillationOutput,
    evalMarkdown,
    callModel: options.callModel,
  });
}

export async function runDistillationExperimentFromCli(): Promise<void> {
  const result = await runDistillationExperiment(resolvePaths());
  printCliResult("Distillation", result, result.parsed.distilled.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDistillationExperimentFromCli().catch((e) => {
    process.stderr.write(`Distillation experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
