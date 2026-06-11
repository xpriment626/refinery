import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePaths } from "./config.ts";

test("resolvePaths defaults the local instance home to the caller working directory", () => {
  const cwd = path.join("/tmp", "refinery-caller");

  const paths = resolvePaths({ cwd, env: {} });

  assert.equal(paths.home, path.join(cwd, ".refinery"));
  assert.equal(paths.dbPath, path.join(cwd, ".refinery", "refinery.db"));
  assert.equal(paths.rawDir, path.join(cwd, ".refinery", "raw"));
});

test("resolvePaths lets REFINERY_HOME override the caller working directory", () => {
  const cwd = path.join("/tmp", "refinery-caller");
  const home = path.join("/tmp", "refinery-explicit-home");

  const paths = resolvePaths({ cwd, env: { REFINERY_HOME: home } });

  assert.equal(paths.home, home);
  assert.equal(paths.dbPath, path.join(home, "refinery.db"));
  assert.equal(paths.rawDir, path.join(home, "raw"));
});
