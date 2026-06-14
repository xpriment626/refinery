import assert from "node:assert/strict";
import test from "node:test";
import {
  refineryModuleDescriptorSchemaVersion,
  validateRefineryModuleDescriptor,
} from "./modules.ts";

test("validateRefineryModuleDescriptor accepts minimal module descriptors", () => {
  const result = validateRefineryModuleDescriptor({
    schemaVersion: refineryModuleDescriptorSchemaVersion,
    kind: "runtime",
    name: "refinery-mastra-runtime",
    version: "0.0.1",
    entrypoint: "./dist/index.js",
    capabilities: ["review.live"],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.descriptor?.kind, "runtime");
});

test("validateRefineryModuleDescriptor rejects invalid descriptors without loading modules", () => {
  const result = validateRefineryModuleDescriptor({
    schemaVersion: "refinery.module.v0",
    kind: "coral",
    name: "",
    version: 1,
    entrypoint: null,
    capabilities: ["review.live", 42],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /schemaVersion/);
  assert.match(result.errors.join("\n"), /kind/);
  assert.match(result.errors.join("\n"), /name/);
  assert.match(result.errors.join("\n"), /version/);
  assert.match(result.errors.join("\n"), /entrypoint/);
  assert.match(result.errors.join("\n"), /capabilities\[1\]/);
});
