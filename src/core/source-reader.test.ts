import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceSpec } from "./packets.ts";
import { readSourceCorpusIsolated } from "./source-reader.ts";

test("isolated source reader can read selected sources but cannot write files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-source-reader-"));
  const sourcePath = path.join(tmp, "selected.md");
  const deniedWritePath = path.join(tmp, "reader-must-not-write.txt");
  fs.writeFileSync(sourcePath, "# Selected source\n\nRead-only evidence.");

  const result = await readSourceCorpusIsolated({
    sourceSpecs: [parseSourceSpec(`file:${sourcePath}`)],
    project: tmp,
    scope: "project",
    limits: {
      sourceLimit: 3,
      sourceCharLimit: 6_000,
      documentCharLimit: 8_000,
      activeMemoryLimit: 50,
    },
    now: new Date("2026-07-11T00:00:00.000Z"),
  }, {
    writeProbePath: deniedWritePath,
    timeoutMs: 10_000,
  });

  assert.equal(result.corpus.documents.length, 1);
  assert.match(result.corpus.documents[0]?.text ?? "", /Read-only evidence/);
  assert.equal(result.isolation.processSeparated, true);
  assert.equal(result.isolation.permissionModel, true);
  assert.equal(result.isolation.writeProbeDenied, true);
  assert.equal(fs.existsSync(deniedWritePath), false);
});
