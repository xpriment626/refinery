import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRefineryPaths } from "../core/paths.ts";
import { buildGatewayEnvironment, gatewayStatus, startGateway, stopGateway } from "./lifecycle.ts";

test("gateway lifecycle starts a detached authenticated daemon, reports status, and stops it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-lifecycle-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });

  const started = await startGateway({ home, project });
  try {
    assert.equal(started.running, true);
    assert.ok(started.uiUrl);
    assert.match(started.uiUrl, /^http:\/\/127\.0\.0\.1:\d+\/#cap=/);
    assert.doesNotMatch(JSON.stringify(started.publicState), /capability|token/i);
    const status = await gatewayStatus({ home, project });
    assert.equal(status.running, true);
    const paths = resolveRefineryPaths({ home, cwd: project });
    if (process.platform !== "win32") assert.equal(fs.statSync(paths.gatewayStatePath).mode & 0o777, 0o600);
  } finally {
    const stopped = await stopGateway({ home, project });
    assert.equal(stopped.running, false);
  }
});

test("gateway start quarantines malformed stale state before launching", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-stale-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const paths = resolveRefineryPaths({ home, cwd: project });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(paths.gatewayDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.gatewayStatePath, "{not-valid-json\n", { mode: 0o600 });

  const started = await startGateway({ home, project });
  try {
    assert.equal(started.running, true);
    assert.equal(started.staleRecovered, true);
    assert.equal(fs.readdirSync(paths.gatewayDir).some((entry) => entry.startsWith("state.json.stale-")), true);
  } finally {
    await stopGateway({ home, project });
  }
});

test("concurrent gateway starts converge on one owned daemon", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-concurrent-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });

  const [first, second] = await Promise.all([
    startGateway({ home, project }),
    startGateway({ home, project }),
  ]);
  try {
    assert.equal(first.running, true);
    assert.equal(second.running, true);
    assert.equal(first.publicState?.instanceId, second.publicState?.instanceId);
    assert.equal(first.publicState?.pid, second.publicState?.pid);
    assert.equal(Number(Boolean(first.alreadyRunning)) + Number(Boolean(second.alreadyRunning)), 1);
    const paths = resolveRefineryPaths({ home, cwd: project });
    assert.equal(fs.existsSync(path.join(paths.gatewayDir, "lifecycle.lock")), false);
  } finally {
    await stopGateway({ home, project });
  }
});

test("gateway start quarantines an abandoned lifecycle lock without signalling its recorded pid", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-start-lock-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const paths = resolveRefineryPaths({ home, cwd: project });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(paths.gatewayDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(paths.gatewayDir, "lifecycle.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({ nonce: "abandoned", pid: 1, createdAt: "2000-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  const started = await startGateway({ home, project });
  try {
    assert.equal(started.running, true);
    assert.equal(fs.readdirSync(paths.gatewayDir).some((entry) => entry.startsWith("lifecycle.lock.stale-")), true);
  } finally {
    await stopGateway({ home, project });
  }
});

test("concurrent gateway start and stop converge on a stopped daemon", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-start-stop-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });

  const starting = startGateway({ home, project });
  const stopping = stopGateway({ home, project });
  const [started, stopped] = await Promise.all([starting, stopping]);

  assert.equal(started.running, true);
  assert.equal(stopped.running, false);
  assert.equal((await gatewayStatus({ home, project })).running, false);
});

test("gateway daemon environment excludes preload hooks and credentials", () => {
  const environment = buildGatewayEnvironment({
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    NODE_OPTIONS: "--require /tmp/untrusted.cjs",
    NODE_PATH: "/tmp/untrusted-modules",
    CORAL_API_KEY: "secret",
    REFINERY_HOME: "/tmp/refinery",
  });

  assert.deepEqual(environment, { PATH: "/usr/bin", LANG: "en_US.UTF-8", TZ: "UTC" });
});
