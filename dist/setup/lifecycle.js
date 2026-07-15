import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RefineryError } from "../core/errors.js";
import { resolveRefineryPaths } from "../core/paths.js";
import { startSetupHttpServer, setupCapabilityHash, setupProtocolVersion } from "./server.js";
const setupStateSchemaVersion = "refinery.setup-daemon-state.v1";
const maximumSetupTtlMs = 15 * 60 * 1_000;
const setupStartupTimeoutMs = 20_000;
function privateStateWrite(file, state) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32")
        fs.chmodSync(directory, 0o700);
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (process.platform !== "win32")
            fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, file);
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}
function validState(value) {
    if (!value || typeof value !== "object")
        return false;
    const state = value;
    return state.schemaVersion === setupStateSchemaVersion
        && state.protocol === setupProtocolVersion
        && typeof state.instanceId === "string"
        && /^[a-f0-9]{48}$/.test(state.instanceId)
        && typeof state.capabilityHash === "string"
        && /^[a-f0-9]{64}$/.test(state.capabilityHash)
        && typeof state.project === "string"
        && typeof state.home === "string"
        && (state.codexHome === null || typeof state.codexHome === "string")
        && typeof state.pid === "number" && Number.isInteger(state.pid) && state.pid >= 0
        && state.host === "127.0.0.1"
        && typeof state.port === "number" && Number.isInteger(state.port) && state.port >= 0 && state.port <= 65_535
        && typeof state.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt))
        && typeof state.expiresAt === "string" && Number.isFinite(Date.parse(state.expiresAt));
}
function quarantineState(file) {
    if (!fs.existsSync(file))
        return;
    const quarantine = `${file}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
        fs.renameSync(file, quarantine);
    }
    catch {
        fs.rmSync(file, { force: true });
    }
}
function readState(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!validState(parsed)) {
            quarantineState(file);
            return null;
        }
        return parsed;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        if (error instanceof SyntaxError) {
            quarantineState(file);
            return null;
        }
        throw error;
    }
}
function publicState(state, running) {
    return {
        running,
        protocol: state.protocol,
        project: state.project,
        home: state.home,
        pid: running ? state.pid : null,
        host: state.host,
        port: running ? state.port : null,
        startedAt: state.startedAt,
        expiresAt: state.expiresAt,
    };
}
async function health(state) {
    if (state.port <= 0 || Date.parse(state.expiresAt) <= Date.now())
        return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
        const response = await fetch(`http://${state.host}:${state.port}/internal/health`, {
            headers: { "X-Refinery-Instance": state.instanceId },
            signal: controller.signal,
        });
        if (!response.ok)
            return false;
        const body = await response.json();
        return body.instanceId === state.instanceId;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
