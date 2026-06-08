import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";

const node24 = process.execPath;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-mcp-"));
  const db = openDb({
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  });
  db.prepare(
    `INSERT INTO project (id, root_path, encoded_path, created_at)
     VALUES (1, '/tmp/fabrick', '-tmp-fabrick', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO memory
       (id, project_id, type, scope, status, body, confidence, provenance_kind, created_at)
     VALUES
       (1, 1, 'semantic', 'project', 'active', 'Fabrick uses governed memory proposals before activation.', 0.88, 'refinery-proposal', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.close();
  return home;
}

function callMcp(home: string, message: object): any {
  const res = spawnSync(node24, ["mcp.ts"], {
    cwd: import.meta.dirname,
    env: { ...process.env, REFINERY_HOME: home },
    input: JSON.stringify(message) + "\n",
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.trim().split("\n").at(-1);
  assert.ok(line);
  return JSON.parse(line);
}

test("MCP server lists the three Stage A read tools", () => {
  const response = callMcp(makeHome(), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });

  assert.equal(response.id, 1);
  assert.deepEqual(
    response.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["refinery_get_memory", "refinery_get_project_context", "refinery_search_memory"],
  );
});

test("MCP server calls refinery_get_project_context", () => {
  const response = callMcp(makeHome(), {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "refinery_get_project_context",
      arguments: { query: "governed memory" },
    },
  });

  assert.equal(response.id, 2);
  assert.equal(response.result.content[0].type, "text");
  assert.match(response.result.content[0].text, /Fabrick uses governed memory proposals/);
  assert.equal(response.result.structuredContent.supporting_memories.length, 1);
});
