import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexMemoryAdapter, resolveCodexMemoryHome } from "./codex-memory.ts";

function seedCodexMemoryHome(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-codex-memory-"));
  const home = path.join(tmp, "memories");
  fs.mkdirSync(path.join(home, "rollout_summaries"), { recursive: true });
  fs.mkdirSync(path.join(home, "extensions/ad_hoc/notes"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "MEMORY.md"),
    [
      "# Task Group: Research-Desk / refinery CLI module-ready substrate and release hygiene",
      "",
      "scope: Use when working on Refinery CLI contracts.",
      "applies_to: cwd=/Users/bambozlor/Lab/Research-Desk/refinery",
      "",
      "### rollout_summary_files",
      "",
      "- rollout_summaries/2026-06-10T13-09-48-UPI5-refinery_cli_module_ready_lifecycle_aware.md (cwd=/Users/bambozlor/Lab/Research-Desk, rollout_path=/Users/bambozlor/.codex/sessions/2026/06/10/rollout-2026-06-10T21-09-48-019eb1a7-4054-7f51-9cea-484e208390f9.jsonl, updated_at=2026-06-14T14:24:07+00:00, thread_id=019eb1a7-4054-7f51-9cea-484e208390f9, success)",
      "",
      "## User preferences",
      "",
      "- when the goal required downstream modules to work without undocumented conventions -> prefer machine-readable contracts [Task 1]",
      "",
      "## Reusable knowledge",
      "",
      "- Every review run writes a canonical `manifest.json` on both success and failure paths [Task 1]",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "memory_summary.md"),
    [
      "v1",
      "",
      "## User preferences",
      "",
      "- For Refinery contracts, prefer machine-readable outputs without undocumented conventions.",
      "",
      "## What's in Memory",
      "",
      "### /Users/bambozlor/Lab/Research-Desk",
      "",
      "- refinery CLI module-ready substrate and release hygiene: `manifest.json`, `trial inspect`, `module check`",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "rollout_summaries/2026-06-10T13-09-48-UPI5-refinery_cli_module_ready_lifecycle_aware.md"),
    [
      "thread_id: 019eb1a7-4054-7f51-9cea-484e208390f9",
      "updated_at: 2026-06-14T14:24:07+00:00",
      "rollout_path: /Users/bambozlor/.codex/sessions/2026/06/10/rollout-2026-06-10T21-09-48-019eb1a7-4054-7f51-9cea-484e208390f9.jsonl",
      "cwd: /Users/bambozlor/Lab/Research-Desk",
      "",
      "# Refinery was hardened into a module-ready CLI substrate",
      "",
      "Reusable knowledge:",
      "",
      "- The stable machine-facing CLI surfaces are `review`, `trial inspect`, and `module check`.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "extensions/ad_hoc/notes/2026-06-10T10-21-01-openstrat-pi-openclaw-intent.md"),
    "OpenStrat should preserve Pi as the substrate while keeping product boundaries narrow.\n",
  );
  return home;
}

test("resolveCodexMemoryHome defaults to the user's bounded memories directory", () => {
  assert.equal(resolveCodexMemoryHome(), path.join(os.homedir(), ".codex", "memories"));
});

test("Codex memory adapter parses memory index, summaries, rollout metadata, and ad hoc notes", async () => {
  const memoryHome = seedCodexMemoryHome();
  const adapter = createCodexMemoryAdapter({ memoryHome });

  const sources = await adapter.listSourceEvidence({ scope: "project", limit: 10 });
  const memories = await adapter.listActiveMemories({ scope: "project", limit: 10 });

  assert.equal(adapter.name, "codex-memory");
  assert.equal(sources.length, 4);
  assert.equal(memories.length >= 4, true);
  assert.equal(sources.every((source) => source.id.startsWith("codex-source:")), true);
  assert.equal(memories.every((memory) => memory.id.startsWith("codex-memory:")), true);
  assert.equal(memories.every((memory) => memory.status === "active"), true);

  const memoryIndex = sources.find((source) => source.path === "MEMORY.md");
  assert.ok(memoryIndex);
  assert.equal(memoryIndex.kind, "codex-memory-index");
  assert.equal(memoryIndex.metadata?.originKind, "memory-index");

  const rollout = sources.find((source) => source.kind === "codex-rollout-summary");
  assert.ok(rollout);
  assert.equal(rollout.metadata?.threadId, "019eb1a7-4054-7f51-9cea-484e208390f9");
  assert.equal(rollout.metadata?.updatedAt, "2026-06-14T14:24:07+00:00");

  const preference = memories.find((memory) => memory.body.includes("prefer machine-readable contracts"));
  assert.ok(preference);
  assert.equal(preference.type, "operational");
  assert.equal(preference.scope, "project");
  assert.equal(preference.provenance?.originKind, "memory-index");

  const found = await adapter.searchActiveMemories({ scope: "project", query: "manifest", limit: 5 });
  assert.equal(found.some((memory) => memory.body.includes("manifest.json")), true);
  assert.deepEqual(await adapter.getActiveMemory({ scope: "project", id: preference.id }), preference);
});

test("Codex memory adapter rejects missing or unsafe memory homes", async () => {
  const missing = createCodexMemoryAdapter({
    memoryHome: path.join(os.tmpdir(), "refinery-missing-codex-memory", "memories"),
  });
  await assert.rejects(
    () => missing.listSourceEvidence({ scope: "project" }),
    /Codex memory home does not exist/,
  );

  assert.throws(
    () => createCodexMemoryAdapter({ memoryHome: path.join(os.tmpdir(), "refinery-not-codex") }),
    /memoryHome must point to a directory named memories/,
  );
});
