import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoundedGatewayLogger } from "./logging.ts";

test("gateway logger rotates continuously and keeps private bounded files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-log-"));
  const logPath = path.join(tmp, "private", "gateway.jsonl");
  const log = createBoundedGatewayLogger(logPath, { maxBytes: 512 });

  for (let index = 0; index < 40; index += 1) {
    log("info", "bounded-log-test", { index, message: "x".repeat(80) });
  }

  const backupPath = `${logPath}.1`;
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.statSync(logPath).size <= 512, true);
  assert.equal(fs.statSync(backupPath).size <= 512, true);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});
