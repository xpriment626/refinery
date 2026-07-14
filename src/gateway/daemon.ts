#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { projectKeyForPath } from "../core/paths.ts";
import { createGatewayServer } from "./server.ts";
import { gatewayStateSchemaVersion, type GatewayState } from "./lifecycle.ts";
import { createBoundedGatewayLogger } from "./logging.ts";

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

function atomicWrite(filePath: string, value: unknown): void {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readBootstrap(): { bootstrap: GatewayBootstrap; bootstrapPath: string } {
  const at = process.argv.indexOf("--bootstrap");
  const bootstrapPath = at >= 0 ? process.argv[at + 1] : undefined;
  if (!bootstrapPath) throw new Error("--bootstrap is required");
  const stat = fs.lstatSync(bootstrapPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gateway bootstrap must be a regular file");
  const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8")) as GatewayBootstrap;
  if (bootstrap.schemaVersion !== "refinery.gateway-bootstrap.v1" || typeof bootstrap.capability !== "string"
    || bootstrap.capability.length < 32 || typeof bootstrap.instanceId !== "string") {
    throw new Error("gateway bootstrap schema is invalid");
  }
  return { bootstrap, bootstrapPath };
}

const { bootstrap, bootstrapPath } = readBootstrap();
const log = createBoundedGatewayLogger(bootstrap.logPath);
fs.rmSync(bootstrapPath, { force: true });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (fs.existsSync(bootstrap.statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(bootstrap.statePath, "utf8")) as Partial<GatewayState>;
      if (state.instanceId === bootstrap.instanceId) fs.rmSync(bootstrap.statePath, { force: true });
    } catch {
      // Leave malformed state for the parent to quarantine rather than deleting unknown data.
    }
  }
};

const gateway = createGatewayServer({
  home: bootstrap.home,
  project: bootstrap.project,
  capability: bootstrap.capability,
  staticDir: path.resolve(import.meta.dirname, "../ui"),
  onShutdown: async () => {
    log("info", "gateway-stopping", { reason: "api" });
    cleanup();
  },
});

try {
  const address = await gateway.listen(bootstrap.port);
  const state: GatewayState = {
    schemaVersion: gatewayStateSchemaVersion,
    instanceId: bootstrap.instanceId,
    pid: process.pid,
    host: address.host,
    port: address.port,
    startedAt: new Date().toISOString(),
    project: path.resolve(bootstrap.project),
    projectKey: projectKeyForPath(bootstrap.project),
    capability: bootstrap.capability,
  };
  atomicWrite(bootstrap.statePath, state);
  log("info", "gateway-started", { instanceId: state.instanceId, pid: state.pid, host: state.host, port: state.port, projectKey: state.projectKey });
} catch (error) {
  log("error", "gateway-start-failed", { message: error instanceof Error ? error.message : String(error) });
  cleanup();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log("info", "gateway-stopping", { reason: signal });
    cleanup();
    await gateway.close();
  });
}

process.on("exit", cleanup);
