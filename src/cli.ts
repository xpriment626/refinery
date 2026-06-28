#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  probeMemoryStoreAdapter,
  validateMemoryStoreAdapter,
} from "./core/adapter.ts";
import {
  asRefineryError,
  RefineryError,
  serializeRefineryError,
} from "./core/errors.ts";
import { inspectReviewRun } from "./core/artifacts.ts";
import { resolveRefineryPaths } from "./core/paths.ts";
import { parseReviewIntent } from "./core/intents.ts";
import { type ReviewSinkOptions } from "./core/review.ts";
import { createCodexMemoryAdapter, resolveCodexMemoryHome } from "./adapters/codex-memory.ts";
import { runCoralReview } from "./coral/review-conductor.ts";

const HELP = `refinery — Codex-first memory review CLI

USAGE
  refinery doctor [--memory-home <dir>] [--json]
  refinery review [--project <dir>] [--memory-home <dir>] [--intent <intent>] [--request <text>] [--home <dir>] [--run-id <id>] [--output-dir <dir>] [--sink-url <url>] [--sink-timeout-ms <ms>] [--json]
  refinery trial inspect --run-dir <dir> [--json]

Refinery reads bounded Codex memory files, runs a dry-run Coral-coordinated review, and emits proposal artifacts.
It does not approve, apply, or write durable memory. Local runtime state is limited to $PWD/.refinery/trials unless REFINERY_HOME or --home is set.`;

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function defaultRunId(): string {
  return `review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
  if (argv[0] === "trial" && argv[1] === "inspect") return "trial inspect";
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

async function cmdDoctor(rest: string[]): Promise<number> {
  const values = parseOptionArgs(rest, {
    "memory-home": { type: "string" },
    json: { type: "boolean", default: false },
  });
  const memoryHome = resolveCodexMemoryHome(
    typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
  );
  const adapter = createCodexMemoryAdapter({ memoryHome });
  const validation = validateMemoryStoreAdapter(adapter);
  if (!validation.valid) {
    process.stdout.write(stableJson({
      ok: false,
      command: "doctor",
      memoryHome,
      memoryHomeSafe: path.basename(memoryHome) === "memories",
      memoryHomeExists: false,
      authRequired: false,
      error: {
        code: "ADAPTER_INVALID",
        message: validation.errors.join("; "),
        phase: "adapter",
        details: validation.errors,
      },
    }));
    return 1;
  }
  const probe = await probeMemoryStoreAdapter(adapter, { scope: "project", limit: 3 });
  const output = {
    ok: probe.valid,
    command: "doctor",
    memoryHome,
    memoryHomeSafe: path.basename(memoryHome) === "memories",
    memoryHomeExists: true,
    authRequired: false,
    adapter: { name: adapter.name },
    sourceCount: probe.sourceCount,
    activeMemoryCount: probe.activeMemoryCount,
    errors: probe.errors,
  };
  if (!probe.valid) {
    process.stdout.write(stableJson({
      ...output,
      error: {
        code: "DOCTOR_FAILED",
        message: probe.errors.join("; "),
        phase: "doctor",
        details: probe.errors,
      },
    }));
    return 1;
  }
  process.stdout.write(stableJson(output));
  return 0;
}

async function cmdTrial(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "inspect") throw new RefineryError("INVALID_OPTION", "Unknown trial command. Use: refinery trial inspect", { phase: "args" });
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

async function cmdReview(rest: string[]): Promise<number> {
  const values = parseOptionArgs(rest, {
    project: { type: "string" },
    intent: { type: "string" },
    request: { type: "string" },
    scope: { type: "string", default: "project" },
    home: { type: "string" },
    "memory-home": { type: "string" },
    "run-id": { type: "string" },
    "output-dir": { type: "string" },
    sink: { type: "string" },
    "sink-url": { type: "string" },
    "sink-timeout-ms": { type: "string" },
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
  const runId = validateRunId(typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId());
  const intent = parseReviewIntent(values.intent);
  const request = typeof values.request === "string" && values.request.trim() ? values.request.trim() : null;
  const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
  const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
  const sinkTimeoutMs = parsePositiveIntegerOption(values["sink-timeout-ms"], "--sink-timeout-ms");
  const coralTimeoutMs = parsePositiveIntegerOption(values["coral-timeout-ms"], "--coral-timeout-ms");

  const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());
  const paths = resolveRefineryPaths({
    home: typeof values.home === "string" ? values.home : undefined,
    cwd: project,
  });
  const outputDir = typeof values["output-dir"] === "string" ? path.resolve(values["output-dir"]) : paths.trialsDir;
  ensureRunDirInside(outputDir, runId);

  const loadedSink =
    typeof values.sink === "string"
      ? await loadSink(values.sink)
      : typeof values["sink-url"] === "string"
      ? { url: values["sink-url"] }
      : undefined;
  const sink = loadedSink && sinkTimeoutMs ? { ...loadedSink, timeoutMs: sinkTimeoutMs } : loadedSink;

  if (typeof values["coral-thread-id"] === "string" && typeof values["coral-session-id"] !== "string") {
    throw new RefineryError("INVALID_OPTION", "--coral-thread-id requires --coral-session-id", { phase: "args" });
  }
  const adapter = createCodexMemoryAdapter({
    memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
  });
  const validation = validateMemoryStoreAdapter(adapter);
  if (!validation.valid) {
    throw new RefineryError("ADAPTER_INVALID", validation.errors.join("; "), {
      phase: "adapter",
      details: validation.errors,
    });
  }

  const result = await runCoralReview({
    adapter,
    project,
    source: "codex-memory",
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (command === "doctor") return cmdDoctor(argv.slice(1));
  if (command === "trial") return cmdTrial(argv.slice(1));
  if (command === "review") return cmdReview(argv.slice(1));
  throw new RefineryError("INVALID_OPTION", `Unknown command: ${command}`, { phase: "args" });
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
