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
  assert.deepEqual(Object.keys(paths).sort(), [
    "configDir",
    "credentialsDir",
    "home",
    "projectKey",
    "runsDir",
    "runsRootDir",
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
