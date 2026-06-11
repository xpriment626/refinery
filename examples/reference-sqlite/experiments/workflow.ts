#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { resolvePaths } from "../config.ts";
import type { ModelConfig } from "../../../src/env.ts";
import { createMastraModelCaller } from "../../../src/runtimes/mastra/runtime.ts";
import { captureSpecialist } from "../../../src/core/specialists/capture.ts";
import { distillationSpecialist } from "../../../src/core/specialists/distillation.ts";
import { relationshipReviewSpecialist } from "../../../src/core/specialists/relationship-review.ts";
import { relevanceSpecialist } from "../../../src/core/specialists/relevance.ts";
import { schemaSpecialist } from "../../../src/core/specialists/schema.ts";
import {
  buildCapturePrompt,
  parseCaptureOutput,
  selectDeterministicSessionSlice,
  type CaptureOutput,
  type ExperimentPaths,
  type ModelCaller,
  type SessionSlice,
} from "./capture.ts";
import {
  buildDistillationPrompt,
  parseDistillationOutput,
  type DistillationOutput,
} from "./distillation.ts";
import {
  buildRelationshipReviewPrompt,
  loadActiveMemoryCandidates,
  parseRelationshipReviewOutput,
  type ActiveMemoryCandidate,
  type RelationshipReviewOutput,
} from "./relationship-review.ts";
import {
  buildRelevancePrompt,
  parseRelevanceOutput,
  type RelevanceOutput,
} from "./relevance.ts";
import { buildSchemaPrompt, parseSchemaOutput, type SchemaOutput } from "./schema.ts";
import { defaultRunId, loadDefaultModel, redactModel } from "./shared.ts";

export type { ExperimentPaths } from "./capture.ts";

export interface SequentialWorkflowOutput {
  capture: CaptureOutput;
  distillation: DistillationOutput;
  schema: SchemaOutput;
  relevance: RelevanceOutput;
  relationship_review: RelationshipReviewOutput;
}

export interface SequentialWorkflowRunResult {
  runId: string;
  runDir: string;
  parsed: SequentialWorkflowOutput;
}

export interface RunSequentialWorkflowOptions {
  runId?: string;
  model?: ModelConfig;
  callModel?: ModelCaller;
  sourceId?: number;
  maxTurns?: number;
  maxChars?: number;
}

interface WorkflowContext {
  paths: ExperimentPaths;
  runDir: string;
  model: ModelConfig;
  callModel?: ModelCaller;
}

interface CaptureStepOutput {
  slice: SessionSlice;
  capture: CaptureOutput;
}

interface DistillationStepOutput extends CaptureStepOutput {
  distillation: DistillationOutput;
}

interface SchemaStepOutput extends DistillationStepOutput {
  schema: SchemaOutput;
}

interface RelevanceStepOutput extends SchemaStepOutput {
  relevance: RelevanceOutput;
}

interface RelationshipReviewStepOutput extends RelevanceStepOutput {
  active_memory_candidates: ActiveMemoryCandidate[];
  relationship_review: RelationshipReviewOutput;
}

const looseObject = z.object({}).passthrough();

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function runSpecialistStep<T>(args: {
  context: WorkflowContext;
  stepName: string;
  specialist: typeof captureSpecialist;
  prompt: { system: string; user: string };
  parse: (raw: string) => T;
  inputPayload: Record<string, unknown>;
}): Promise<T> {
  const stepDir = path.join(args.context.runDir, "steps", args.stepName);
  fs.mkdirSync(stepDir, { recursive: true });
  writeJson(path.join(stepDir, "input.json"), {
    step: args.stepName,
    specialist: args.specialist,
    model: redactModel(args.context.model),
    ...args.inputPayload,
    prompt: args.prompt,
  });
  const raw = await (args.context.callModel ?? createMastraModelCaller(args.specialist))({
    model: args.context.model,
    system: args.prompt.system,
    user: args.prompt.user,
    specialist: args.specialist,
  });
  fs.writeFileSync(path.join(stepDir, "output.raw.md"), raw);
  const parsed = args.parse(raw);
  writeJson(path.join(stepDir, "output.parsed.json"), parsed);
  return parsed;
}

