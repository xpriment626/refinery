import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listCodexActiveMemories,
  listCodexMemorySourceDocuments,
  resolveCodexMemoryHome,
} from "./codex-memories.ts";

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
      "applies_to: cwd=/Users/example/Lab/Research-Desk/refinery",
      "",
      "### rollout_summary_files",
      "",
      "- rollout_summaries/2026-06-10T13-09-48-UPI5-refinery_cli_module_ready_lifecycle_aware.md (cwd=/Users/example/Lab/Research-Desk, rollout_path=/Users/example/.codex/sessions/2026/06/10/rollout-2026-06-10T21-09-48-019eb1a7-4054-7f51-9cea-484e208390f9.jsonl, updated_at=2026-06-14T14:24:07+00:00, thread_id=019eb1a7-4054-7f51-9cea-484e208390f9, success)",
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
      "### /Users/example/Lab/Research-Desk",
      "",
      "- refinery Codex-first CLI substrate and release hygiene: `doctor`, `review`, `manifest.json`, `trial inspect`",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "rollout_summaries/2026-06-10T13-09-48-UPI5-refinery_cli_module_ready_lifecycle_aware.md"),
    [
      "thread_id: 019eb1a7-4054-7f51-9cea-484e208390f9",
      "updated_at: 2026-06-14T14:24:07+00:00",
      "rollout_path: /Users/example/.codex/sessions/2026/06/10/rollout-2026-06-10T21-09-48-019eb1a7-4054-7f51-9cea-484e208390f9.jsonl",
      "cwd: /Users/example/Lab/Research-Desk",
      "",
      "# Refinery was hardened into a Codex-first CLI substrate",
      "",
      "Reusable knowledge:",
      "",
      "- The stable machine-facing CLI surfaces are `doctor`, `review`, and `trial inspect`.",
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
  assert.equal(
    resolveCodexMemoryHome(undefined, { CODEX_HOME: path.join(os.tmpdir(), "alternate-codex") }),
    path.join(os.tmpdir(), "alternate-codex", "memories"),
  );
});

test("Codex memory source reader parses memory index, summaries, rollout metadata, and ad hoc notes", () => {
  const memoryHome = seedCodexMemoryHome();
  const sources = listCodexMemorySourceDocuments({ memoryHome, limit: 10 });
  const memories = listCodexActiveMemories({ memoryHome, limit: 10 });

  assert.equal(sources.length, 4);
  assert.equal(memories.length >= 4, true);
  assert.equal(sources.every((source) => source.id.startsWith("codex-source:")), true);
  assert.equal(memories.every((memory) => memory.id.startsWith("codex-memory:")), true);
  assert.equal(memories.every((memory) => memory.status === "active"), true);

  const memoryIndex = sources.find((source) => source.relPath === "MEMORY.md");
  assert.ok(memoryIndex);
  assert.equal(memoryIndex.role, "codex-memory-index");
  assert.equal(memoryIndex.metadata.originKind, "memory-index");
  assert.equal("cwd" in memoryIndex.metadata, false);
  assert.equal("threadId" in memoryIndex.metadata, false);

  const rollout = sources.find((source) => source.role === "codex-rollout-summary");
  assert.ok(rollout);
  assert.equal(rollout.metadata.threadId, "019eb1a7-4054-7f51-9cea-484e208390f9");
  assert.equal(rollout.metadata.updatedAt, "2026-06-14T14:24:07+00:00");

  const preference = memories.find((memory) => memory.body.includes("prefer machine-readable contracts"));
  assert.ok(preference);
  assert.equal(preference.type, "operational");
  assert.equal(preference.scope, "project");
  assert.equal(preference.provenance?.originKind, "memory-index");
  assert.equal(preference.provenance?.projectPath, "/Users/example/Lab/Research-Desk/refinery");
  assert.equal(preference.provenance?.threadId, null);
  const rolloutReference = memories.find((memory) => memory.body.startsWith("rollout_summaries/"));
  assert.ok(rolloutReference);
  assert.equal(rolloutReference.provenance?.threadId, "019eb1a7-4054-7f51-9cea-484e208390f9");
  const globalPreference = memories.find((memory) => memory.body.startsWith("For Refinery contracts"));
  assert.ok(globalPreference);
  assert.equal(globalPreference.scope, "global");
  assert.equal(globalPreference.provenance?.projectPath, null);
  assert.equal(memories.some((memory) => memory.body.includes("manifest.json")), true);
});

test("Codex memory source reader rejects missing or unsafe memory homes", () => {
  assert.throws(
    () => listCodexMemorySourceDocuments({
      memoryHome: path.join(os.tmpdir(), "refinery-missing-codex-memory", "memories"),
    }),
    /Codex memory home does not exist/,
  );

  assert.throws(
    () => listCodexMemorySourceDocuments({ memoryHome: path.join(os.tmpdir(), "refinery-not-codex") }),
    /memoryHome must point to a directory named memories/,
  );
});
