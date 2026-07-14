import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSessionStream } from "./codex-session-parser.ts";

test("responsibility unit ids stay unique when repeated goals share no timestamp", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-session-unit-id-"));
  const sessionPath = path.join(tmp, "rollout-repeated.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "repeated", cwd: tmp } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Repeat this goal." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "First outcome." }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Repeat this goal." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Second outcome." }] } },
  ];
  fs.writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const indexed = await parseSessionStream(sessionPath);

  assert.equal(indexed.units.length, 2);
  assert.equal(new Set(indexed.units.map((unit) => unit.id)).size, 2);
  assert.deepEqual(indexed.units.map((unit) => unit.startLine), [2, 4]);
});
