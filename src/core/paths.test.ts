import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectKeyForPath, resolveRefineryPaths } from "./paths.ts";

test("resolveRefineryPaths defaults to globally organized project runs", () => {
  const cwd = path.join(os.tmpdir(), "refinery-paths-project");
  const paths = resolveRefineryPaths({ cwd, env: {} });
  const projectKey = projectKeyForPath(cwd);

  assert.equal(paths.home, path.join(os.homedir(), ".refinery"));
  assert.equal(paths.configDir, path.join(os.homedir(), ".refinery", "config"));
  assert.equal(paths.credentialsDir, path.join(os.homedir(), ".refinery", "credentials"));
  assert.equal(paths.runsRootDir, path.join(os.homedir(), ".refinery", "runs"));
  assert.equal(paths.projectKey, projectKey);
  assert.equal(paths.runsDir, path.join(os.homedir(), ".refinery", "runs", "by-project", projectKey));
  assert.equal(paths.cataloguesDir, path.join(os.homedir(), ".refinery", "catalogues"));
  assert.equal(paths.sessionCataloguePath, path.join(paths.cataloguesDir, "codex-sessions.db"));
  assert.equal(paths.graphsDir, path.join(os.homedir(), ".refinery", "graphs", "by-project", projectKey));
  assert.equal(paths.graphIndexPath, path.join(paths.graphsDir, "memory-graph.db"));
  assert.equal(paths.legacyGraphIndexPath, path.join(paths.graphsDir, "memory-graph.json"));
  assert.equal(paths.gatewayDir, path.join(os.homedir(), ".refinery", "gateway"));
  assert.equal(paths.gatewayStatePath, path.join(paths.gatewayDir, "state.json"));
  assert.equal(paths.gatewayLogPath, path.join(paths.gatewayDir, "gateway.jsonl"));
  assert.equal(paths.uiConfigPath, path.join(paths.configDir, "ui.json"));
  assert.equal(paths.setupDir, path.join(os.homedir(), ".refinery", "setup", "by-project", projectKey));
  assert.equal(paths.setupStatePath, path.join(paths.setupDir, "state.json"));
  assert.equal(paths.setupReceiptPath, path.join(paths.setupDir, "receipt.json"));
  assert.equal(paths.runtimeDir, path.join(os.homedir(), ".refinery", "runtime"));
  assert.equal(paths.coralRuntimeRootDir, path.join(paths.runtimeDir, "coral"));
  assert.deepEqual(Object.keys(paths).sort(), [
    "cataloguesDir",
    "configDir",
    "coralRuntimeRootDir",
    "credentialsDir",
    "gatewayDir",
    "gatewayLogPath",
    "gatewayStatePath",
    "graphIndexPath",
    "graphsDir",
    "home",
    "legacyGraphIndexPath",
    "projectKey",
    "runsDir",
    "runsRootDir",
    "runtimeDir",
    "sessionCataloguePath",
    "setupDir",
    "setupReceiptPath",
    "setupStatePath",
    "uiConfigPath",
  ]);
});

test("resolveRefineryPaths honors REFINERY_HOME and expands home paths", () => {
  const paths = resolveRefineryPaths({
    cwd: "/tmp/ignored",
    env: { REFINERY_HOME: "~/.refinery-test" },
  });

  assert.equal(paths.home, path.join(os.homedir(), ".refinery-test"));
  assert.equal(paths.runsDir, path.join(os.homedir(), ".refinery-test", "runs", "by-project", projectKeyForPath("/tmp/ignored")));
});

test("resolveRefineryPaths resolves explicit relative home against the project", () => {
  const cwd = path.join(os.tmpdir(), "refinery-relative-home");
  const paths = resolveRefineryPaths({ cwd, home: ".refinery", env: {} });

  assert.equal(paths.home, path.join(cwd, ".refinery"));
  assert.equal(paths.runsDir, path.join(cwd, ".refinery", "runs", "by-project", projectKeyForPath(cwd)));
});
