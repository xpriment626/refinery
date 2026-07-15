import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RefineryError } from "../core/errors.ts";
import { projectKeyForPath, resolveRefineryPaths } from "../core/paths.ts";

export const gatewayStateSchemaVersion = "refinery.gateway-state.v1" as const;

export interface GatewayState {
  schemaVersion: typeof gatewayStateSchemaVersion;
  instanceId: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  project: string;
  projectKey: string;
  capability: string;
}

export interface GatewayPublicState {
  schemaVersion: typeof gatewayStateSchemaVersion;
  instanceId: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  projectKey: string;
  projectLabel: string;
}

export interface GatewayLifecycleResult {
  running: boolean;
  stale: boolean;
  alreadyRunning?: boolean;
  staleRecovered?: boolean;
  publicState: GatewayPublicState | null;
  uiUrl: string | null;
}

interface GatewayBootstrap {
  schemaVersion: "refinery.gateway-bootstrap.v1";
  instanceId: string;
  capability: string;
  home: string;
  project: string;
  port: number;
  statePath: string;
  logPath: string;
}

const gatewayEnvironmentKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

export function buildGatewayEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of gatewayEnvironmentKeys) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) selected[key] = value;
  }
  return selected;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const LIFECYCLE_LOCK_STALE_MS = 30_000;
const LIFECYCLE_LOCK_WAIT_MS = 12_000;

async function acquireLifecycleLock(gatewayDir: string): Promise<() => void> {
  const lockPath = path.join(gatewayDir, "lifecycle.lock");
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + LIFECYCLE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ nonce, pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      if (process.platform !== "win32") fs.chmodSync(lockPath, 0o600);
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { nonce?: unknown };
          if (current.nonce === nonce) fs.rmSync(lockPath, { force: true });
        } catch {
          // Never remove a lock whose ownership can no longer be proven.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > LIFECYCLE_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`;
        fs.renameSync(lockPath, stalePath);
        if (process.platform !== "win32") fs.chmodSync(stalePath, 0o600);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await sleep(50);
  }
  throw new RefineryError(
    "GATEWAY_LIFECYCLE_IN_PROGRESS",
    "Another gateway lifecycle operation is still in progress. Retry after it finishes.",
    { phase: "gateway-lifecycle", details: { next: "refinery gateway status --json" } },
  );
}

function publicState(state: GatewayState): GatewayPublicState {
  return {
    schemaVersion: state.schemaVersion,
    instanceId: state.instanceId,
    pid: state.pid,
    host: state.host,
    port: state.port,
    startedAt: state.startedAt,
    projectKey: state.projectKey,
    projectLabel: path.basename(state.project) || "project",
  };
}

function uiUrl(state: GatewayState): string {
  return `http://${state.host}:${state.port}/#cap=${encodeURIComponent(state.capability)}`;
}