function createSequentialRefinementWorkflow(context: WorkflowContext) {
  const captureStep = createStep({
    id: "capture",
    inputSchema: z.object({ slice: z.any() }),
    outputSchema: looseObject,
    execute: async ({ inputData }) => {
      const slice = inputData.slice as SessionSlice;
      const builtPrompt = buildCapturePrompt(slice);
      const capture = await runSpecialistStep({
        context,
        stepName: "capture",
        specialist: captureSpecialist,
        prompt: builtPrompt,
        inputPayload: { source: slice.source, chunks: slice.chunks },
        parse: parseCaptureOutput,
      });
      return { slice, capture } satisfies CaptureStepOutput;
    },
  });

  const distillationStep = createStep({
    id: "distillation",
    inputSchema: looseObject,
    outputSchema: looseObject,
    execute: async ({ inputData }) => {
      const previous = inputData as CaptureStepOutput;
      const builtPrompt = buildDistillationPrompt(previous.capture);
      const distillation = await runSpecialistStep({
        context,
        stepName: "distillation",
        specialist: distillationSpecialist,
        prompt: builtPrompt,
        inputPayload: { capture_seed: previous.capture },
        parse: parseDistillationOutput,
      });
      return { ...previous, distillation } satisfies DistillationStepOutput;
    },
  });

  const schemaStep = createStep({
    id: "schema",
    inputSchema: looseObject,
    outputSchema: looseObject,
    execute: async ({ inputData }) => {
      const previous = inputData as DistillationStepOutput;
      const builtPrompt = buildSchemaPrompt(previous.distillation);
      const schema = await runSpecialistStep({
        context,
        stepName: "schema",
        specialist: schemaSpecialist,
        prompt: builtPrompt,
        inputPayload: { distillation_seed: previous.distillation },
        parse: parseSchemaOutput,
      });
      return { ...previous, schema } satisfies SchemaStepOutput;
    },
  });

  const relevanceStep = createStep({
    id: "relevance",
    inputSchema: looseObject,
    outputSchema: looseObject,
    execute: async ({ inputData }) => {
      const previous = inputData as SchemaStepOutput;
      const builtPrompt = buildRelevancePrompt(previous.schema);
      const relevance = await runSpecialistStep({
        context,
        stepName: "relevance",
        specialist: relevanceSpecialist,
        prompt: builtPrompt,
        inputPayload: { schema_seed: previous.schema },
        parse: parseRelevanceOutput,
      });
      return { ...previous, relevance } satisfies RelevanceStepOutput;
    },
  });

  const relationshipReviewStep = createStep({
    id: "relationship-review",
    inputSchema: looseObject,
    outputSchema: looseObject,
    execute: async ({ inputData }) => {
      const previous = inputData as RelevanceStepOutput;
      const activeMemoryCandidates = loadActiveMemoryCandidates(context.paths, previous.relevance);
      const builtPrompt = buildRelationshipReviewPrompt({
        relevance: previous.relevance,
        activeMemoryCandidates,
      });
      const relationshipReview = await runSpecialistStep({
        context,
        stepName: "relationship-review",
        specialist: relationshipReviewSpecialist,
        prompt: builtPrompt,
        inputPayload: {
          relevance_seed: previous.relevance,
          active_memory_candidates: activeMemoryCandidates,
        },
        parse: parseRelationshipReviewOutput,
      });
      return {
        ...previous,
        active_memory_candidates: activeMemoryCandidates,
        relationship_review: relationshipReview,
      } satisfies RelationshipReviewStepOutput;
    },
  });

  return createWorkflow({
    id: "refinery-sequential-specialists",
    inputSchema: z.object({ slice: z.any() }),
    outputSchema: looseObject,
  })
    .then(captureStep)
    .then(distillationStep)
    .then(schemaStep)
    .then(relevanceStep)
    .then(relationshipReviewStep)
    .commit();
}

function evalMarkdown(parsed: SequentialWorkflowOutput): string {
  const hasSourceRefs = parsed.relevance.proposals.filter((proposal) => proposal.source_refs.length > 0).length;
  const relationshipRelations = parsed.relationship_review.findings.map((finding) => finding.relation);
  return [
    "# Sequential Workflow Experiment Eval",
    "",
    "- Runtime: Mastra workflow with sequential specialist steps.",
    `- Capture candidates: ${parsed.capture.candidates.length}`,
    `- Distilled memories: ${parsed.distillation.distilled.length}`,
    `- Schema typed candidates: ${parsed.schema.typed.length}`,
    `- Relevance proposals: ${parsed.relevance.proposals.length}`,
    `- Relevance rejected: ${parsed.relevance.rejected.length}`,
    `- Proposals retaining source refs: ${hasSourceRefs}`,
    `- Relationship findings: ${parsed.relationship_review.findings.length}`,
    `- Relationship labels: ${relationshipRelations.join(", ") || "none"}`,
    "- Role boundary: workflow experiment only; no database writes, proposal creation, promotion, or activation attempted.",
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runSequentialWorkflowExperiment(
  paths: ExperimentPaths,
  options: RunSequentialWorkflowOptions = {},
): Promise<SequentialWorkflowRunResult> {
  const model = options.model ?? loadDefaultModel();
  const runId = options.runId ?? defaultRunId("workflow");
  const runDir = path.join(paths.home, "experiments", runId);
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  const slice = selectDeterministicSessionSlice(paths, options);
  writeJson(path.join(runDir, "input.json"), {
    run_id: runId,
    runtime: {
      framework: "mastra-workflow",
      workflowId: "refinery-sequential-specialists",
      order: ["capture", "distillation", "schema", "relevance", "relationship-review"],
    },
    model: redactModel(model),
    source: {
      id: slice.source.id,
      session_id: slice.source.session_id,
      source_path: slice.source.source_path,
    },
    chunks: slice.chunks,
  });

  const workflow = createSequentialRefinementWorkflow({
    paths,
    runDir,
    model,
    callModel: options.callModel,
  });
  const run = await workflow.createRun();
  const result = await run.start({ inputData: { slice } });
  if (result.status !== "success") {
    writeJson(path.join(runDir, "workflow.output.json"), result);
    throw new Error(`Sequential workflow failed with status ${result.status}`);
  }
  const output = result.result as RelationshipReviewStepOutput;
  const parsed: SequentialWorkflowOutput = {
    capture: output.capture,
    distillation: output.distillation,
    schema: output.schema,
    relevance: output.relevance,
    relationship_review: output.relationship_review,
  };
  writeJson(path.join(runDir, "workflow.output.json"), parsed);
  fs.writeFileSync(path.join(runDir, "eval.md"), evalMarkdown(parsed));
  return { runId, runDir, parsed };
}

export async function runSequentialWorkflowExperimentFromCli(): Promise<void> {
  const result = await runSequentialWorkflowExperiment(resolvePaths());
  console.log(`Sequential workflow experiment saved: ${path.relative(process.cwd(), result.runDir)}`);
  console.log(`Relationship findings parsed: ${result.parsed.relationship_review.findings.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSequentialWorkflowExperimentFromCli().catch((e) => {
    process.stderr.write(`Sequential workflow experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
