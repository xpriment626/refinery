#!/usr/bin/env node
import { resolvePaths } from "../config.ts";
import { relevanceSpecialist } from "../specialists/relevance.ts";
import type { ExperimentPaths } from "./capture.ts";
import type { SchemaOutput } from "./schema.ts";
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

export interface RelevanceProposal {
  memory_type: string;
  proposed_scope: string;
  body: string;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  mutation_op: MutationOp;
  target_memory_id: number | null;
}

export interface RejectedCandidate {
  body?: string;
  reason: string;
}

export interface RelevanceOutput {
  proposals: RelevanceProposal[];
  rejected: RejectedCandidate[];
}

const fixtureSchema: SchemaOutput = {
  typed: [
    {
      body:
        "Memory refinement should run over source session history first; existing memories are weak ground-truth comparisons.",
      memory_type: "procedural",
      primary_type: "procedural",
      secondary_type: null,
      type_confidence: 0.88,
      type_rationale: "The candidate describes the normal refinement workflow source priority.",
      ambiguities: [],
      durability: "durable",
      ttl: null,
      proposed_scope: "project",
      mutation_op: "create",
      target_memory_id: null,
      source_refs: [{ source_id: 1, session_id: "fixture", chunk_index: 0 }],
    },
  ],
};

function loadSchemaSeed(paths: ExperimentPaths): SchemaOutput {
  return latestParsed<SchemaOutput>(paths, "schema") ?? fixtureSchema;
}

export function buildRelevancePrompt(schema: SchemaOutput): { system: string; user: string } {
  return {
    system: [
      relevanceSpecialist.prompt,
      "",
      "Return only JSON matching this shape:",
      `{"proposals":[{"memory_type":"procedural","proposed_scope":"project","body":"...","confidence":0.8,"rationale":"...","source_refs":[],"mutation_op":"create","target_memory_id":null}],"rejected":[]}`,
      "For this smoke test, return at most one proposal. Use rejected when the candidate is too ephemeral.",
      "Use the Schema primary_type/memory_type and durability metadata when deciding whether the candidate is worth proposing.",
      "Do not write to the database. Do not activate memory.",
    ].join("\n"),
    user: [
      "Score this typed candidate for future usefulness and emit proposal-shaped output or rejection.",
      "",
      JSON.stringify(schema, null, 2),
    ].join("\n"),
  };
}

export function parseRelevanceOutput(raw: string): RelevanceOutput {
  const parsed = extractJson(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { proposals?: unknown }).proposals) ||
    !Array.isArray((parsed as { rejected?: unknown }).rejected)
  ) {
    throw new Error("Relevance output must contain proposals and rejected arrays.");
  }
  const proposals = (parsed as { proposals: unknown[] }).proposals.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`Proposal ${i} must be an object.`);
    const p = item as Partial<RelevanceProposal>;
    if (typeof p.memory_type !== "string" || !p.memory_type.trim()) throw new Error(`Proposal ${i} missing memory_type.`);
    if (typeof p.proposed_scope !== "string" || !p.proposed_scope.trim()) {
      throw new Error(`Proposal ${i} missing proposed_scope.`);
    }
    if (typeof p.body !== "string" || !p.body.trim()) throw new Error(`Proposal ${i} missing body.`);
    if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
      throw new Error(`Proposal ${i} confidence must be 0..1.`);
    }
    if (typeof p.rationale !== "string" || !p.rationale.trim()) throw new Error(`Proposal ${i} missing rationale.`);
    if (!Array.isArray(p.source_refs)) throw new Error(`Proposal ${i} missing source_refs array.`);
    if (!["create", "update", "supersede", "archive", "merge"].includes(String(p.mutation_op))) {
      throw new Error(`Proposal ${i} has invalid mutation_op.`);
    }
    if (p.target_memory_id !== null && typeof p.target_memory_id !== "number") {
      throw new Error(`Proposal ${i} target_memory_id must be number or null.`);
    }
    return {
      memory_type: p.memory_type,
      proposed_scope: p.proposed_scope,
      body: p.body,
      confidence: p.confidence,
      rationale: p.rationale,
      source_refs: p.source_refs,
      mutation_op: p.mutation_op as MutationOp,
      target_memory_id: p.target_memory_id,
    };
  });
  const rejected = (parsed as { rejected: unknown[] }).rejected.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`Rejected item ${i} must be an object.`);
    const r = item as Partial<RejectedCandidate>;
    if (typeof r.reason !== "string" || !r.reason.trim()) throw new Error(`Rejected item ${i} missing reason.`);
    return {
      body: typeof r.body === "string" ? r.body : undefined,
      reason: r.reason,
    };
  });
  return { proposals, rejected };
}

function evalMarkdown(parsed: RelevanceOutput): string {
  return [
    "# Relevance Experiment Eval",
    "",
    `- Proposal-shaped outputs: ${parsed.proposals.length}`,
    `- Rejected candidates: ${parsed.rejected.length}`,
    `- Outputs with source refs: ${parsed.proposals.filter((p) => p.source_refs.length > 0).length}`,
    "- Role boundary: relevance-only output; no database writes, proposal creation, or activation attempted.",
    `- Usability: ${parsed.proposals.length > 0 ? "proposal-shaped candidate present" : "candidate rejected"}`,
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runRelevanceExperiment(
  paths: ExperimentPaths,
  options: BaseExperimentOptions = {},
): Promise<ArtifactRunResult<RelevanceOutput>> {
  const schema = loadSchemaSeed(paths);
  const builtPrompt = buildRelevancePrompt(schema);
  return runArtifactExperiment({
    paths,
    runId: options.runId ?? defaultRunId("relevance"),
    specialist: relevanceSpecialist,
    model: options.model ?? loadDefaultModel(),
    prompt: builtPrompt,
    inputPayload: { schema_seed: schema },
    parse: parseRelevanceOutput,
    evalMarkdown,
    callModel: options.callModel,
  });
}

export async function runRelevanceExperimentFromCli(): Promise<void> {
  const result = await runRelevanceExperiment(resolvePaths());
  printCliResult("Relevance", result, result.parsed.proposals.length + result.parsed.rejected.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRelevanceExperimentFromCli().catch((e) => {
    process.stderr.write(`Relevance experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
