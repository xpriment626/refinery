#!/usr/bin/env node
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeMemoryStoreAdapter, refineryReviewSchemaVersion, validateMemoryStoreAdapter, } from "./core/adapter.js";
import { asRefineryError, RefineryError, serializeRefineryError, } from "./core/errors.js";
import { inspectReviewRun } from "./core/artifacts.js";
import { resolveRefineryPaths } from "./core/paths.js";
import { parseReviewIntent } from "./core/intents.js";
import {} from "./core/review.js";
import { createCodexMemoryAdapter, resolveCodexMemoryHome } from "./adapters/codex-memory.js";
import { runCoralReview, startCoralConsoleRun } from "./coral/review-conductor.js";
import { parseReviewTopology } from "./coral/topology.js";
const HELP = `refinery — Codex-first memory review CLI

USAGE
  refinery doctor [--memory-home <dir>] [--json]
  refinery version [--json]
  refinery review [--project <dir>] [--memory-home <dir>] [--intent <intent>] [--request <text>] [--home <dir>] [--run-id <id>] [--output-dir <dir>] [--sink-url <url>] [--sink-timeout-ms <ms>] [--json]
  refinery console run [--project <dir>] [--memory-home <dir>] [--intent <intent>] [--request <text>] [--run-id <id>] [--coral-url <url>] [--json]
  refinery dev fixture memory-proposal [--json]
  refinery trial inspect --run-dir <dir> [--json]

Refinery reads bounded Codex memory files, runs a dry-run Coral-coordinated review, and emits proposal artifacts.
It does not approve, apply, or write durable memory. Runtime state defaults to ~/.refinery/runs/by-project/<project-key>.
Use console run for local Coral Console trials that seed a live session without writing run artifacts.`;
function stableJson(value) {
    return JSON.stringify(value, null, 2) + "\n";
}
function defaultRunId(prefix = "review") {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
async function loadSink(spec) {
    const resolved = path.resolve(spec);
    let mod;
    try {
        mod = await import(__rewriteRelativeImportExtension(pathToFileURL(resolved).href));
    }
    catch (error) {
        throw new RefineryError("SINK_LOAD_FAILED", error instanceof Error ? error.message : String(error), { phase: "sink" });
    }
    const sink = mod.sink ?? mod.default;
    if (!sink || typeof sink !== "object" || !("url" in sink) || typeof sink.url !== "string") {
        throw new RefineryError("SINK_LOAD_FAILED", "sink module must export { sink: { url, headers? } } or default { url, headers? }", { phase: "sink" });
    }
    return sink;
}
function parseOptionArgs(args, options) {
    try {
        return parseArgs({
            args,
            options,
            allowPositionals: false,
        }).values;
    }
    catch (error) {
        throw new RefineryError("INVALID_OPTION", error instanceof Error ? error.message : String(error), { phase: "args" });
    }
}
function parsePositiveIntegerOption(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a positive integer.`, { phase: "args" });
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a positive integer.`, { phase: "args" });
    }
    return parsed;
}
function validateRunId(runId) {
    if (!runId ||
        runId.includes("/") ||
        runId.includes("\\") ||
        runId.includes("..") ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
        throw new RefineryError("INVALID_OPTION", "--run-id must be path-safe: non-empty, no slashes, no dot-dot, and only alphanumerics, dot, underscore, or dash.", { phase: "args", runId });
    }
    return runId;
}
function ensureRunDirInside(outputDir, runId) {
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
function inferCommand(argv) {
    if (argv[0] === "trial" && argv[1] === "inspect")
        return "trial inspect";
    if (argv[0] === "console" && argv[1] === "run")
        return "console run";
    if (argv[0] === "dev" && argv[1] === "fixture")
        return "dev fixture";
    return argv[0] ?? "unknown";
}
function wantsJson(argv) {
    return argv.includes("--json");
}
function writeJsonFailure(argv, error) {
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
function isMainModule() {
    if (!process.argv[1])
        return false;
    try {
        return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
    }
    catch {
        return import.meta.url === pathToFileURL(process.argv[1]).href;
    }
}
async function cmdDoctor(rest) {
    const values = parseOptionArgs(rest, {
        "memory-home": { type: "string" },
        json: { type: "boolean", default: false },
    });
    const memoryHome = resolveCodexMemoryHome(typeof values["memory-home"] === "string" ? values["memory-home"] : undefined);
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
function packageMetadata() {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return {
        name: parsed.name ?? "refinery",
        version: parsed.version ?? "0.0.0",
    };
}
async function cmdVersion(rest) {
    parseOptionArgs(rest, {
        json: { type: "boolean", default: false },
    });
    process.stdout.write(stableJson({
        ok: true,
        command: "version",
        ...packageMetadata(),
    }));
    return 0;
}
async function cmdTrial(rest) {
    const sub = rest[0];
    if (sub !== "inspect")
        throw new RefineryError("INVALID_OPTION", "Unknown trial command. Use: refinery trial inspect", { phase: "args" });
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
function memoryProposalFixture() {
    const runId = "fixture-memory-proposal";
    const proposal = {
        schemaVersion: refineryReviewSchemaVersion,
        id: `proposal:${runId}:1`,
        action: "update",
        lifecycle: "proposed",
        intent: "update-candidates",
        memoryType: "preference",
        scope: "project",
        body: "Prefer live Refinery review for memory-update proposals; use fixture mode only when the user explicitly asks for mock, fixture, deterministic, or no-Coral behavior.",
        confidence: 0.91,
        rationale: "This preserves the production path as the default while giving local sessions a deterministic way to rehearse skill and CLI behavior.",
        sourceRefs: [
            {
                source_id: "skill:$refinery",
                source_path: "$refinery",
                kind: "companion-skill",
            },
        ],
        targetMemoryId: null,
        updateReason: "Clarifies the expected agent workflow for Refinery memory review usage tests.",
    };
    return {
        ok: true,
        schemaVersion: refineryReviewSchemaVersion,
        command: "review",
        mode: "fixture",
        fixture: "memory-proposal",
        adapter: { name: "fixture" },
        scope: "project",
        dryRun: true,
        writesAttempted: false,
        runId,
        runDir: null,
        counts: {
            sources: 1,
            activeMemories: 1,
            proposals: 1,
            rejected: 0,
        },
        proposals: [proposal],
        rejected: [],
        evidenceReview: {
            findings: [
                {
                    relation: "refinement",
                    rationale: "Fixture output is intentionally review-shaped but does not inspect real memory.",
                    confidence: 0.94,
                },
            ],
        },
        metadata: {
            schemaVersion: refineryReviewSchemaVersion,
            runId,
            adapter: "fixture",
            scope: "project",
            dryRun: true,
            mode: "fixture",
            createdAt: "fixture",
            writesAttempted: false,
            sinkUrl: null,
            runtime: { kind: "fixture", coral: false },
            specialistOrder: ["fixture"],
            sourceLimit: 1,
            sourceCharLimit: null,
            intent: "update-candidates",
            request: "Mock fixture memory update proposal.",
        },
    };
}
async function cmdDev(rest) {
    const sub = rest[0];
    const fixture = rest[1];
    if (sub !== "fixture" || fixture !== "memory-proposal") {
        throw new RefineryError("INVALID_OPTION", "Unknown dev command. Use: refinery dev fixture memory-proposal", { phase: "args" });
    }
    parseOptionArgs(rest.slice(2), {
        json: { type: "boolean", default: false },
    });
    process.stdout.write(stableJson(memoryProposalFixture()));
    return 0;
}
async function waitForConsoleShutdown(session) {
    const managedProcess = session.managedProcess;
    if (!managedProcess)
        return;
    await new Promise((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
            managedProcess.off("exit", exited);
        };
        const finish = () => {
            if (finished)
                return;
            finished = true;
            cleanup();
            resolve();
        };
        const fail = (error) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            reject(error);
        };
        const shutdown = () => {
            session.close().then(finish, fail);
        };
        const exited = () => {
            finish();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        managedProcess.once("exit", exited);
    });
}
async function cmdConsole(rest) {
    const sub = rest[0];
    if (sub !== "run") {
        throw new RefineryError("INVALID_OPTION", "Unknown console command. Use: refinery console run", { phase: "args" });
    }
    const values = parseOptionArgs(rest.slice(1), {
        project: { type: "string" },
        intent: { type: "string" },
        request: { type: "string" },
        scope: { type: "string", default: "project" },
        "memory-home": { type: "string" },
        "run-id": { type: "string" },
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
        "exit-after-seed": { type: "boolean", default: false },
        topology: { type: "string", default: "debate-critique" },
        json: { type: "boolean", default: false },
    });
    const runId = validateRunId(typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId("console"));
    const intent = parseReviewIntent(values.intent);
    const request = typeof values.request === "string" && values.request.trim() ? values.request.trim() : null;
    const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
    const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
    const coralTimeoutMs = parsePositiveIntegerOption(values["coral-timeout-ms"], "--coral-timeout-ms");
    const topology = parseReviewTopology(values.topology);
    if (typeof values["coral-thread-id"] === "string" && typeof values["coral-session-id"] !== "string") {
        throw new RefineryError("INVALID_OPTION", "--coral-thread-id requires --coral-session-id", { phase: "args" });
    }
    const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());
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
    const session = await startCoralConsoleRun({
        adapter,
        project,
        source: "codex-memory",
        target: "codex-memory",
        scope: String(values.scope ?? "project"),
        runId,
        intent,
        request,
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
            topology,
            startServer: typeof values["coral-url"] === "string" ? false : !values["coral-no-start"],
            noTeardown: Boolean(values["coral-no-teardown"]),
        },
    });
    process.stdout.write(stableJson(session.result));
    if (Boolean(values["exit-after-seed"])) {
        await session.close();
        return 0;
    }
    if (session.managedServerStarted)
        await waitForConsoleShutdown(session);
    return 0;
}
async function cmdReview(rest) {
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
        topology: { type: "string" },
        json: { type: "boolean", default: false },
    });
    const runId = validateRunId(typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId());
    const intent = parseReviewIntent(values.intent);
    const request = typeof values.request === "string" && values.request.trim() ? values.request.trim() : null;
    const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
    const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
    const sinkTimeoutMs = parsePositiveIntegerOption(values["sink-timeout-ms"], "--sink-timeout-ms");
    const coralTimeoutMs = parsePositiveIntegerOption(values["coral-timeout-ms"], "--coral-timeout-ms");
    const topology = parseReviewTopology(values.topology);
    const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());
    const paths = resolveRefineryPaths({
        home: typeof values.home === "string" ? values.home : undefined,
        cwd: project,
    });
    const outputDir = typeof values["output-dir"] === "string" ? path.resolve(values["output-dir"]) : paths.runsDir;
    ensureRunDirInside(outputDir, runId);
    const loadedSink = typeof values.sink === "string"
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
            topology,
            startServer: typeof values["coral-url"] === "string" ? false : !values["coral-no-start"],
            noTeardown: Boolean(values["coral-no-teardown"]),
        },
    });
    process.stdout.write(stableJson(result));
    return 0;
}
export async function main(argv = process.argv.slice(2)) {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") {
        process.stdout.write(HELP + "\n");
        return 0;
    }
    if (command === "doctor")
        return cmdDoctor(argv.slice(1));
    if (command === "version")
        return cmdVersion(argv.slice(1));
    if (command === "trial")
        return cmdTrial(argv.slice(1));
    if (command === "console")
        return cmdConsole(argv.slice(1));
    if (command === "dev")
        return cmdDev(argv.slice(1));
    if (command === "review")
        return cmdReview(argv.slice(1));
    throw new RefineryError("INVALID_OPTION", `Unknown command: ${command}`, { phase: "args" });
}
if (isMainModule()) {
    const argv = process.argv.slice(2);
    main(argv).then((code) => {
        process.exitCode = code;
    }, (error) => {
        if (wantsJson(argv)) {
            writeJsonFailure(argv, error);
        }
        else {
            process.stderr.write(`${error.message}\n`);
        }
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map