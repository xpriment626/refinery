#!/usr/bin/env node
import { resolvePaths } from "../config.ts";
import { schemaSpecialist } from "../specialists/schema.ts";
import type { ExperimentPaths } from "./capture.ts";
import type { DistillationOutput } from "./distillation.ts";
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

type MutationOp = "create" | "update" | "supersede" | "archive" | "merge";

export interface TypedCandidate {
  body: string;
  memory_type: string;
  proposed_scope: string;
  mutation_op: MutationOp;
  target_memory_id: number | null;
  source_refs: unknown[];
}

export interface SchemaOutput {
  typed: TypedCandidate[];
}

const fixtureDistillation: DistillationOutput = {
  distilled: [
    {
      body:
        "Memory refinement should run over source session history first; existing memories are weak ground-truth comparisons.",
      source_refs: [{ source_id: 1, session_id: "fixture", chunk_index: 0 }],
      rationale: "Captures the testing boundary for future specialist runs.",
    },
  ],
};

function loadDistillationSeed(paths: ExperimentPaths): DistillationOutput {
  return latestParsed<DistillationOutput>(paths, "distillation") ?? fixtureDistillation;
}

function prompt(distillation: DistillationOutput): { system: string; user: string } {
  return {
    system: [
      schemaSpecialist.prompt,
      "",
      "Return only JSON matching this shape:",
      `{"typed":[{"body":"...","memory_type":"procedural","proposed_scope":"project","mutation_op":"create","target_memory_id":null,"source_refs":[]}]}`,
      "For this smoke test, return exactly one typed candidate. Use project scope for Stage A.",
      "Do not create proposals. Do not activate memory.",
    ].join("\n"),
    user: [
      "Assign memory type, scope, and mutation operation for this distilled memory.",
      "",
      JSON.stringify(distillation, null, 2),
    ].join("\n"),
  };
}

export function parseSchemaOutput(raw: string): SchemaOutput {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { typed?: unknown }).typed)) {
    throw new Error("Schema output must contain typed array.");
  }
  return {
    typed: (parsed as { typed: unknown[] }).typed.map((item, i) => {
      if (!item || typeof item !== "object") throw new Error(`Typed item ${i} must be an object.`);
      const t = item as Partial<TypedCandidate>;
      if (typeof t.body !== "string" || !t.body.trim()) throw new Error(`Typed item ${i} missing body.`);
      if (typeof t.memory_type !== "string" || !t.memory_type.trim()) throw new Error(`Typed item ${i} missing memory_type.`);
      if (typeof t.proposed_scope !== "string" || !t.proposed_scope.trim()) {
        throw new Error(`Typed item ${i} missing proposed_scope.`);
      }
      if (!["create", "update", "supersede", "archive", "merge"].includes(String(t.mutation_op))) {
        throw new Error(`Typed item ${i} has invalid mutation_op.`);
      }
      if (t.target_memory_id !== null && typeof t.target_memory_id !== "number") {
        throw new Error(`Typed item ${i} target_memory_id must be number or null.`);
      }
      if (!Array.isArray(t.source_refs)) throw new Error(`Typed item ${i} missing source_refs array.`);
      return {
        body: t.body,
        memory_type: t.memory_type,
        proposed_scope: t.proposed_scope,
        mutation_op: t.mutation_op as MutationOp,
        target_memory_id: t.target_memory_id,
        source_refs: t.source_refs,
      };
    }),
  };
}

function evalMarkdown(parsed: SchemaOutput): string {
  return [
    "# Schema Experiment Eval",
    "",
    `- Typed candidate count: ${parsed.typed.length}`,
    `- Project-scoped candidates: ${parsed.typed.filter((t) => t.proposed_scope === "project").length}`,
    `- Valid mutation ops: ${parsed.typed.filter((t) => ["create", "update", "supersede", "archive", "merge"].includes(t.mutation_op)).length}`,
    "- Role boundary: schema-only output; no proposal creation or activation attempted.",
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runSchemaExperiment(
  paths: ExperimentPaths,
  options: BaseExperimentOptions = {},
): Promise<ArtifactRunResult<SchemaOutput>> {
  const distillation = loadDistillationSeed(paths);
  const builtPrompt = prompt(distillation);
  return runArtifactExperiment({
    paths,
    runId: options.runId ?? defaultRunId("schema"),
    specialist: schemaSpecialist,
    model: options.model ?? loadDefaultModel(),
    prompt: builtPrompt,
    inputPayload: { distillation_seed: distillation },
    parse: parseSchemaOutput,
    evalMarkdown,
    callModel: options.callModel,
  });
}

export async function runSchemaExperimentFromCli(): Promise<void> {
  const result = await runSchemaExperiment(resolvePaths());
  printCliResult("Schema", result, result.parsed.typed.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSchemaExperimentFromCli().catch((e) => {
    process.stderr.write(`Schema experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
