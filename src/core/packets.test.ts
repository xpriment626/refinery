import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReviewPacket, loadSourceCorpus, parseSourceSpec } from "./packets.ts";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("codex sessions loader builds bounded summaries without base instructions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-packet-sessions-"));
  const sessionsDir = path.join(tmp, "sessions");
  const project = path.join(tmp, "project");
  const filePath = path.join(sessionsDir, "2026/07/06/rollout-2026-07-06T01-00-00-session-a.jsonl");
  writeJsonl(filePath, [
    {
      timestamp: "2026-07-06T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-a",
        timestamp: "2026-07-06T01:00:00.000Z",
        cwd: project,
        base_instructions: { text: "DO NOT INCLUDE BASE INSTRUCTIONS" },
      },
    },
    {
      timestamp: "2026-07-06T01:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "We keep repeating the release-check workflow." }],
      },
    },
    {
      timestamp: "2026-07-06T01:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final",
        content: [{ type: "output_text", text: "The release-check workflow needs a reusable skill." }],
      },
    },
    {
      timestamp: "2026-07-06T01:03:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm run typecheck" }),
      },
    },
  ]);
  writeJsonl(path.join(sessionsDir, "2026/07/06/rollout-2026-07-06T01-00-00-session-b.jsonl"), [
    {
      timestamp: "2026-07-06T01:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-b", cwd: path.join(tmp, "other") },
    },
  ]);

  const packet = await buildReviewPacket({
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&project=${encodeURIComponent(project)}`)],
    targets: ["codex:memories"],
    project,
    scope: "project",
    intent: "session-recurrence",
    request: null,
    home: path.join(tmp, "refinery-home"),
    sourceLimit: 5,
  });

  assert.equal(packet.documents.length, 1);
  assert.match(packet.documents[0].text, /release-check workflow/);
  assert.match(packet.documents[0].text, /exec_command: 1/);
  assert.doesNotMatch(packet.documents[0].text, /DO NOT INCLUDE BASE INSTRUCTIONS/);
  assert.deepEqual((packet as typeof packet & { sourceIsolation?: Record<string, unknown> }).sourceIsolation, {
    processSeparated: true,
    permissionModel: true,
  });
});

test("codex skills loader reads skill files and skips plugin cache", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-packet-skills-"));
  const skillPath = path.join(tmp, "release-check/SKILL.md");
  const pluginSkillPath = path.join(tmp, "plugins/cache/plugin-skill/SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(pluginSkillPath), { recursive: true });
  fs.writeFileSync(skillPath, "---\nname: release-check\n---\n# Release Check\n");
  fs.writeFileSync(pluginSkillPath, "---\nname: plugin-skill\n---\n# Plugin Skill\n");

  const packet = await buildReviewPacket({
    sourceSpecs: [parseSourceSpec(`codex:skills?home=${encodeURIComponent(tmp)}`)],
    targets: ["codex:skills"],
    project: tmp,
    scope: "project",
    intent: "skill-promotion-audit",
    request: null,
    sourceLimit: 10,
  });

  assert.equal(packet.documents.length, 1);
  assert.equal(packet.documents[0].role, "codex-skill");
  assert.match(packet.documents[0].text, /Release Check/);
  assert.doesNotMatch(packet.documents[0].text, /Plugin Skill/);
  assert.deepEqual(packet.targets, ["codex:skills"]);
});

test("root-scoped memory sources emit only explicitly mapped project records", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-root-memories-"));
  const memoryHome = path.join(tmp, "memories");
  const labRoot = path.join(tmp, "Lab");
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), [
    "# Lab task",
    `applies_to: cwd=${path.join(labRoot, "refinery")}`,
    "- LAB_SCOPED_MEMORY",
    "# Other task",
    `applies_to: cwd=${path.join(tmp, "other")}`,
    "- OTHER_SCOPED_MEMORY",
    "# Global task",
    "- GLOBAL_MEMORY",
    "",
  ].join("\n"));

  const packet = await buildReviewPacket({
    sourceSpecs: [parseSourceSpec(`codex:memories?root=${encodeURIComponent(labRoot)}`)],
    targets: ["codex:memories"],
    project: labRoot,
    scope: "project",
    intent: "root-memory-filter",
    request: null,
    memoryHome,
    sourceLimit: 10,
  });
  assert.equal(packet.documents.length, 1);
  assert.equal(packet.documents[0]?.role, "codex-memory-record");
  assert.match(packet.documents[0]?.text ?? "", /LAB_SCOPED_MEMORY/);
  assert.doesNotMatch(JSON.stringify(packet), /OTHER_SCOPED_MEMORY|GLOBAL_MEMORY/);
  assert.equal(packet.counts.activeMemoryHints, 1);
});

test("root-scoped memory sources apply independent document and active-memory bounds", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-root-memory-limits-"));
  const memoryHome = path.join(tmp, "memories");
  const labRoot = path.join(tmp, "Lab");
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), [
    "# Lab task",
    `applies_to: cwd=${path.join(labRoot, "refinery")}`,
    "- MEMORY_ONE",
    "- MEMORY_TWO",
    "- MEMORY_THREE",
    "",
  ].join("\n"));

  const packet = await buildReviewPacket({
    sourceSpecs: [parseSourceSpec(`codex:memories?root=${encodeURIComponent(labRoot)}`)],
    targets: ["codex:memories"],
    project: labRoot,
    scope: "project",
    intent: "root-memory-limits",
    request: null,
    memoryHome,
    sourceLimit: 2,
    activeMemoryLimit: 1,
  });
  assert.equal(packet.documents.length, 2);
  assert.equal(packet.counts.activeMemoryHints, 1);
});

test("graph corpus loading can read complete Codex source text outside prompt-facing packet limits", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-corpus-"));
  const memoryHome = path.join(tmp, "memories");
  fs.mkdirSync(memoryHome, { recursive: true });
  const marker = "GRAPH_CORPUS_END_MARKER";
  fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), `# Memory\n\n- ${"x".repeat(9_000)}${marker}\n`);

  const corpus = await loadSourceCorpus({
    sourceSpecs: [parseSourceSpec("codex:memories")],
    project: tmp,
    scope: "project",
    memoryHome,
    limits: {
      sourceLimit: 100,
      sourceCharLimit: 100_000,
      documentCharLimit: 20_000,
      activeMemoryLimit: 1_000,
    },
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  assert.equal(corpus.documents.length, 1);
  assert.match(corpus.documents[0]?.text ?? "", new RegExp(marker));
  assert.equal(corpus.activeMemories.length, 1);
});