function readState(statePath: string): GatewayState | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gateway state is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<GatewayState>;
    if (parsed.schemaVersion !== gatewayStateSchemaVersion || typeof parsed.instanceId !== "string"
      || typeof parsed.pid !== "number" || parsed.host !== "127.0.0.1" || typeof parsed.port !== "number"
      || typeof parsed.startedAt !== "string" || typeof parsed.project !== "string"
      || typeof parsed.projectKey !== "string" || typeof parsed.capability !== "string"
      || parsed.capability.length < 32) {
      throw new Error("gateway state schema is invalid");
    }
    return parsed as GatewayState;
  } catch (error) {
    throw new RefineryError(
      "GATEWAY_STATE_INVALID",
      `Could not read gateway state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
      { phase: "gateway-lifecycle", details: { statePath } },
    );
  }
}

async function probe(state: GatewayState, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/v1/health`, {
      headers: { Authorization: `Bearer ${state.capability}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; schemaVersion?: string };
    return body.ok === true && body.schemaVersion === "refinery.gateway.v1";
  } catch {
    return false;
  }
}

function recoverStaleState(statePath: string): void {
  if (!fs.existsSync(statePath)) return;
  const stalePath = `${statePath}.stale-${Date.now()}.json`;
  fs.renameSync(statePath, stalePath);
  if (process.platform !== "win32") fs.chmodSync(stalePath, 0o600);
}

export async function gatewayStatus(options: { home?: string; project: string }): Promise<GatewayLifecycleResult> {
  const project = path.resolve(options.project);
  const paths = resolveRefineryPaths({ home: options.home, cwd: project });
  const state = readState(paths.gatewayStatePath);
  if (!state) return { running: false, stale: false, publicState: null, uiUrl: null };
  const running = await probe(state);
  return {
    running,
    stale: !running,
    publicState: publicState(state),
    uiUrl: running ? uiUrl(state) : null,
  };
}

export async function startGateway(options: { home?: string; project: string; port?: number }): Promise<GatewayLifecycleResult> {
  const project = path.resolve(options.project);
  const paths = resolveRefineryPaths({ home: options.home, cwd: project });
  fs.mkdirSync(paths.gatewayDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(paths.gatewayDir, 0o700);
  const releaseLifecycleLock = await acquireLifecycleLock(paths.gatewayDir);
  try {
    let existing: GatewayState | null = null;
    let staleRecovered = false;
    try {
      existing = readState(paths.gatewayStatePath);
    } catch (error) {
      if (!(error instanceof RefineryError) || error.code !== "GATEWAY_STATE_INVALID") throw error;
      recoverStaleState(paths.gatewayStatePath);
      staleRecovered = true;
    }
    if (existing && await probe(existing)) {
      if (existing.projectKey !== projectKeyForPath(project)) {
        throw new RefineryError(
          "GATEWAY_PROJECT_CONFLICT",
          `Gateway is already serving ${existing.project}. Stop it before starting another project.`,
          { phase: "gateway-lifecycle", details: { next: "refinery gateway stop --json" } },
        );
      }
      return { running: true, stale: false, alreadyRunning: true, publicState: publicState(existing), uiUrl: uiUrl(existing) };
    }
    if (existing) {
      recoverStaleState(paths.gatewayStatePath);
      staleRecovered = true;
    }

    const instanceId = crypto.randomUUID();
    const bootstrapPath = path.join(paths.gatewayDir, `bootstrap-${instanceId}.json`);
    const bootstrap: GatewayBootstrap = {
      schemaVersion: "refinery.gateway-bootstrap.v1",
      instanceId,
      capability: crypto.randomBytes(32).toString("base64url"),
      home: paths.home,
      project,
      port: Math.max(0, Math.min(65_535, Math.floor(options.port ?? 0))),
      statePath: paths.gatewayStatePath,
      logPath: paths.gatewayLogPath,
    };
    fs.writeFileSync(bootstrapPath, `${JSON.stringify(bootstrap)}\n`, { mode: 0o600, flag: "wx" });
    const extension = path.extname(fileURLToPath(import.meta.url));
    const daemonPath = path.resolve(import.meta.dirname, `daemon${extension}`);
    const child = spawn(process.execPath, [daemonPath, "--bootstrap", bootstrapPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: buildGatewayEnvironment(),
    });
    const childFailure: { error: Error | null } = { error: null };
    child.once("error", (error) => { childFailure.error = error; });
    child.unref();

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await sleep(50);
      const state = readState(paths.gatewayStatePath);
      if (state?.instanceId === instanceId && await probe(state, 750)) {
        if (fs.existsSync(bootstrapPath)) fs.rmSync(bootstrapPath, { force: true });
        return { running: true, stale: false, staleRecovered, publicState: publicState(state), uiUrl: uiUrl(state) };
      }
      if (childFailure.error || child.exitCode !== null) break;
    }
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    if (fs.existsSync(bootstrapPath)) fs.rmSync(bootstrapPath, { force: true });
    throw new RefineryError(
      "GATEWAY_START_TIMEOUT",
      childFailure.error ? `Gateway process could not start: ${childFailure.error.message}` : "Gateway did not become healthy within 8 seconds.",
      { phase: "gateway-lifecycle", details: { logPath: paths.gatewayLogPath } },
    );
  } finally {
    releaseLifecycleLock();
  }
}

export async function stopGateway(options: { home?: string; project: string }): Promise<GatewayLifecycleResult> {
  const project = path.resolve(options.project);
  const paths = resolveRefineryPaths({ home: options.home, cwd: project });
  fs.mkdirSync(paths.gatewayDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(paths.gatewayDir, 0o700);
  const releaseLifecycleLock = await acquireLifecycleLock(paths.gatewayDir);
  try {
    let state: GatewayState | null;
    try {
      state = readState(paths.gatewayStatePath);
    } catch (error) {
      if (!(error instanceof RefineryError) || error.code !== "GATEWAY_STATE_INVALID") throw error;
      recoverStaleState(paths.gatewayStatePath);
      return { running: false, stale: false, staleRecovered: true, publicState: null, uiUrl: null };
    }
    if (!state) return { running: false, stale: false, publicState: null, uiUrl: null };
    if (!await probe(state)) {
      recoverStaleState(paths.gatewayStatePath);
      return { running: false, stale: false, staleRecovered: true, publicState: null, uiUrl: null };
    }
    try {
      await fetch(`http://${state.host}:${state.port}/api/v1/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.capability}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      throw new RefineryError(
        "GATEWAY_STOP_FAILED",
        `Gateway did not accept graceful shutdown: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "gateway-lifecycle", details: { next: "refinery gateway status --json" } },
      );
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(paths.gatewayStatePath) || !await probe(state, 150)) {
        if (fs.existsSync(paths.gatewayStatePath)) fs.rmSync(paths.gatewayStatePath, { force: true });
        return { running: false, stale: false, publicState: null, uiUrl: null };
      }
      await sleep(50);
    }
    throw new RefineryError(
      "GATEWAY_STOP_TIMEOUT",
      "Gateway remained healthy after graceful shutdown was requested.",
      { phase: "gateway-lifecycle" },
    );
  } finally {
    releaseLifecycleLock();
  }
}

export async function notifyGatewayGraphSync(options: { home?: string; project: string; payload: Record<string, unknown> }): Promise<boolean> {
  const project = path.resolve(options.project);
  const paths = resolveRefineryPaths({ home: options.home, cwd: project });
  const state = readState(paths.gatewayStatePath);
  if (!state || state.projectKey !== projectKeyForPath(project) || !await probe(state, 250)) return false;
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/v1/events/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "graph-synced", payload: options.payload }),
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
