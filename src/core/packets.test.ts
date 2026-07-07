import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReviewPacket, parseSourceSpec } from "./packets.ts";

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
    sourceLimit: 5,
  });

  assert.equal(packet.documents.length, 1);
  assert.match(packet.documents[0].text, /release-check workflow/);
  assert.match(packet.documents[0].text, /exec_command: 1/);
  assert.doesNotMatch(packet.documents[0].text, /DO NOT INCLUDE BASE INSTRUCTIONS/);
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
