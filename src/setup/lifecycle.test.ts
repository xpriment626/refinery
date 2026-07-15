import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRefineryPaths } from "../core/paths.ts";
import { setupLifecycleStatus, startSetupLifecycle, stopSetupLifecycle } from "./lifecycle.ts";

test("setup lifecycle starts one private loopback capability server, redacts status, and stops cleanly", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-lifecycle-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const codexHome = path.join(tmp, "codex");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  const options = { home, project, codexHome, ttlMs: 60_000, env: { ...process.env, CODEX_HOME: codexHome } };
  const started = await startSetupLifecycle(options);
  try {
    assert.equal(started.running, true);
    assert.match(String(started.url), /^http:\/\/127\.0\.0\.1:\d+\/#cap=/);
    const capability = new URL(String(started.url)).hash.slice("#cap=".length);
    const stateText = fs.readFileSync(resolveRefineryPaths({ home, cwd: project }).setupStatePath, "utf8");
    assert.doesNotMatch(stateText, new RegExp(capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (process.platform !== "win32") {
      const paths = resolveRefineryPaths({ home, cwd: project });
      assert.equal(fs.statSync(paths.setupDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(paths.setupStatePath).mode & 0o777, 0o600);
    }
    const status = await setupLifecycleStatus(options);
    assert.equal(status.running, true);
    assert.equal("url" in status, false);
    assert.equal("capabilityHash" in status, false);
    const page = await fetch(String(started.url).split("/#", 1)[0]!);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(page.headers.get("access-control-allow-origin"), null);
  } finally {
    const stopped = await stopSetupLifecycle(options);
    assert.equal(stopped.running, false);
    assert.equal((await setupLifecycleStatus(options)).running, false);
  }
});

test("the setup listener cannot outlive its owning daemon process", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-owner-loss-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  const options = { home, project, ttlMs: 60_000, env: process.env };
  const started = await startSetupLifecycle(options);
  const origin = String(started.url).split("/#", 1)[0]!;
  const status = await setupLifecycleStatus(options) as { pid?: number };
  assert.equal(typeof status.pid, "number");
  process.kill(status.pid!, "SIGTERM");
  let recovered: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    recovered = await setupLifecycleStatus(options);
    if (recovered.running === false) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(recovered.running, false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test("setup start quarantines malformed stale state without signalling its recorded pid", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-stale-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  const paths = resolveRefineryPaths({ home, cwd: project });
  fs.mkdirSync(path.dirname(paths.setupStatePath), { recursive: true });
  fs.writeFileSync(paths.setupStatePath, JSON.stringify({ pid: process.pid, malformed: true }));
  const options = { home, project, ttlMs: 60_000, env: process.env };
  const started = await startSetupLifecycle(options);
  try {
    assert.equal(started.running, true);
    assert.equal(fs.readdirSync(paths.setupDir).some((name) => name.includes(".stale-")), true);
  } finally {
    await stopSetupLifecycle(options);
  }
});
