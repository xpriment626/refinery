import fs from "node:fs";
import path from "node:path";
import { refineryReviewSchemaVersion } from "./adapter.ts";
import { RefineryError } from "./errors.ts";
import { type ReviewIntent } from "./intents.ts";

export const reviewStepOrder = ["capture", "distillation", "schema", "relevance", "relationship-review"];

export type ReviewRunMode = "deterministic" | "live" | "coral";

export type ReviewRunStatus = "succeeded" | "failed";

export interface ReviewStepArtifactPaths {
  input?: string;
  outputRaw?: string;
  outputParsed?: string;
}

export interface ReviewArtifactManifest {
  ok: boolean;
  schemaVersion: typeof refineryReviewSchemaVersion;
  command: "review";
  runId: string;
  runDir: string;
  mode: ReviewRunMode;
  adapter: string | null;
  scope: string;
  intent?: ReviewIntent;
  request?: string | null;
  status: ReviewRunStatus;
  createdAt: string;
  failedAt?: string;
  failedStep?: string | null;
  rawOutputPath?: string | null;
  counts?: Record<string, number>;
  runtime?: Record<string, unknown>;
  model?: Record<string, unknown>;
  stepOrder: string[];
  artifacts: {
    manifest: string;
    input?: string;
    metadata?: string;
    review?: string;
    proposals?: string;
    rejected?: string;
    status?: string;
    sink?: string;
    coral?: string;
    transcript?: string;
    steps: Record<string, ReviewStepArtifactPaths>;
  };
  error?: Record<string, unknown>;
}

