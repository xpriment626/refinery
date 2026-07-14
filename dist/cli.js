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
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refineryReviewSchemaVersion } from "./core/types.js";
import { asRefineryError, RefineryError, serializeRefineryError, } from "./core/errors.js";
import { inspectReviewRun } from "./core/artifacts.js";
import { resolveRefineryPaths } from "./core/paths.js";
import { resolveModelApiKey, storedAuthStatus, writeStoredAuth } from "./core/credentials.js";
import { parseReviewIntent } from "./core/intents.js";
import { buildReviewPacket, inspectSources, parseSourceSpecs, parseTargetSurfaces } from "./core/packets.js";
import {} from "./core/review.js";
import { checkForUpdate, formatUpdateNotice } from "./core/update-check.js";
import { getMemoryGraphNeighbors, getMemoryGraphStatus, inspectMemoryGraphNode, planMemoryGraph, prepareGraphReviewPacket, syncCodexMemoryGraph, } from "./core/graph/service.js";
import { memoryGraphEdgeKinds } from "./core/graph/sync.js";
import { loadLocalEnv } from "./env.js";
import { resolveCodexMemoryHome } from "./sources/codex-memories.js";
import { readUiConfig, writeUiConfig } from "./gateway/config.js";
import { gatewayStatus, notifyGatewayGraphSync, startGateway, stopGateway } from "./gateway/lifecycle.js";
import { runCoralReview, startCoralConsoleRun } from "./coral/review-conductor.js";
import { parseReviewTopology } from "./coral/topology.js";
const HELP = `refinery — Codex-first memory review CLI

USAGE
  refinery init [--home <dir>] [--codex-home <dir>] [--skip-codex-skill] [--force] [--json]
  refinery skill install [--codex-home <dir>] [--force] [--json]
  refinery set auth coral [--home <dir>] [--value-stdin] [--json]
  refinery doctor [--memory-home <dir>] [--json]
  refinery version [--json]
  refinery sources inspect --source <spec>... [--project <dir>] [--memory-home <dir>] [--json]
  refinery graph sync [--source <spec>...] [--project <dir>] [--memory-home <dir>] [--home <dir>] [--json]
  refinery graph status [--project <dir>] [--home <dir>] [--json]
  refinery graph inspect <node-id> [--project <dir>] [--home <dir>] [--json]
  refinery graph neighbors <node-id> [--depth <n>] [--edge-kind <kind>...] [--project <dir>] [--home <dir>] [--json]
  refinery graph plan --request <text> [--seed <node-id>...] [--max-nodes <n>] [--max-edges <n>] [--max-hops <n>] [--max-chars <n>] [--max-tokens <n>] [--project <dir>] [--home <dir>] [--json]
  refinery gateway start [--project <dir>] [--home <dir>] [--port <n>] [--json]
  refinery gateway status [--project <dir>] [--home <dir>] [--json]
  refinery gateway stop [--project <dir>] [--home <dir>] [--json]
  refinery ui url [--project <dir>] [--home <dir>] [--json]
  refinery ui open [--project <dir>] [--home <dir>] [--json]
  refinery ui config [--browser-open on|off] [--project <dir>] [--home <dir>] [--json]
  refinery review --source <spec>... --target <surface>... [--project <dir>] [--intent <intent>] [--request <text>] [--hypothesis <text>] [--topology pipeline|debate-critique|sparse-blackboard] [--model <id>] [--coral-llm-proxy] [--model-provider <name>] [--coral-jar <path>] [--json]
  refinery console run [--source <spec>...] [--target <surface>...] [--project <dir>] [--request <text>] [--topology pipeline|debate-critique|sparse-blackboard] [--model <id>] [--coral-llm-proxy] [--model-provider <name>] [--coral-jar <path>] [--coral-url <url>] [--json]
  refinery dev fixture memory-proposal [--json]
  refinery trial inspect --run-dir <dir> [--json]

Refinery builds a bounded ReviewPacket from source specs, runs a dry-run Coral-coordinated review, and emits proposal artifacts.
It does not approve, apply, or write durable memory. Runtime state defaults to ~/.refinery/runs/by-project/<project-key>.
Run init once to create ~/.refinery and install the bundled $refinery Codex skill.
Run skill install when you only want to install or refresh the bundled Codex skill.
Run set auth coral once to store a Coral API key for live specialist model calls.
Use console run for local Coral Console trials that seed a live session without writing run artifacts.
Use --no-update-check to suppress the best-effort public version notice.`;
const UPDATE_CHECK_FLAG = "--no-update-check";
function stableJson(value) {
    return JSON.stringify(value, null, 2) + "\n";
}
function packageRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
function bundledCodexSkillDir() {
    return path.join(packageRoot(), "skills", "refinery");
}
function bundledCodexSkillPath() {
    return path.join(bundledCodexSkillDir(), "SKILL.md");
}
function resolveCodexHome(codexHome, env = process.env) {
    return path.resolve(codexHome ?? env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}
function installedCodexSkillPath(codexHome) {
    return path.join(resolveCodexHome(codexHome), "skills", "refinery", "SKILL.md");
}
function copyDirectory(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const sourcePath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(sourcePath, destPath);
        }
        else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, destPath);
        }
    }
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
function parseNonNegativeIntegerOption(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a non-negative integer.`, { phase: "args" });
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a non-negative integer.`, { phase: "args" });
    }
    return parsed;
}
function parseUnitIntervalOption(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a number from 0 to 1.`, { phase: "args" });
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a number from 0 to 1.`, { phase: "args" });
    }
    return parsed;
}
function parseNonNegativeNumberOption(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a non-negative number.`, { phase: "args" });
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new RefineryError("INVALID_OPTION", `${label} must be a non-negative number.`, { phase: "args" });
    }
    return parsed;
}
function parseGraphEdgeKinds(value) {
    if (value === undefined)
        return undefined;
    const values = Array.isArray(value) ? value : [value];
    const parsed = values.map(String);
    const invalid = parsed.filter((kind) => !memoryGraphEdgeKinds.includes(kind));
    if (invalid.length > 0) {
        throw new RefineryError("INVALID_OPTION", `--edge-kind must be one of: ${memoryGraphEdgeKinds.join(", ")}. Invalid: ${invalid.join(", ")}`, { phase: "args" });
    }
    return [...new Set(parsed)];
}
function responsibilityPlanLimitsFromValues(values) {
    return {
        maxNodes: parsePositiveIntegerOption(values["max-nodes"], "--max-nodes"),
        maxEdges: parseNonNegativeIntegerOption(values["max-edges"], "--max-edges"),
        maxHops: parseNonNegativeIntegerOption(values["max-hops"], "--max-hops"),
        maxChars: parsePositiveIntegerOption(values["max-chars"], "--max-chars"),
        maxTokens: parsePositiveIntegerOption(values["max-tokens"], "--max-tokens"),
        edgeKinds: parseGraphEdgeKinds(values["edge-kind"]),
        minConfidence: parseUnitIntervalOption(values["min-confidence"], "--min-confidence"),
        maxAgeDays: parseNonNegativeNumberOption(values["max-age-days"], "--max-age-days"),
    };
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
    if (argv[0] === "sources" && argv[1] === "inspect")
        return "sources inspect";
    if (argv[0] === "graph" && argv[1])
        return `graph ${argv[1]}`;
    if (argv[0] === "gateway" && argv[1])
        return `gateway ${argv[1]}`;
    if (argv[0] === "ui" && argv[1])
        return `ui ${argv[1]}`;
    if (argv[0] === "dev" && argv[1] === "fixture")
        return "dev fixture";
    if (argv[0] === "set" && argv[1] === "auth")
        return "set auth";
    if (argv[0] === "skill" && argv[1] === "install")
        return "skill install";
    return argv[0] ?? "unknown";
}
function wantsJson(argv) {
    return argv.includes("--json");
}
function stripUpdateCheckFlag(argv) {
    const disabled = argv.includes(UPDATE_CHECK_FLAG);
    return {
        args: argv.filter((arg) => arg !== UPDATE_CHECK_FLAG),
        disabled,
    };
}
function updateCheckDisabled(flagDisabled) {
    return flagDisabled || process.env.REFINERY_NO_UPDATE_CHECK === "1" || process.env.CI === "1" || process.env.CI === "true";
}
function supportsUpdateCheck(command) {
    return ["doctor", "init", "set", "skill", "version", "sources", "graph", "gateway", "ui", "trial", "console", "dev", "review"].includes(command ?? "");
}
async function maybePrintUpdateNotice(flagDisabled) {
    if (updateCheckDisabled(flagDisabled))
        return;
    try {
        const metadata = packageMetadata();
        const result = await checkForUpdate({
            packageName: metadata.name,
            currentVersion: metadata.version,
            cachePath: path.join(resolveRefineryPaths().home, "cache", "update-check.json"),
        });
        if (result?.updateAvailable) {
            process.stderr.write(`${formatUpdateNotice(metadata.name, result)}\n`);
        }
    }
    catch {
        // Update notices are advisory and must never affect the requested command.
    }
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
function installCodexSkill(options = {}) {
    const installPath = installedCodexSkillPath(options.codexHome);
    if (options.skip) {
        return { requested: false, action: "skipped", path: installPath };
    }
    const sourceDir = bundledCodexSkillDir();
    if (!fs.existsSync(bundledCodexSkillPath())) {
        throw new RefineryError("SKILL_BUNDLE_NOT_FOUND", `Bundled Codex skill not found: ${sourceDir}`, {
            phase: "init",
        });
    }
    const destDir = path.dirname(installPath);
    if (fs.existsSync(installPath) && !options.force) {
        return { requested: true, action: "preserved", path: installPath };
    }
    const action = fs.existsSync(installPath) ? "overwritten" : "installed";
    if (options.force && fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
    }
    copyDirectory(sourceDir, destDir);
    return { requested: true, action, path: installPath };
}
async function cmdInit(rest) {
    const values = parseOptionArgs(rest, {
        home: { type: "string" },
        "codex-home": { type: "string" },
        "skip-codex-skill": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
    });
    const paths = resolveRefineryPaths({
        home: typeof values.home === "string" ? values.home : undefined,
        cwd: process.cwd(),
    });
    const dirs = [
        paths.configDir,
        paths.credentialsDir,
        paths.cataloguesDir,
        path.join(paths.runsRootDir, "by-project"),
        paths.runsDir,
        paths.graphsDir,
    ];
    const createdDirs = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir))
            createdDirs.push(dir);
        fs.mkdirSync(dir, { recursive: true });
    }
    const codexSkill = installCodexSkill({
        codexHome: typeof values["codex-home"] === "string" ? values["codex-home"] : undefined,
        force: Boolean(values.force),
        skip: Boolean(values["skip-codex-skill"]),
    });
    const memoryHome = resolveCodexMemoryHome();
    process.stdout.write(stableJson({
        ok: true,
        command: "init",
        home: paths.home,
        createdDirs,
        codexSkill,
        doctor: {
            memoryHome,
            memoryHomeExists: fs.existsSync(memoryHome),
            bundledCodexSkill: {
                path: bundledCodexSkillPath(),
                exists: fs.existsSync(bundledCodexSkillPath()),
            },
            installedCodexSkill: {
                path: codexSkill.path,
                exists: fs.existsSync(codexSkill.path),
            },
        },
    }));
    return 0;
}
async function cmdSkill(rest) {
    const sub = rest[0];
    if (sub !== "install") {
        throw new RefineryError("INVALID_OPTION", "Unknown skill command. Use: refinery skill install", { phase: "args" });
    }
    const values = parseOptionArgs(rest.slice(1), {
        "codex-home": { type: "string" },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
    });
    const codexSkill = installCodexSkill({
        codexHome: typeof values["codex-home"] === "string" ? values["codex-home"] : undefined,
        force: Boolean(values.force),
    });
    process.stdout.write(stableJson({
        ok: true,
        command: "skill install",
        codexSkill,
        bundledCodexSkill: {
            path: bundledCodexSkillPath(),
            exists: fs.existsSync(bundledCodexSkillPath()),
        },
    }));
    return 0;
}
async function readAllStdin() {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin)
        value += chunk;
    return value;
}
async function readSecretFromTty(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
        throw new RefineryError("AUTH_INPUT_REQUIRED", "Use an interactive terminal or pass --value-stdin to read the secret from stdin.", { phase: "auth" });
    }
    return await new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const previousRaw = stdin.isRaw;
        let value = "";
        const cleanup = () => {
            stdin.off("data", onData);
            stdin.setRawMode(previousRaw);
            stdin.pause();
        };
        const finish = () => {
            cleanup();
            stdout.write("\n");
            resolve(value);
        };
        const fail = (error) => {
            cleanup();
            stdout.write("\n");
            reject(error);
        };
        const onData = (chunk) => {
            const input = chunk.toString("utf8");
            for (const char of input) {
                if (char === "\u0003") {
                    fail(new RefineryError("AUTH_INPUT_CANCELLED", "Auth input cancelled.", { phase: "auth" }));
                    return;
                }
                if (char === "\r" || char === "\n") {
                    finish();
                    return;
                }
                if (char === "\u007f" || char === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                value += char;
            }
        };
        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}
async function cmdSet(rest) {
    const sub = rest[0];
    const provider = rest[1];
    if (sub !== "auth" || provider !== "coral") {
        throw new RefineryError("INVALID_OPTION", "Unknown set command. Use: refinery set auth coral", { phase: "args" });
    }
    const values = parseOptionArgs(rest.slice(2), {
        home: { type: "string" },
        "value-stdin": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
    });
    const home = typeof values.home === "string" ? values.home : undefined;
    const value = Boolean(values["value-stdin"])
        ? await readAllStdin()
        : await readSecretFromTty("Coral API key: ");
    const credential = writeStoredAuth("coral", value, { home });
    process.stdout.write(stableJson({
        ok: true,
        command: "set auth",
        provider: "coral",
        credential: {
            present: credential.present,
            path: credential.path,
            source: credential.source,
            mode: "0600",
        },
        next: [
            "refinery doctor --json",
            "refinery review --json",
        ],
    }));
    return 0;
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
    const sourceInspection = await inspectSources({
        sourceSpecs: parseSourceSpecs(["codex:memories"]),
        project: process.cwd(),
        scope: "project",
        memoryHome,
        sourceLimit: 3,
    });
    const refineryPaths = resolveRefineryPaths();
    const installedSkillPath = installedCodexSkillPath();
    const localEnv = loadLocalEnv(process.cwd());
    const modelAuth = resolveModelApiKey({
        env: process.env,
        localEnv,
        cwd: process.cwd(),
    }).status;
    const coralAuth = storedAuthStatus("coral");
    const output = {
        ok: true,
        command: "doctor",
        memoryHome,
        memoryHomeSafe: path.basename(memoryHome) === "memories",
        memoryHomeExists: fs.existsSync(memoryHome),
        authRequired: false,
        modelAuth: {
            requiredForLiveReview: true,
            present: modelAuth.present,
            source: modelAuth.source,
            provider: modelAuth.provider,
            ...(modelAuth.credentialPath ? { credentialPath: modelAuth.credentialPath } : {}),
        },
        storedAuth: {
            coral: {
                present: coralAuth.present,
                path: coralAuth.path,
            },
        },
        sourceReader: { source: "codex:memories" },
        sourceCount: sourceInspection.counts.documents,
        activeMemoryCount: sourceInspection.counts.activeMemories,
        refineryHome: {
            home: refineryPaths.home,
            exists: fs.existsSync(refineryPaths.home),
        },
        bundledCodexSkill: {
            path: bundledCodexSkillPath(),
            exists: fs.existsSync(bundledCodexSkillPath()),
        },
        installedCodexSkill: {
            path: installedSkillPath,
            exists: fs.existsSync(installedSkillPath),
        },
        errors: sourceInspection.warnings,
    };
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
async function cmdSources(rest) {
    const sub = rest[0];
    if (sub !== "inspect") {
        throw new RefineryError("INVALID_OPTION", "Unknown sources command. Use: refinery sources inspect", { phase: "args" });
    }
    const values = parseOptionArgs(rest.slice(1), {
        source: { type: "string", multiple: true },
        project: { type: "string" },
        home: { type: "string" },
        scope: { type: "string", default: "project" },
        "memory-home": { type: "string" },
        "source-limit": { type: "string" },
        "source-char-limit": { type: "string" },
        json: { type: "boolean", default: false },
    });
    const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());
    const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
    const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
    const result = await inspectSources({
        sourceSpecs: parseSourceSpecs(values.source),
        project,
        scope: String(values.scope ?? "project"),
        home: typeof values.home === "string" ? values.home : undefined,
        memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
        sourceLimit,
        sourceCharLimit,
    });
    process.stdout.write(stableJson(result));
    return 0;
}
function graphLocationOptions(values) {
    return {
        project: path.resolve(typeof values.project === "string" ? values.project : process.cwd()),
        home: typeof values.home === "string" ? values.home : undefined,
        graphPath: typeof values["graph-path"] === "string" ? values["graph-path"] : undefined,
    };
}
async function cmdGraph(rest) {
    const sub = rest[0];
    if (sub === "sync") {
        const values = parseOptionArgs(rest.slice(1), {
            source: { type: "string", multiple: true },
            project: { type: "string" },
            home: { type: "string" },
            "graph-path": { type: "string" },
            "memory-home": { type: "string" },
            "source-limit": { type: "string" },
            json: { type: "boolean", default: false },
        });
        const location = graphLocationOptions(values);
        const result = await syncCodexMemoryGraph({
            ...location,
            sourceSpecs: parseSourceSpecs(values.source),
            memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
            sourceLimit: parsePositiveIntegerOption(values["source-limit"], "--source-limit"),
        });
        const gatewayNotified = await notifyGatewayGraphSync({
            home: location.home,
            project: location.project,
            payload: {
                syncedAt: result.index.syncedAt,
                changed: {
                    nodes: result.delta.createdNodeIds.length + result.delta.updatedNodeIds.length + result.delta.removedNodeIds.length,
                    edges: result.delta.createdEdgeIds.length + result.delta.updatedEdgeIds.length + result.delta.removedEdgeIds.length,
                },
            },
        });
        let browserOpened = false;
        const warnings = [...result.warnings];
        try {
            if ((result.changedNodeIds.length > 0 || result.removedNodeIds.length > 0)
                && readUiConfig(location).browserOpenOnSync) {
                const gateway = await startGateway(location);
                if (gateway.uiUrl) {
                    openExternalUrl(gateway.uiUrl);
                    browserOpened = true;
                }
            }
        }
        catch (error) {
            warnings.push(`Graph sync succeeded, but the optional UI open step failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.stdout.write(stableJson({
            ok: true,
            command: "graph sync",
            graphPath: result.graphPath,
            project: result.index.project,
            schemaVersion: result.index.schemaVersion,
            indexerVersion: result.index.indexerVersion,
            syncedAt: result.index.syncedAt,
            sourceSpecs: result.index.sourceSpecs,
            summary: result.summary,
            delta: result.delta,
            changedNodeIds: result.changedNodeIds,
            removedNodeIds: result.removedNodeIds,
            warnings,
            canonicalSourcesMutated: result.canonicalSourcesMutated,
            sourceIsolation: result.sourceIsolation,
            gatewayNotified,
            browserOpened,
        }));
        return 0;
    }
    if (sub === "status") {
        const values = parseOptionArgs(rest.slice(1), {
            project: { type: "string" },
            home: { type: "string" },
            "graph-path": { type: "string" },
            json: { type: "boolean", default: false },
        });
        process.stdout.write(stableJson(getMemoryGraphStatus(graphLocationOptions(values))));
        return 0;
    }
    if (sub === "inspect") {
        const nodeId = rest[1];
        if (!nodeId || nodeId.startsWith("--")) {
            throw new RefineryError("INVALID_OPTION", "graph inspect requires <node-id>.", { phase: "args" });
        }
        const values = parseOptionArgs(rest.slice(2), {
            project: { type: "string" },
            home: { type: "string" },
            "graph-path": { type: "string" },
            json: { type: "boolean", default: false },
        });
        process.stdout.write(stableJson(inspectMemoryGraphNode({ ...graphLocationOptions(values), nodeId })));
        return 0;
    }
    if (sub === "neighbors") {
        const nodeId = rest[1];
        if (!nodeId || nodeId.startsWith("--")) {
            throw new RefineryError("INVALID_OPTION", "graph neighbors requires <node-id>.", { phase: "args" });
        }
        const values = parseOptionArgs(rest.slice(2), {
            project: { type: "string" },
            home: { type: "string" },
            "graph-path": { type: "string" },
            depth: { type: "string" },
            "max-nodes": { type: "string" },
            "max-edges": { type: "string" },
            "edge-kind": { type: "string", multiple: true },
            "min-confidence": { type: "string" },
            json: { type: "boolean", default: false },
        });
        process.stdout.write(stableJson(getMemoryGraphNeighbors({
            ...graphLocationOptions(values),
            nodeId,
            depth: parseNonNegativeIntegerOption(values.depth, "--depth"),
            maxNodes: parsePositiveIntegerOption(values["max-nodes"], "--max-nodes"),
            maxEdges: parseNonNegativeIntegerOption(values["max-edges"], "--max-edges"),
            edgeKinds: parseGraphEdgeKinds(values["edge-kind"]),
            minConfidence: parseUnitIntervalOption(values["min-confidence"], "--min-confidence"),
        })));
        return 0;
    }
    if (sub === "plan") {
        const values = parseOptionArgs(rest.slice(1), {
            request: { type: "string" },
            scope: { type: "string", default: "project" },
            seed: { type: "string", multiple: true },
            project: { type: "string" },
            home: { type: "string" },
            "graph-path": { type: "string" },
            "max-nodes": { type: "string" },
            "max-edges": { type: "string" },
            "max-hops": { type: "string" },
            "max-chars": { type: "string" },
            "max-tokens": { type: "string" },
            "edge-kind": { type: "string", multiple: true },
            "min-confidence": { type: "string" },
            "max-age-days": { type: "string" },
            json: { type: "boolean", default: false },
        });
        const location = graphLocationOptions(values);
        const planned = planMemoryGraph({
            ...location,
            request: typeof values.request === "string" ? values.request : null,
            scope: String(values.scope ?? "project"),
            explicitNodeIds: Array.isArray(values.seed) ? values.seed.map(String) : [],
            limits: responsibilityPlanLimitsFromValues(values),
        });
        process.stdout.write(stableJson({
            ok: true,
            command: "graph plan",
            graphPath: planned.graphPath,
            retrieval: planned.retrieval,
            plan: planned.plan,
        }));
        return 0;
    }
    throw new RefineryError("INVALID_OPTION", "Unknown graph command. Use: refinery graph sync|status|inspect|neighbors|plan", { phase: "args" });
}
function gatewayLocationValues(values) {
    return {
        home: typeof values.home === "string" ? values.home : undefined,
        project: path.resolve(typeof values.project === "string" ? values.project : process.cwd()),
    };
}
async function cmdGateway(rest) {
    const sub = rest[0];
    const values = parseOptionArgs(rest.slice(1), {
        project: { type: "string" },
        home: { type: "string" },
        port: { type: "string" },
        json: { type: "boolean", default: false },
    });
    const location = gatewayLocationValues(values);
    if (sub === "start") {
        const port = parseNonNegativeIntegerOption(values.port, "--port");
        if (port !== undefined && port > 65_535)
            throw new RefineryError("INVALID_OPTION", "--port must be from 0 to 65535.", { phase: "args" });
        const result = await startGateway({ ...location, port });
        process.stdout.write(stableJson({ ok: true, command: "gateway start", ...result }));
        return 0;
    }
    if (sub === "status") {
        const { uiUrl: _secretUrl, ...result } = await gatewayStatus(location);
        process.stdout.write(stableJson({ ok: true, command: "gateway status", ...result }));
        return 0;
    }
    if (sub === "stop") {
        const { uiUrl: _secretUrl, ...result } = await stopGateway(location);
        process.stdout.write(stableJson({ ok: true, command: "gateway stop", ...result }));
        return 0;
    }
    throw new RefineryError("INVALID_OPTION", "Unknown gateway command. Use: refinery gateway start|status|stop", { phase: "args" });
}
function openExternalUrl(url) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
        // The URL is still emitted so an agent or human can open it manually.
    });
    child.unref();
}
async function cmdUi(rest) {
    const sub = rest[0];
    const values = parseOptionArgs(rest.slice(1), {
        project: { type: "string" },
        home: { type: "string" },
        "browser-open": { type: "string" },
        json: { type: "boolean", default: false },
    });
    const location = gatewayLocationValues(values);
    if (sub === "config") {
        const setting = values["browser-open"];
        if (setting !== undefined && setting !== "on" && setting !== "off") {
            throw new RefineryError("INVALID_OPTION", "--browser-open must be on or off.", { phase: "args" });
        }
        const config = setting === undefined
            ? readUiConfig(location)
            : writeUiConfig({ ...location, browserOpenOnSync: setting === "on" });
        process.stdout.write(stableJson({
            ok: true,
            command: "ui config",
            config,
            behavior: config.browserOpenOnSync
                ? "Refinery may open the local UI after graph changes."
                : "Refinery will not open a browser automatically.",
        }));
        return 0;
    }
    if (sub === "url" || sub === "open") {
        const result = await startGateway(location);
        if (!result.uiUrl)
            throw new RefineryError("GATEWAY_URL_UNAVAILABLE", "Gateway started without a capability URL.", { phase: "gateway-lifecycle" });
        if (sub === "open")
            openExternalUrl(result.uiUrl);
        process.stdout.write(stableJson({
            ok: true,
            command: `ui ${sub}`,
            url: result.uiUrl,
            opened: sub === "open",
            instruction: sub === "url"
                ? "Open this local capability URL in the Codex browser or another browser."
                : "The local UI open request was sent; use the URL if no browser appeared.",
        }));
        return 0;
    }
    throw new RefineryError("INVALID_OPTION", "Unknown UI command. Use: refinery ui url|open|config", { phase: "args" });
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
        source: { type: "string", multiple: true },
        target: { type: "string", multiple: true },
        project: { type: "string" },
        intent: { type: "string" },
        request: { type: "string" },
        scope: { type: "string", default: "project" },
        home: { type: "string" },
        "memory-home": { type: "string" },
        "run-id": { type: "string" },
        "source-limit": { type: "string" },
        "source-char-limit": { type: "string" },
        "graph-source-limit": { type: "string" },
        "no-graph": { type: "boolean", default: false },
        seed: { type: "string", multiple: true },
        "max-nodes": { type: "string" },
        "max-edges": { type: "string" },
        "max-hops": { type: "string" },
        "max-chars": { type: "string" },
        "max-tokens": { type: "string" },
        "edge-kind": { type: "string", multiple: true },
        "min-confidence": { type: "string" },
        "max-age-days": { type: "string" },
        "coral-url": { type: "string" },
        "coral-auth-key": { type: "string" },
        "coral-config": { type: "string" },
        "coral-namespace": { type: "string" },
        "coral-session-id": { type: "string" },
        "coral-thread-id": { type: "string" },
        "coral-package": { type: "string" },
        "coral-jar": { type: "string" },
        "coral-llm-proxy": { type: "boolean", default: false },
        model: { type: "string" },
        "model-provider": { type: "string" },
        "reasoning-effort": { type: "string" },
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
    const graphSourceLimit = parsePositiveIntegerOption(values["graph-source-limit"], "--graph-source-limit");
    const coralTimeoutMs = parsePositiveIntegerOption(values["coral-timeout-ms"], "--coral-timeout-ms");
    const topology = parseReviewTopology(values.topology);
    if (typeof values["coral-thread-id"] === "string" && typeof values["coral-session-id"] !== "string") {
        throw new RefineryError("INVALID_OPTION", "--coral-thread-id requires --coral-session-id", { phase: "args" });
    }
    if (typeof values["model-provider"] === "string" && !values["coral-llm-proxy"]) {
        throw new RefineryError("INVALID_OPTION", "--model-provider requires --coral-llm-proxy", { phase: "args" });
    }
    if (typeof values["coral-jar"] === "string" && typeof values["coral-package"] === "string") {
        throw new RefineryError("INVALID_OPTION", "Use only one of --coral-jar or --coral-package", { phase: "args" });
    }
    const project = path.resolve(typeof values.project === "string" ? values.project : process.cwd());
    const sourceSpecs = parseSourceSpecs(values.source);
    let packet = await buildReviewPacket({
        sourceSpecs,
        targets: parseTargetSurfaces(values.target),
        project,
        scope: String(values.scope ?? "project"),
        intent,
        request,
        home: typeof values.home === "string" ? values.home : undefined,
        memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
        sourceLimit,
        sourceCharLimit,
    });
    if (!values["no-graph"]) {
        packet = (await prepareGraphReviewPacket({
            packet,
            sourceSpecs,
            memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
            home: typeof values.home === "string" ? values.home : undefined,
            sourceLimit: graphSourceLimit,
            explicitNodeIds: Array.isArray(values.seed) ? values.seed.map(String) : [],
            planLimits: responsibilityPlanLimitsFromValues(values),
        })).packet;
    }
    const session = await startCoralConsoleRun({
        packet,
        runId,
        coral: {
            apiUrl: typeof values["coral-url"] === "string" ? values["coral-url"] : undefined,
            authKey: typeof values["coral-auth-key"] === "string" ? values["coral-auth-key"] : undefined,
            configPath: typeof values["coral-config"] === "string" ? values["coral-config"] : undefined,
            namespace: typeof values["coral-namespace"] === "string" ? values["coral-namespace"] : undefined,
            sessionId: typeof values["coral-session-id"] === "string" ? values["coral-session-id"] : undefined,
            threadId: typeof values["coral-thread-id"] === "string" ? values["coral-thread-id"] : undefined,
            coralPackage: typeof values["coral-package"] === "string" ? values["coral-package"] : undefined,
            coralJar: typeof values["coral-jar"] === "string" ? values["coral-jar"] : undefined,
            llmProxy: Boolean(values["coral-llm-proxy"]),
            modelName: typeof values.model === "string" ? values.model : undefined,
            modelProxyProvider: typeof values["model-provider"] === "string" ? values["model-provider"] : undefined,
            reasoningEffort: typeof values["reasoning-effort"] === "string" ? values["reasoning-effort"] : undefined,
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
        source: { type: "string", multiple: true },
        target: { type: "string", multiple: true },
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
        "graph-source-limit": { type: "string" },
        "no-graph": { type: "boolean", default: false },
        seed: { type: "string", multiple: true },
        "max-nodes": { type: "string" },
        "max-edges": { type: "string" },
        "max-hops": { type: "string" },
        "max-chars": { type: "string" },
        "max-tokens": { type: "string" },
        "edge-kind": { type: "string", multiple: true },
        "min-confidence": { type: "string" },
        "max-age-days": { type: "string" },
        "coral-url": { type: "string" },
        "coral-auth-key": { type: "string" },
        "coral-config": { type: "string" },
        "coral-namespace": { type: "string" },
        "coral-session-id": { type: "string" },
        "coral-thread-id": { type: "string" },
        "coral-package": { type: "string" },
        "coral-jar": { type: "string" },
        "coral-llm-proxy": { type: "boolean", default: false },
        model: { type: "string" },
        "model-provider": { type: "string" },
        "reasoning-effort": { type: "string" },
        "coral-timeout-ms": { type: "string" },
        "coral-no-start": { type: "boolean", default: false },
        "coral-no-teardown": { type: "boolean", default: false },
        hypothesis: { type: "string" },
        topology: { type: "string" },
        json: { type: "boolean", default: false },
    });
    const runId = validateRunId(typeof values["run-id"] === "string" ? values["run-id"] : defaultRunId());
    const intent = parseReviewIntent(values.intent);
    const request = typeof values.request === "string" && values.request.trim() ? values.request.trim() : null;
    const sourceLimit = parsePositiveIntegerOption(values["source-limit"], "--source-limit");
    const sourceCharLimit = parsePositiveIntegerOption(values["source-char-limit"], "--source-char-limit");
    const graphSourceLimit = parsePositiveIntegerOption(values["graph-source-limit"], "--graph-source-limit");
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
    if (typeof values["model-provider"] === "string" && !values["coral-llm-proxy"]) {
        throw new RefineryError("INVALID_OPTION", "--model-provider requires --coral-llm-proxy", { phase: "args" });
    }
    if (typeof values["coral-jar"] === "string" && typeof values["coral-package"] === "string") {
        throw new RefineryError("INVALID_OPTION", "Use only one of --coral-jar or --coral-package", { phase: "args" });
    }
    const sourceSpecs = parseSourceSpecs(values.source);
    let packet = await buildReviewPacket({
        sourceSpecs,
        targets: parseTargetSurfaces(values.target),
        project,
        scope: String(values.scope ?? "project"),
        intent,
        request,
        home: typeof values.home === "string" ? values.home : undefined,
        memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
        sourceLimit,
        sourceCharLimit,
    });
    if (!values["no-graph"]) {
        packet = (await prepareGraphReviewPacket({
            packet,
            sourceSpecs,
            memoryHome: typeof values["memory-home"] === "string" ? values["memory-home"] : undefined,
            home: typeof values.home === "string" ? values.home : undefined,
            sourceLimit: graphSourceLimit,
            explicitNodeIds: Array.isArray(values.seed) ? values.seed.map(String) : [],
            planLimits: responsibilityPlanLimitsFromValues(values),
        })).packet;
    }
    const result = await runCoralReview({
        packet,
        runId,
        outputDir,
        hypothesis: typeof values.hypothesis === "string" ? values.hypothesis : undefined,
        sink,
        coral: {
            apiUrl: typeof values["coral-url"] === "string" ? values["coral-url"] : undefined,
            authKey: typeof values["coral-auth-key"] === "string" ? values["coral-auth-key"] : undefined,
            configPath: typeof values["coral-config"] === "string" ? values["coral-config"] : undefined,
            namespace: typeof values["coral-namespace"] === "string" ? values["coral-namespace"] : undefined,
            sessionId: typeof values["coral-session-id"] === "string" ? values["coral-session-id"] : undefined,
            threadId: typeof values["coral-thread-id"] === "string" ? values["coral-thread-id"] : undefined,
            coralPackage: typeof values["coral-package"] === "string" ? values["coral-package"] : undefined,
            coralJar: typeof values["coral-jar"] === "string" ? values["coral-jar"] : undefined,
            llmProxy: Boolean(values["coral-llm-proxy"]),
            modelName: typeof values.model === "string" ? values.model : undefined,
            modelProxyProvider: typeof values["model-provider"] === "string" ? values["model-provider"] : undefined,
            reasoningEffort: typeof values["reasoning-effort"] === "string" ? values["reasoning-effort"] : undefined,
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
    const updateCheck = stripUpdateCheckFlag(argv);
    const commandArgs = updateCheck.args;
    const command = commandArgs[0];
    if (!command || command === "--help" || command === "-h") {
        process.stdout.write(HELP + "\n");
        return 0;
    }
    if (!supportsUpdateCheck(command)) {
        throw new RefineryError("INVALID_OPTION", `Unknown command: ${command}`, { phase: "args" });
    }
    await maybePrintUpdateNotice(updateCheck.disabled);
    if (command === "doctor")
        return cmdDoctor(commandArgs.slice(1));
    if (command === "init")
        return cmdInit(commandArgs.slice(1));
    if (command === "set")
        return cmdSet(commandArgs.slice(1));
    if (command === "skill")
        return cmdSkill(commandArgs.slice(1));
    if (command === "version")
        return cmdVersion(commandArgs.slice(1));
    if (command === "sources")
        return cmdSources(commandArgs.slice(1));
    if (command === "graph")
        return cmdGraph(commandArgs.slice(1));
    if (command === "gateway")
        return cmdGateway(commandArgs.slice(1));
    if (command === "ui")
        return cmdUi(commandArgs.slice(1));
    if (command === "trial")
        return cmdTrial(commandArgs.slice(1));
    if (command === "console")
        return cmdConsole(commandArgs.slice(1));
    if (command === "dev")
        return cmdDev(commandArgs.slice(1));
    if (command === "review")
        return cmdReview(commandArgs.slice(1));
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