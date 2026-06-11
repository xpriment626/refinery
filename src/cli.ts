#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  validateMemoryStoreAdapter,
  type MemoryStoreAdapter,
} from "./core/adapter.ts";
import { initializeRefineryInstance, resolveRefineryPaths } from "./core/instance.ts";
import { runLiveReview } from "./core/live-review.ts";
import { runReview, type ReviewSinkOptions } from "./core/review.ts";
import type { ModelCaller } from "./core/specialists/types.ts";

const HELP = `refinery — agent-callable memory review CLI

USAGE
  refinery instance init [--home <dir>] [--from <dir>] [--reset] [--json]
  refinery adapter check --adapter <path|reference-sqlite> [--json]
  refinery review --adapter <path|reference-sqlite> --scope <scope> [--mode deterministic|live] [--home <dir>] [--run-id <id>] [--output-dir <dir>] [--sink-url <url>] [--json]

The CLI is dry-run by default. Review emits proposal artifacts and does not write durable memory.
Refinery instance data defaults to $PWD/.refinery unless REFINERY_HOME or --home is set.`;

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function defaultRunId(): string {
  return `review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function loadAdapter(spec: string): Promise<MemoryStoreAdapter> {
  if (spec === "reference-sqlite") {
    const mod = await import("../examples/reference-sqlite/adapter.ts");
    return mod.adapter as MemoryStoreAdapter;
  }

  const resolved = path.resolve(spec);
  const mod = await import(pathToFileURL(resolved).href);
  return (mod.adapter ?? mod.default) as MemoryStoreAdapter;
}

async function loadSink(spec: string): Promise<ReviewSinkOptions> {
  const resolved = path.resolve(spec);
  const mod = await import(pathToFileURL(resolved).href);
  const sink = mod.sink ?? mod.default;
  if (!sink || typeof sink !== "object" || typeof sink.url !== "string") {
    throw new Error("sink module must export { sink: { url, headers? } } or default { url, headers? }");
  }
  return sink as ReviewSinkOptions;
}

async function loadModelCaller(spec: string): Promise<ModelCaller> {
  const resolved = path.resolve(spec);
  const mod = await import(pathToFileURL(resolved).href);
  const caller = mod.callModel ?? mod.default;
  if (typeof caller !== "function") {
    throw new Error("model caller module must export callModel(args) or a default function");
  }
  return caller as ModelCaller;
}

function parseOptionArgs(args: string[], options: Parameters<typeof parseArgs>[0]["options"]) {
  return parseArgs({
    args,
    options,
    allowPositionals: false,
  }).values;
}

async function cmdAdapter(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "check") throw new Error("Unknown adapter command. Use: refinery adapter check");
  const values = parseOptionArgs(rest.slice(1), {
    adapter: { type: "string" },
    json: { type: "boolean", default: false },
  });
  if (!values.adapter || typeof values.adapter !== "string") {
    throw new Error("adapter check requires --adapter <path|reference-sqlite>");
  }
  const adapter = await loadAdapter(values.adapter);
  const validation = validateMemoryStoreAdapter(adapter);
  const output = {
    command: "adapter check",
    adapter: { name: validation.name },
    valid: validation.valid,
    capabilities: validation.capabilities,
    errors: validation.errors,
  };
  process.stdout.write(stableJson(output));
  return validation.valid ? 0 : 1;
}

async function cmdInstance(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "init") throw new Error("Unknown instance command. Use: refinery instance init");
  const values = parseOptionArgs(rest.slice(1), {
    home: { type: "string" },
    from: { type: "string" },
    reset: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  });

  const result = initializeRefineryInstance({
    home: typeof values.home === "string" ? values.home : undefined,
    from: typeof values.from === "string" ? values.from : undefined,
    reset: Boolean(values.reset),
  });
  process.stdout.write(stableJson(result));
  return 0;
}

async function cmdReview(rest: string[]): Promise<number> {
  const values = parseOptionArgs(rest, {
    adapter: { type: "string" },
    scope: { type: "string", default: "project" },
    mode: { type: "string", default: "deterministic" },
    home: { type: "string" },
    "run-id": { type: "string" },
    "output-dir": { type: "string" },
    sink: { type: "string" },
    "sink-url": { type: "string" },
    "model-caller": { type: "string" },
    "source-limit": { type: "string" },
    "source-char-limit": { type: "string" },
    json: { type: "boolean", default: false },
  });
  if (!values.adapter || typeof values.adapter !== "string") {
    throw new Error("review requires --adapter <path|reference-sqlite>");
  }

  const adapter = await loadAdapter(values.adapter);
  const validation = validateMemoryStoreAdapter(adapter);
  if (!validation.valid) {
    process.stdout.write(
      stableJson({
        command: "review",
        adapter: { name: validation.name },
        valid: false,
        errors: validation.errors,
      }),
    );
    return 1;
  }

  const instancePaths = resolveRefineryPaths({
    home: typeof values.home === "string" ? values.home : undefined,
  });
  const outputDir =
    typeof values["output-dir"] === "string" ? path.resolve(values["output-dir"]) : instancePaths.trialsDir;

  const sink =
    typeof values.sink === "string"
      ? await loadSink(values.sink)
      : typeof values["sink-url"] === "string"
        ? { url: values["sink-url"] }
        : undefined;
  const mode = String(values.mode ?? "deterministic");
  if (mode !== "deterministic" && mode !== "live") {
    throw new Error("review --mode must be deterministic or live");
  }

  if (mode === "live") {
    const result = await runLiveReview({
      adapter,
      scope: String(values.scope ?? "project"),
      runId: typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId(),
      outputDir,
      sink,
      callModel: typeof values["model-caller"] === "string" ? await loadModelCaller(values["model-caller"]) : undefined,
      sourceLimit: typeof values["source-limit"] === "string" ? Number(values["source-limit"]) : undefined,
      sourceCharLimit:
        typeof values["source-char-limit"] === "string" ? Number(values["source-char-limit"]) : undefined,
    });
    process.stdout.write(stableJson(result));
    return 0;
  }

  const result = await runReview({
    adapter,
    scope: String(values.scope ?? "project"),
    runId: typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId(),
    outputDir,
    sink,
  });
  process.stdout.write(stableJson(result));
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (command === "adapter") return cmdAdapter(argv.slice(1));
  if (command === "instance") return cmdInstance(argv.slice(1));
  if (command === "review") return cmdReview(argv.slice(1));
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