export interface TrialInspectSummary {
  ok: boolean;
  command: "trial inspect";
  schemaVersion: typeof refineryReviewSchemaVersion;
  runId: string;
  runDir: string;
  mode: ReviewRunMode;
  status: ReviewRunStatus;
  counts: Record<string, number>;
  actionDistribution: Record<string, number>;
  lifecycleDistribution: Record<string, number>;
  steps: Record<string, { input: boolean; outputRaw: boolean; outputParsed: boolean }>;
  artifacts: ReviewArtifactManifest["artifacts"];
  sink?: Record<string, unknown>;
  error?: Record<string, unknown>;
  manifest: ReviewArtifactManifest;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function existingRel(runDir: string, relPath: string): string | undefined {
  return fs.existsSync(path.join(runDir, relPath)) ? relPath : undefined;
}

function readArrayCount(runDir: string, relPath: string): number {
  const filePath = path.join(runDir, relPath);
  if (!fs.existsSync(filePath)) return 0;
  const parsed = readJson(filePath);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function readOptionalObject(runDir: string, relPath: string): Record<string, unknown> | undefined {
  const filePath = path.join(runDir, relPath);
  if (!fs.existsSync(filePath)) return undefined;
  const parsed = readJson(filePath);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function buildStepArtifacts(runDir: string): Record<string, ReviewStepArtifactPaths> {
  return Object.fromEntries(
    reviewStepOrder.map((step) => [
      step,
      {
        input: existingRel(runDir, `steps/${step}/input.json`),
        outputRaw: existingRel(runDir, `steps/${step}/output.raw.md`),
        outputParsed: existingRel(runDir, `steps/${step}/output.parsed.json`),
      },
    ]),
  );
}

function buildArtifactPaths(runDir: string): ReviewArtifactManifest["artifacts"] {
  return {
    manifest: "manifest.json",
    input: existingRel(runDir, "input.json"),
    metadata: existingRel(runDir, "metadata.json"),
    review: existingRel(runDir, "review.json"),
    proposals: existingRel(runDir, "proposals.json"),
    rejected: existingRel(runDir, "rejected.json"),
    status: existingRel(runDir, "status.json"),
    sink: existingRel(runDir, "sink.json"),
    coral: existingRel(runDir, "coral.json"),
    transcript: existingRel(runDir, "transcript.json"),
    steps: buildStepArtifacts(runDir),
  };
}

export function writeReviewArtifactManifest(args: {
  runDir: string;
  runId: string;
  adapterName: string | null;
  scope: string;
  mode: ReviewRunMode;
  status: ReviewRunStatus;
  createdAt: string;
  failedAt?: string;
  failedStep?: string | null;
  rawOutputPath?: string | null;
  counts?: Record<string, number>;
  metadata?: Record<string, unknown>;
  error?: Record<string, unknown>;
  intent?: ReviewIntent;
  request?: string | null;
}): ReviewArtifactManifest {
  const counts = args.counts ?? {
    proposals: readArrayCount(args.runDir, "proposals.json"),
    rejected: readArrayCount(args.runDir, "rejected.json"),
  };
  const manifest: ReviewArtifactManifest = {
    ok: args.status === "succeeded",
    schemaVersion: refineryReviewSchemaVersion,
    command: "review",
    runId: args.runId,
    runDir: args.runDir,
    mode: args.mode,
    adapter: args.adapterName,
    scope: args.scope,
    ...(args.intent ? { intent: args.intent } : {}),
    ...(args.request !== undefined ? { request: args.request } : {}),
    status: args.status,
    createdAt: args.createdAt,
    ...(args.failedAt ? { failedAt: args.failedAt } : {}),
    ...(args.failedStep !== undefined ? { failedStep: args.failedStep } : {}),
    ...(args.rawOutputPath !== undefined ? { rawOutputPath: args.rawOutputPath } : {}),
    counts,
    ...(args.metadata?.runtime && typeof args.metadata.runtime === "object"
      ? { runtime: args.metadata.runtime as Record<string, unknown> }
      : {}),
    ...(args.metadata?.model && typeof args.metadata.model === "object"
      ? { model: args.metadata.model as Record<string, unknown> }
      : {}),
    stepOrder: reviewStepOrder,
    artifacts: buildArtifactPaths(args.runDir),
    ...(args.error ? { error: args.error } : {}),
  };
  writeJson(path.join(args.runDir, "manifest.json"), manifest);
  return manifest;
}

function readManifest(runDir: string): ReviewArtifactManifest {
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new RefineryError("TRIAL_INVALID", "Run directory is missing manifest.json.", {
      phase: "trial-inspect",
      runDir,
    });
  }
  try {
    const parsed = readJson(manifestPath) as Partial<ReviewArtifactManifest>;
    if (
      parsed.schemaVersion !== refineryReviewSchemaVersion ||
      parsed.command !== "review" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.runDir !== "string" ||
      (parsed.status !== "succeeded" && parsed.status !== "failed")
    ) {
      throw new Error("manifest.json does not match the Refinery review manifest contract.");
    }
    return parsed as ReviewArtifactManifest;
  } catch (error) {
    if (error instanceof RefineryError) throw error;
    throw new RefineryError(
      "TRIAL_INVALID",
      error instanceof Error ? error.message : String(error),
      { phase: "trial-inspect", runDir },
    );
  }
}

function readProposals(runDir: string): Array<Record<string, unknown>> {
  const proposalsPath = path.join(runDir, "proposals.json");
  if (!fs.existsSync(proposalsPath)) return [];
  const parsed = readJson(proposalsPath);
  return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
}

function countByStringField(records: Array<Record<string, unknown>>, field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const value = record[field];
    if (typeof value !== "string" || !value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function stepPresence(runDir: string): TrialInspectSummary["steps"] {
  return Object.fromEntries(
    reviewStepOrder.map((step) => [
      step,
      {
        input: fs.existsSync(path.join(runDir, `steps/${step}/input.json`)),
        outputRaw: fs.existsSync(path.join(runDir, `steps/${step}/output.raw.md`)),
        outputParsed: fs.existsSync(path.join(runDir, `steps/${step}/output.parsed.json`)),
      },
    ]),
  );
}

export function inspectReviewRun(runDirInput: string): TrialInspectSummary {
  const runDir = path.resolve(runDirInput);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new RefineryError("TRIAL_NOT_FOUND", `Run directory not found: ${runDir}`, {
      phase: "trial-inspect",
      runDir,
    });
  }
  const manifest = readManifest(runDir);
  const proposals = readProposals(runDir);
  const status = readOptionalObject(runDir, "status.json");
  const sink = readOptionalObject(runDir, "sink.json");
  return {
    ok: manifest.ok,
    command: "trial inspect",
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    runDir,
    mode: manifest.mode,
    status: manifest.status,
    counts: manifest.counts ?? {
      proposals: proposals.length,
      rejected: readArrayCount(runDir, "rejected.json"),
    },
    actionDistribution: countByStringField(proposals, "action"),
    lifecycleDistribution: countByStringField(proposals, "lifecycle"),
    steps: stepPresence(runDir),
    artifacts: manifest.artifacts,
    ...(sink ? { sink } : {}),
    ...(status?.error && typeof status.error === "object" ? { error: status.error as Record<string, unknown> } : {}),
    manifest,
  };
}
