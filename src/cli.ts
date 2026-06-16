#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  probeMemoryStoreAdapter,
  validateMemoryStoreAdapter,
  type MemoryStoreAdapter,
} from "./core/adapter.ts";
import {
  asRefineryError,
  RefineryError,
  serializeRefineryError,
} from "./core/errors.ts";
import { inspectReviewRun } from "./core/artifacts.ts";
import { initializeRefineryInstance, resolveRefineryPaths } from "./core/instance.ts";
import { parseReviewIntent } from "./core/intents.ts";
import { runLiveReview } from "./core/live-review.ts";
import { validateRefineryModuleDescriptor } from "./core/modules.ts";
import { runReview, type ReviewSinkOptions } from "./core/review.ts";
import type { ModelCaller } from "./core/specialists/types.ts";
import { createCodexMemoryAdapter } from "./adapters/codex-memory.ts";
import { runCoralReview } from "./coral/review-conductor.ts";

const HELP = `refinery — agent-callable memory review CLI

USAGE
  refinery instance init [--home <dir>] [--from <dir>] [--reset] [--json]
  refinery adapter check --adapter <path|reference-sqlite|codex-memory> [--memory-home <dir>] [--probe] [--scope <scope>] [--json]
  refinery review [--project <dir>] [--source codex-memory] [--target codex-memory] [--memory-home <dir>] [--intent <intent>] [--request <text>] [--home <dir>] [--run-id <id>] [--output-dir <dir>] [--sink-url <url>] [--sink-timeout-ms <ms>] [--json]
  refinery trial inspect --run-dir <dir> [--json]
  refinery module check --descriptor <path> [--json]

The CLI is dry-run by default. Review emits proposal artifacts and does not write durable memory.
Review runs Coral-coordinated specialists by default. Advanced Coral attachment may pass --coral-url/--coral-session-id/--coral-thread-id; local debugging may use --runtime sequential with --adapter.
Refinery instance data defaults to $PWD/.refinery unless REFINERY_HOME or --home is set.`;

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function defaultRunId(): string {
  return `review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function loadAdapter(spec: string, options: { memoryHome?: string } = {}): Promise<MemoryStoreAdapter> {
  try {
    if (spec === "codex-memory") {
      return createCodexMemoryAdapter({ memoryHome: options.memoryHome });
    }
    if (spec === "reference-sqlite") {
      const mod = await import("../examples/reference-sqlite/adapter.ts");
      return mod.adapter as MemoryStoreAdapter;
    }

    const resolved = path.resolve(spec);
    const mod = await import(pathToFileURL(resolved).href);
    return (mod.adapter ?? mod.default) as MemoryStoreAdapter;
  } catch (error) {
    throw new RefineryError(
      "ADAPTER_LOAD_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "adapter" },
    );
  }
}

async function loadSink(spec: string): Promise<ReviewSinkOptions> {
  const resolved = path.resolve(spec);
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
  } catch (error) {
    throw new RefineryError(
      "SINK_LOAD_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "sink" },
    );
  }
  const sink = mod.sink ?? mod.default;
  if (!sink || typeof sink !== "object" || typeof sink.url !== "string") {
    throw new RefineryError(
      "SINK_LOAD_FAILED",
      "sink module must export { sink: { url, headers? } } or default { url, headers? }",
      { phase: "sink" },
    );
  }
  return sink as ReviewSinkOptions;
}

async function loadModelCaller(spec: string): Promise<ModelCaller> {
  const resolved = path.resolve(spec);
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
  } catch (error) {
    throw new RefineryError(
      "MODEL_CALLER_LOAD_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "model-caller" },
    );
  }
  const caller = mod.callModel ?? mod.default;
  if (typeof caller !== "function") {
    throw new RefineryError(
      "MODEL_CALLER_LOAD_FAILED",
      "model caller module must export callModel(args) or a default function",
      { phase: "model-caller" },
    );
  }
  return caller as ModelCaller;
}

async function loadSourceAdapter(args: {
  source: string;
  home?: string;
  memoryHome?: string;
  project: string;
}): Promise<MemoryStoreAdapter> {
  if (args.source === "codex-memory") {
    return createCodexMemoryAdapter({ memoryHome: args.memoryHome });
  }
  if (args.source !== "claude-code-sessions") {
    throw new RefineryError("INVALID_OPTION", "--source must be codex-memory or claude-code-sessions", { phase: "args" });
  }
  try {
    const [adapterMod, configMod] = await Promise.all([
      import("../examples/reference-sqlite/adapter.ts"),
      import("../examples/reference-sqlite/config.ts"),
    ]);
    return adapterMod.createReferenceSqliteAdapter(
      configMod.resolvePaths({
        home: args.home,
        cwd: args.project,
      }),
    ) as MemoryStoreAdapter;
  } catch (error) {
    throw new RefineryError(
      "ADAPTER_LOAD_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "adapter" },
    );
  }
}

function parseOptionArgs(args: string[], options: Parameters<typeof parseArgs>[0]["options"]) {
  try {
    return parseArgs({
      args,
      options,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new RefineryError(
      "INVALID_OPTION",
      error instanceof Error ? error.message : String(error),
      { phase: "args" },
    );
  }
}

function parsePositiveIntegerOption(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new RefineryError("INVALID_OPTION", `${label} must be a positive integer.`, { phase: "args" });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RefineryError("INVALID_OPTION", `${label} must be a positive integer.`, { phase: "args" });
  }
  return parsed;
}

function validateRunId(runId: string): string {
  if (
    !runId ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
  ) {
    throw new RefineryError(
      "INVALID_OPTION",
      "--run-id must be path-safe: non-empty, no slashes, no dot-dot, and only alphanumerics, dot, underscore, or dash.",
      { phase: "args", runId },
    );
  }
  return runId;
}

function ensureRunDirInside(outputDir: string, runId: string): void {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedRun = path.resolve(resolvedOutput, runId);
  const relative = path.relative(resolvedOutput, resolvedRun);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RefineryError("INVALID_OPTION", "--run-id must not escape the output directory.", {
      phase: "args",
      runId,
      runDir: resolvedRun,
    });
  }
}

function inferCommand(argv: string[]): string {
  if (argv[0] === "adapter" && argv[1] === "check") return "adapter check";
  if (argv[0] === "instance" && argv[1] === "init") return "instance init";
  if (argv[0] === "trial" && argv[1] === "inspect") return "trial inspect";
  if (argv[0] === "module" && argv[1] === "check") return "module check";
  return argv[0] ?? "unknown";
}

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function writeJsonFailure(argv: string[], error: unknown): void {
  const refined = asRefineryError(error, { code: "CLI_ERROR", phase: "cli" });
  const output = {
    ok: false,
    command: inferCommand(argv),
    error: serializeRefineryError(refined),
    ...(refined.runId ? { runId: refined.runId } : {}),
    ...(refined.runDir ? { runDir: refined.runDir } : {}),
  };
  process.stdout.write(stableJson(output));
}

async function cmdAdapter(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "check") throw new Error("Unknown adapter command. Use: refinery adapter check");
  const values = parseOptionArgs(rest.slice(1), {
    adapter: { type: "string" },
    "memory-home": { type: "string" },
    probe: { type: "boolean", default: false },
    scope: { type: "string", default: "project" },
    json: { type: "boolean", default: false },
  });
  if (!values.adapter || typeof values.adapter !== "string") {
    throw new Error("adapter check requires --adapter <path|reference-sqlite>");
  }
  const adapter = await loadAdapter(values.adapter, {
    memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
  });
  const validation = validateMemoryStoreAdapter(adapter);
  const output = {
    ok: validation.valid,
    command: "adapter check",
    adapter: { name: validation.name },
    valid: validation.valid,
    capabilities: validation.capabilities,
    errors: validation.errors,
    probed: false,
    probeErrors: [] as string[],
  };
  if (!validation.valid) {
    process.stdout.write(
      stableJson({
        ...output,
        error: {
          code: "ADAPTER_INVALID",
          message: validation.errors.join("; "),
          phase: "adapter",
        },
      }),
    );
    return 1;
  }

  if (values.probe) {
    const probe = await probeMemoryStoreAdapter(adapter, {
      scope: String(values.scope ?? "project"),
      limit: 3,
    });
    const probedOutput = {
      ...output,
      ok: probe.valid,
      probed: true,
      sourceCount: probe.sourceCount,
      activeMemoryCount: probe.activeMemoryCount,
      probeErrors: probe.errors,
    };
    if (!probe.valid) {
      process.stdout.write(
        stableJson({
          ...probedOutput,
          error: {
            code: "ADAPTER_PROBE_FAILED",
            message: probe.errors.join("; "),
            phase: "adapter",
            details: probe.errors,
          },
        }),
      );
      return 1;
    }
    process.stdout.write(stableJson(probedOutput));
    return 0;
  }

  process.stdout.write(stableJson(output));
  return 0;
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
  process.stdout.write(stableJson({ ok: true, ...result }));
  return 0;
}

async function cmdTrial(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "inspect") throw new Error("Unknown trial command. Use: refinery trial inspect");
  const values = parseOptionArgs(rest.slice(1), {
    "run-dir": { type: "string" },
    json: { type: "boolean", default: false },
  });
  if (!values["run-dir"] || typeof values["run-dir"] !== "string") {
    throw new RefineryError("INVALID_OPTION", "trial inspect requires --run-dir <dir>", { phase: "args" });
  }
  const result = inspectReviewRun(values["run-dir"]);
  process.stdout.write(stableJson(result));
  return 0;
}

async function cmdModule(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "check") throw new Error("Unknown module command. Use: refinery module check");
  const values = parseOptionArgs(rest.slice(1), {
    descriptor: { type: "string" },
    json: { type: "boolean", default: false },
  });
  if (!values.descriptor || typeof values.descriptor !== "string") {
    throw new RefineryError("INVALID_OPTION", "module check requires --descriptor <path>", { phase: "args" });
  }
  const descriptorPath = path.resolve(values.descriptor);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  } catch (error) {
    throw new RefineryError(
      "MODULE_DESCRIPTOR_LOAD_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "module", details: { descriptorPath } },
    );
  }
  const validation = validateRefineryModuleDescriptor(parsed);
  const output = {
    ok: validation.valid,
    command: "module check",
    descriptorPath,
    valid: validation.valid,
    descriptor: validation.descriptor,
    errors: validation.errors,
  };
  if (!validation.valid) {
    process.stdout.write(stableJson({
      ...output,
      error: {
        code: "MODULE_DESCRIPTOR_INVALID",
        message: validation.errors.join("; "),
        phase: "module",
        details: validation.errors,
      },
    }));
    return 1;
  }
  process.stdout.write(stableJson(output));
  return 0;
}

async function cmdReview(rest: string[]): Promise<number> {
  const values = parseOptionArgs(rest, {
    adapter: { type: "string" },
    project: { type: "string" },
    source: { type: "string" },
    target: { type: "string" },
    intent: { type: "string" },
    request: { type: "string" },
    runtime: { type: "string" },
    scope: { type: "string", default: "project" },
    mode: { type: "string", default: "deterministic" },
    home: { type: "string" },
    "memory-home": { type: "string" },
    "run-id": { type: "string" },
    "output-dir": { type: "string" },
    sink: { type: "string" },
    "sink-url": { type: "string" },
    "sink-timeout-ms": { type: "string" },
    "model-caller": { type: "string" },
    "source-limit": { type: "string" },
    "source-char-limit": { type: "string" },
    "coral-url": { type: "string" },
    "coral-auth-key": { type: "string" },
    "coral-config": { type: "string" },
    "coral-namespace": { type: "string" },
    "coral-session-id": { type: "string" },
    "coral-thread-id": { type: "string" },
    "coral-package": { type: "string" },
    "coral-timeout-ms": { type: "string" },
    "coral-no-start": { type: "boolean", default: false },
    "coral-no-teardown": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  });
  const runtime = typeof values.runtime === "string" ? values.runtime : "coral";
  if (runtime !== "coral" && runtime !== "sequential") {
    throw new RefineryError("INVALID_OPTION", "review --runtime must be coral or sequential", { phase: "args" });
  }
  const runId = validateRunId(typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId());
  const intent = parseReviewIntent(values.intent);
  const request = typeof values.request === "string" && values.request.trim() ? values.request.trim() : null;
  const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
  const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
  const sinkTimeoutMs = parsePositiveIntegerOption(values["sink-timeout-ms"], "--sink-timeout-ms");
  const coralTimeoutMs = parsePositiveIntegerOption(values["coral-timeout-ms"], "--coral-timeout-ms");

  const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());

  const instancePaths = resolveRefineryPaths({
    home: typeof values.home === "string" ? values.home : undefined,
    cwd: project,
  });
  const outputDir =
    typeof values["output-dir"] === "string" ? path.resolve(values["output-dir"]) : instancePaths.trialsDir;
  ensureRunDirInside(outputDir, runId);

  const loadedSink =
    typeof values.sink === "string"
      ? await loadSink(values.sink)
      : typeof values["sink-url"] === "string"
      ? { url: values["sink-url"] }
      : undefined;
  const sink = loadedSink && sinkTimeoutMs ? { ...loadedSink, timeoutMs: sinkTimeoutMs } : loadedSink;

  if (runtime === "coral") {
    if (typeof values.adapter === "string") {
      throw new RefineryError(
        "INVALID_OPTION",
        "review --adapter is only available with --runtime sequential for local debugging.",
        { phase: "args" },
      );
    }
    const source = typeof values.source === "string" ? values.source : "codex-memory";
    const target = typeof values.target === "string" ? values.target : "codex-memory";
    if (target !== "codex-memory") {
      throw new RefineryError("INVALID_OPTION", "--target must be codex-memory", { phase: "args" });
    }
    if (typeof values["coral-thread-id"] === "string" && typeof values["coral-session-id"] !== "string") {
      throw new RefineryError("INVALID_OPTION", "--coral-thread-id requires --coral-session-id", { phase: "args" });
    }
    const adapter = await loadSourceAdapter({
      source,
      home: typeof values.home === "string" ? values.home : undefined,
      memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
      project,
    });
    const validation = validateMemoryStoreAdapter(adapter);
    if (!validation.valid) {
      throw new RefineryError(
        "ADAPTER_INVALID",
        validation.errors.join("; "),
        { phase: "adapter", details: validation.errors },
      );
    }
    const result = await runCoralReview({
      adapter,
      project,
      source,
      target: "codex-memory",
      scope: String(values.scope ?? "project"),
      runId,
      outputDir,
      intent,
      request,
      sink,
      sourceLimit,
      sourceCharLimit,
      coral: {
        apiUrl: typeof values["coral-url"] === "string" ? values["coral-url"] : undefined,
        authKey: typeof values["coral-auth-key"] === "string" ? values["coral-auth-key"] : undefined,
        configPath: typeof values["coral-config"] === "string" ? values["coral-config"] : undefined,
        namespace: typeof values["coral-namespace"] === "string" ? values["coral-namespace"] : undefined,
        sessionId: typeof values["coral-session-id"] === "string" ? values["coral-session-id"] : undefined,
        threadId: typeof values["coral-thread-id"] === "string" ? values["coral-thread-id"] : undefined,
        coralPackage: typeof values["coral-package"] === "string" ? values["coral-package"] : undefined,
        timeoutMs: coralTimeoutMs,
        startServer: typeof values["coral-url"] === "string" ? false : !values["coral-no-start"],
        noTeardown: Boolean(values["coral-no-teardown"]),
      },
    });
    process.stdout.write(stableJson(result));
    return 0;
  }

  if (!values.adapter || typeof values.adapter !== "string") {
    throw new RefineryError("INVALID_OPTION", "review --runtime sequential requires --adapter <path|reference-sqlite>", { phase: "args" });
  }
  const mode = String(values.mode ?? "deterministic");
  if (mode !== "deterministic" && mode !== "live") {
    throw new RefineryError("INVALID_OPTION", "review --mode must be deterministic or live", { phase: "args" });
  }
  const adapter = await loadAdapter(values.adapter, {
    memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
  });
  const validation = validateMemoryStoreAdapter(adapter);
  if (!validation.valid) {
    throw new RefineryError(
      "ADAPTER_INVALID",
      validation.errors.join("; "),
      { phase: "adapter", details: validation.errors },
    );
  }

  if (mode === "live") {
    const result = await runLiveReview({
      adapter,
      scope: String(values.scope ?? "project"),
      runId,
      outputDir,
      intent,
      request,
      sink,
      callModel: typeof values["model-caller"] === "string" ? await loadModelCaller(values["model-caller"]) : undefined,
      sourceLimit,
      sourceCharLimit,
    });
    process.stdout.write(stableJson(result));
    return 0;
  }

  const result = await runReview({
    adapter,
    scope: String(values.scope ?? "project"),
    runId,
    outputDir,
    intent,
    request,
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
  if (command === "trial") return cmdTrial(argv.slice(1));
  if (command === "module") return cmdModule(argv.slice(1));
  if (command === "review") return cmdReview(argv.slice(1));
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (wantsJson(argv)) {
        writeJsonFailure(argv, error);
      } else {
        process.stderr.write(`${(error as Error).message}\n`);
      }
      process.exitCode = 1;
    },
  );
}
