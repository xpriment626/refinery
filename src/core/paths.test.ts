import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRefineryPaths } from "./paths.ts";

test("resolveRefineryPaths keeps the local instance focused on review trials", () => {
  const cwd = path.join(os.tmpdir(), "refinery-paths-project");
  const paths = resolveRefineryPaths({ cwd, env: {} });

  assert.equal(paths.home, path.join(cwd, ".refinery"));
  assert.equal(paths.trialsDir, path.join(cwd, ".refinery", "trials"));
  assert.deepEqual(Object.keys(paths).sort(), ["home", "trialsDir"]);
});

test("resolveRefineryPaths honors REFINERY_HOME and expands home paths", () => {
  const paths = resolveRefineryPaths({
    cwd: "/tmp/ignored",
    env: { REFINERY_HOME: "~/.refinery-test" },
  });

  assert.equal(paths.home, path.join(os.homedir(), ".refinery-test"));
  assert.equal(paths.trialsDir, path.join(os.homedir(), ".refinery-test", "trials"));
});
