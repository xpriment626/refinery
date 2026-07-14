import assert from "node:assert/strict";
import test from "node:test";
import { parseCapabilityFragment } from "./capability.ts";

test("capability fragments are decoded without retaining secrets in the visible URL", () => {
  assert.deepEqual(parseCapabilityFragment("#cap=local%20secret&view=graph"), {
    capability: "local secret",
    sanitizedFragment: "#view=graph",
  });
  assert.deepEqual(parseCapabilityFragment("#view=graph"), {
    capability: null,
    sanitizedFragment: "#view=graph",
  });
});
