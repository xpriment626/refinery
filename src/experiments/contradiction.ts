#!/usr/bin/env node
import { resolvePaths } from "../config.ts";
import { searchMemory, type SearchMemoryResult } from "../retrieval.ts";
import { contradictionSpecialist } from "../specialists/contradiction.ts";
import type { ExperimentPaths } from "./capture.ts";
import type { RelevanceOutput } from "./relevance.ts";
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

export type { ExperimentPaths } from "./capture.ts";

export type ContradictionRelation =
  | "novel"
  | "duplicate"
  | "refinement"
  | "contradiction"
  | "supersession"
  | "too_weak";

export interface MemoryRef {
  memory_id: number;
  provenance_kind: string;
}

export interface ContradictionFinding {
  body: string;
  relation: ContradictionRelation;
  target_memory_id: number | null;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  memory_refs: MemoryRef[];
}

export interface ContradictionOutput {
  findings: ContradictionFinding[];
}

interface ActiveMemoryCandidate {
  proposal_index: number;
  memories: Pick<SearchMemoryResult, "id" | "type" | "scope" | "body" | "confidence" | "provenance">[];
}

const relations = ["novel", "duplicate", "refinement", "contradiction", "supersession", "too_weak"] as const;

const fixtureRelevance: RelevanceOutput = {
  proposals: [
    {
      memory_type: "procedural",
      proposed_scope: "project",
      body:
        "Memory refinement should run over source session history; existing memories are comparison baselines.",
      confidence: 0.82,
      rationale: "Useful for future specialist testing and avoids refining only curated memories.",
      source_refs: [{ source_id: 1, session_id: "fixture", chunk_index: 0 }],
      mutation_op: "create",
      target_memory_id: null,
    },
  ],
  rejected: [],
};

function loadRelevanceSeed(paths: ExperimentPaths): RelevanceOutput {
  return latestParsed<RelevanceOutput>(paths, "relevance") ?? fixtureRelevance;
}

function loadActiveMemoryCandidates(
  paths: ExperimentPaths,
  relevance: RelevanceOutput,
): ActiveMemoryCandidate[] {
  return relevance.proposals.map((proposal, proposalIndex) => ({
    proposal_index: proposalIndex,
    memories: searchMemory(paths, { query: proposal.body, limit: 5 }).map((memory) => ({
      id: memory.id,
      type: memory.type,
      scope: memory.scope,
      body: memory.body,
      confidence: memory.confidence,
      provenance: memory.provenance,
    })),
  }));
}

function prompt(args: {
  relevance: RelevanceOutput;
  activeMemoryCandidates: ActiveMemoryCandidate[];
}): { system: string; user: string } {
  return {
    system: [
      contradictionSpecialist.prompt,
      "",
      "Return only JSON matching this shape:",
      `{"findings":[{"body":"...","relation":"novel","target_memory_id":null,"confidence":0.8,"rationale":"...","source_refs":[],"memory_refs":[{"memory_id":1,"provenance_kind":"refinery-proposal"}]}]}`,
      "Classify each proposal-shaped candidate from Relevance exactly once.",
      "Use only these relations: novel, duplicate, refinement, contradiction, supersession, too_weak.",
      "Set target_memory_id only when the relation targets one active memory; otherwise use null.",
      "memory_refs must always be an array of objects with memory_id and provenance_kind; never return bare numeric memory ids.",
      "Do not create proposals. Do not activate, promote, archive, or write memory.",
    ].join("\n"),
    user: [
      "Compare these relevance outputs against the supplied active project memory candidates.",
      "",
      JSON.stringify(args, null, 2),
    ].join("\n"),
  };
}

function isRelation(value: unknown): value is ContradictionRelation {
  return typeof value === "string" && relations.includes(value as ContradictionRelation);
}

