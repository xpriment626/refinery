import assert from "node:assert/strict";
import test from "node:test";
import { handleMessage } from "./mcp.ts";

function callTool(name: string, args: Record<string, unknown> = {}) {
  const raw = handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.ok(raw);
  return JSON.parse(raw) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
}

test("core MCP lists storage-agnostic specialist contracts", () => {
  const raw = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(raw);
  const parsed = JSON.parse(raw) as { result: { tools: { name: string }[] } };

  assert.deepEqual(
    parsed.result.tools.map((tool) => tool.name),
    [
      "refinery_list_specialists",
      "refinery_get_specialist_contract",
      "refinery_build_specialist_prompt",
    ],
  );
});

test("core MCP builds prompt pairs without storage inputs", () => {
  const response = callTool("refinery_build_specialist_prompt", {
    name: "claim-scout",
    input: { source_chunks: [{ text: "Remember this design decision." }] },
  });

  assert.equal(response.error, undefined);
  const content = response.result?.structuredContent;
  assert.equal(content?.specialist, "claim-scout");
  assert.match(String(content?.system), /You are the Claim Scout/);
  assert.match(String(content?.user), /Remember this design decision/);
});