function setupDaemonEnvironment(env) {
    const allowed = [
        "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
        "CODEX_HOME", "CORAL_CLOUD_API_URL", "REFINERY_MODEL_BASE_URL", "REFINERY_MODEL_NAME", "REFINERY_JAVA_BIN",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "npm_config_registry", "NPM_CONFIG_REGISTRY",
    ];
    return {
        ...Object.fromEntries(allowed
            .map((name) => [name, env[name]])
            .filter((entry) => typeof entry[1] === "string")),
        REFINERY_NO_UPDATE_CHECK: "1",
        NODE_NO_WARNINGS: "1",
    };
}
function cliEntryPath() {
    const extension = path.extname(fileURLToPath(import.meta.url));
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../cli${extension}`);
}
export async function setupLifecycleStatus(options) {
    const project = path.resolve(options.project);
    const paths = resolveRefineryPaths({ home: options.home, cwd: project, env: options.env });
    const state = readState(paths.setupStatePath);
    if (!state)
        return { running: false, protocol: setupProtocolVersion, project, expiresAt: null };
    const running = await health(state);
    if (!running)
        quarantineState(paths.setupStatePath);
    return publicState(state, running);
}
export async function stopSetupLifecycle(options) {
    const project = path.resolve(options.project);
    const paths = resolveRefineryPaths({ home: options.home, cwd: project, env: options.env });
    const state = readState(paths.setupStatePath);
    if (!state)
        return { running: false, protocol: setupProtocolVersion, project, stopped: false };
    if (!(await health(state))) {
        quarantineState(paths.setupStatePath);
        return { ...publicState(state, false), stopped: false, staleStateRecovered: true };
    }
    try {
        await fetch(`http://${state.host}:${state.port}/internal/shutdown`, {
            method: "POST",
            headers: { Origin: `http://${state.host}:${state.port}`, "X-Refinery-Instance": state.instanceId },
        });
    }
    catch {
        // The server may close before the response is observed.
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!(await health(state)))
            break;
        await sleep(25);
    }
    if (fs.existsSync(paths.setupStatePath))
        quarantineState(paths.setupStatePath);
    return { ...publicState(state, false), stopped: true };
}
export async function startSetupLifecycle(options) {
    const env = options.env ?? process.env;
    const project = path.resolve(options.project);
    const paths = resolveRefineryPaths({ home: options.home, cwd: project, env });
    await stopSetupLifecycle(options);
    const ttlMs = Math.max(30_000, Math.min(maximumSetupTtlMs, options.ttlMs ?? 10 * 60 * 1_000));
    const capability = crypto.randomBytes(32).toString("base64url");
    const state = {
        schemaVersion: setupStateSchemaVersion,
        protocol: setupProtocolVersion,
        instanceId: crypto.randomBytes(24).toString("hex"),
        capabilityHash: setupCapabilityHash(capability),
        project,
        home: paths.home,
        codexHome: options.codexHome ? path.resolve(options.codexHome) : null,
        pid: 0,
        host: "127.0.0.1",
        port: 0,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    privateStateWrite(paths.setupStatePath, state);
    const args = [
        cliEntryPath(), "setup", "serve",
        "--project", project,
        "--home", paths.home,
        "--instance-id", state.instanceId,
    ];
    if (state.codexHome)
        args.push("--codex-home", state.codexHome);
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: setupDaemonEnvironment(env),
    });
    let childExitCode = null;
    let childSpawnError = null;
    child.once("exit", (code) => { childExitCode = code; });
    child.once("error", (error) => { childSpawnError = error.code ?? error.name; });
    child.unref();
    const deadline = Date.now() + setupStartupTimeoutMs;
    while (Date.now() < deadline) {
        const current = readState(paths.setupStatePath);
        if (current?.instanceId === state.instanceId && current.pid === child.pid && await health(current)) {
            return {
                ...publicState(current, true),
                url: `http://${current.host}:${current.port}/#cap=${encodeURIComponent(capability)}`,
                humanConfirmationRequired: true,
            };
        }
        if (childExitCode !== null || childSpawnError !== null)
            break;
        await sleep(40);
    }
    if (child.pid) {
        try {
            process.kill(child.pid, "SIGTERM");
        }
        catch { /* already exited */ }
    }
    quarantineState(paths.setupStatePath);
    throw new RefineryError("SETUP_SERVER_START_FAILED", "The local setup server did not become ready.", {
        phase: "setup-lifecycle",
        details: {
            timeoutMs: setupStartupTimeoutMs,
            childExitCode,
            childSpawnError,
        },
    });
}
export async function serveSetupLifecycle(options) {
    const project = path.resolve(options.project);
    const paths = resolveRefineryPaths({ home: options.home, cwd: project, env: options.env });
    const state = readState(paths.setupStatePath);
    if (!state || state.instanceId !== options.instanceId || state.project !== project || state.home !== paths.home) {
        throw new RefineryError("SETUP_STATE_MISMATCH", "Setup daemon state does not match this process.", { phase: "setup-lifecycle" });
    }
    await new Promise((resolve, reject) => {
        startSetupHttpServer({
            home: state.home,
            project: state.project,
            codexHome: state.codexHome ?? undefined,
            capabilityHash: state.capabilityHash,
            instanceId: state.instanceId,
            expiresAt: state.expiresAt,
            env: options.env,
            onListening: ({ host, port, pid }) => {
                const current = readState(paths.setupStatePath);
                if (!current || current.instanceId !== state.instanceId) {
                    reject(new RefineryError("SETUP_STATE_MISMATCH", "Setup state changed during startup.", { phase: "setup-lifecycle" }));
                    return;
                }
                privateStateWrite(paths.setupStatePath, { ...current, host, port, pid });
            },
            onClosed: () => {
                const current = readState(paths.setupStatePath);
                if (current?.instanceId === state.instanceId)
                    fs.rmSync(paths.setupStatePath, { force: true });
                resolve();
            },
        }).catch(reject);
    });
}
//# sourceMappingURL=lifecycle.js.map