export function parseContradictionOutput(raw: string): ContradictionOutput {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { findings?: unknown }).findings)) {
    throw new Error("Contradiction output must contain findings array.");
  }
  return {
    findings: (parsed as { findings: unknown[] }).findings.map((item, i) => {
      if (!item || typeof item !== "object") throw new Error(`Finding ${i} must be an object.`);
      const finding = item as Partial<ContradictionFinding>;
      if (typeof finding.body !== "string" || !finding.body.trim()) throw new Error(`Finding ${i} missing body.`);
      if (!isRelation(finding.relation)) throw new Error(`Finding ${i} has invalid relation.`);
      if (finding.target_memory_id !== null && typeof finding.target_memory_id !== "number") {
        throw new Error(`Finding ${i} target_memory_id must be number or null.`);
      }
      if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
        throw new Error(`Finding ${i} confidence must be 0..1.`);
      }
      if (typeof finding.rationale !== "string" || !finding.rationale.trim()) {
        throw new Error(`Finding ${i} missing rationale.`);
      }
      if (!Array.isArray(finding.source_refs)) throw new Error(`Finding ${i} missing source_refs array.`);
      if (!Array.isArray(finding.memory_refs)) throw new Error(`Finding ${i} missing memory_refs array.`);
      const memoryRefs = finding.memory_refs.map((memoryRef, refIndex) => {
        if (!memoryRef || typeof memoryRef !== "object") {
          throw new Error(`Finding ${i} memory_ref ${refIndex} must be an object.`);
        }
        const ref = memoryRef as Partial<MemoryRef>;
        if (typeof ref.memory_id !== "number") {
          throw new Error(`Finding ${i} memory_ref ${refIndex} missing memory_id.`);
        }
        if (typeof ref.provenance_kind !== "string" || !ref.provenance_kind.trim()) {
          throw new Error(`Finding ${i} memory_ref ${refIndex} missing provenance_kind.`);
        }
        return { memory_id: ref.memory_id, provenance_kind: ref.provenance_kind };
      });
      return {
        body: finding.body,
        relation: finding.relation,
        target_memory_id: finding.target_memory_id,
        confidence: finding.confidence,
        rationale: finding.rationale,
        source_refs: finding.source_refs,
        memory_refs: memoryRefs,
      };
    }),
  };
}

function evalMarkdown(parsed: ContradictionOutput): string {
  const targeted = parsed.findings.filter((finding) => finding.target_memory_id !== null).length;
  return [
    "# Contradiction Experiment Eval",
    "",
    `- Findings: ${parsed.findings.length}`,
    `- Findings targeting active memory: ${targeted}`,
    `- Relations: ${parsed.findings.map((finding) => finding.relation).join(", ") || "none"}`,
    "- Role boundary: contradiction-only output; no database writes, proposal creation, promotion, or activation attempted.",
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runContradictionExperiment(
  paths: ExperimentPaths,
  options: BaseExperimentOptions = {},
): Promise<ArtifactRunResult<ContradictionOutput>> {
  const relevance = loadRelevanceSeed(paths);
  const activeMemoryCandidates = loadActiveMemoryCandidates(paths, relevance);
  const builtPrompt = prompt({ relevance, activeMemoryCandidates });
  return runArtifactExperiment({
    paths,
    runId: options.runId ?? defaultRunId("contradiction"),
    specialist: contradictionSpecialist,
    model: options.model ?? loadDefaultModel(),
    prompt: builtPrompt,
    inputPayload: {
      relevance_seed: relevance,
      active_memory_candidates: activeMemoryCandidates,
    },
    parse: parseContradictionOutput,
    evalMarkdown,
    callModel: options.callModel,
  });
}

export async function runContradictionExperimentFromCli(): Promise<void> {
  const result = await runContradictionExperiment(resolvePaths());
  printCliResult("Contradiction", result, result.parsed.findings.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runContradictionExperimentFromCli().catch((e) => {
    process.stderr.write(`Contradiction experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
