import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "libsql";
import { buildReviewPacket, parseSourceSpec } from "../core/packets.ts";
import { resolveRefineryPaths } from "../core/paths.ts";
import { searchSessionResponsibilityUnits } from "./codex-session-catalogue.ts";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function message(timestamp: string, role: "user" | "assistant", text: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(role === "assistant" ? { phase: "final" } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

function diagnostics(packet: Awaited<ReturnType<typeof buildReviewPacket>>): Record<string, number> {
  return packet.sourceSets[0]?.metadata.catalogue as Record<string, number>;
}

test("incremental session catalogue excludes foreign and mixed-scope content before responsibility extraction", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-session-catalogue-"));
  const sessionsDir = path.join(tmp, "sessions");
  const refineryHome = path.join(tmp, "refinery-home");
  const labRoot = path.join(tmp, "Lab");
  const project = path.join(labRoot, "refinery");
  const outside = path.join(tmp, "outside");
  const selectedPath = path.join(sessionsDir, "2026/07/14/rollout-selected.jsonl");
  writeJsonl(selectedPath, [
    { timestamp: "2026-07-14T01:00:00.000Z", type: "session_meta", payload: { id: "selected", cwd: project } },
    message("2026-07-14T01:01:00.000Z", "user", "Diagnose the recurring release failure."),
    message("2026-07-14T01:02:00.000Z", "assistant", "The release failure is caused by a stale manifest."),
    {
      timestamp: "2026-07-14T01:03:00.000Z",
      type: "compacted",
      payload: { replacement_history: "PRIVATE_REPLACEMENT_HISTORY".repeat(5_000) },
    },
    message("2026-07-14T01:04:00.000Z", "user", "Implement and verify the manifest repair."),
    {
      timestamp: "2026-07-14T01:05:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: "{}" },
    },
    {
      timestamp: "2026-07-14T01:06:00.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: JSON.stringify({ exit_code: 1, output: "PRIVATE_TOOL_OUTPUT" }) },
    },
    message("2026-07-14T01:07:00.000Z", "assistant", "The repair is implemented; the first verification exposed one remaining failure."),
  ]);
  writeJsonl(path.join(sessionsDir, "2026/07/14/rollout-foreign.jsonl"), [
    { timestamp: "2026-07-14T02:00:00.000Z", type: "session_meta", payload: { id: "foreign", cwd: outside } },
    message("2026-07-14T02:01:00.000Z", "user", "FOREIGN_SESSION_SECRET"),
  ]);
  writeJsonl(path.join(sessionsDir, "2026/07/14/rollout-mixed.jsonl"), [
    { timestamp: "2026-07-14T03:00:00.000Z", type: "session_meta", payload: { id: "mixed", cwd: project } },
    message("2026-07-14T03:01:00.000Z", "user", "MIXED_SESSION_SECRET"),
    { timestamp: "2026-07-14T03:02:00.000Z", type: "turn_context", payload: { cwd: outside } },
    message("2026-07-14T03:03:00.000Z", "assistant", "MIXED_SESSION_OUTCOME"),
  ]);

  const options = {
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(labRoot)}`)],
    targets: ["codex:memories" as const],
    project,
    scope: "project",
    intent: "session-index-test",
    request: null,
    home: refineryHome,
    sourceLimit: 10,
    now: new Date("2026-07-14T04:00:00.000Z"),
  };
  const first = await buildReviewPacket(options);
  assert.equal(first.documents.length, 2);
  assert.ok(first.documents.every((document) => document.role === "codex-session-responsibility-unit"));
  const allText = first.documents.map((document) => document.text).join("\n");
  assert.match(allText, /recurring release failure/);
  assert.match(allText, /exec_command: 1/);
  assert.match(allText, /tool result failed with exit code 1/);
  assert.doesNotMatch(allText, /FOREIGN_SESSION_SECRET|MIXED_SESSION_SECRET|PRIVATE_REPLACEMENT_HISTORY|PRIVATE_TOOL_OUTPUT/);
  assert.ok(first.documents.every((document) => !JSON.stringify(document.metadata).includes(sessionsDir)));
  assert.deepEqual(diagnostics(first), {
    schemaVersion: "refinery.session-catalogue-diagnostics.v1",
    candidateFiles: 3,
    cacheHits: 0,
    changedFiles: 3,
    requestedFiles: 3,
    headerScans: 1,
    scopeScans: 1,
    fullScans: 1,
    excludedBeforeContentRead: 1,
    mixedScopeRejected: 1,
    unchangedContentReads: 0,
    contentBytesRead: diagnostics(first).contentBytesRead,
    scopeBytesRead: diagnostics(first).scopeBytesRead,
    selectedUnits: 2,
    parseFailures: 0,
  });
  assert.ok(diagnostics(first).contentBytesRead > 0);
  assert.ok(diagnostics(first).scopeBytesRead > diagnostics(first).contentBytesRead);

  const stableIds = new Set(first.documents.map((document) => document.metadata.unitId));
  const second = await buildReviewPacket(options);
  assert.equal(second.documents.length, 2);
  assert.equal(diagnostics(second).cacheHits, 3);
  assert.equal(diagnostics(second).requestedFiles, 0);
  assert.equal(diagnostics(second).contentBytesRead, 0);
  assert.equal(diagnostics(second).scopeBytesRead, 0);
  assert.equal(diagnostics(second).unchangedContentReads, 0);

  fs.appendFileSync(selectedPath, `${JSON.stringify(message("2026-07-14T01:08:00.000Z", "user", "Verify the final release manifest."))}\n`);
  const third = await buildReviewPacket(options);
  assert.equal(diagnostics(third).changedFiles, 1);
  assert.equal(diagnostics(third).fullScans, 1);
  assert.equal(diagnostics(third).unchangedContentReads, 0);
  assert.ok(third.documents.some((document) => stableIds.has(document.metadata.unitId)));

  const cataloguePath = resolveRefineryPaths({ cwd: project, home: refineryHome }).sessionCataloguePath;
  const retrieved = searchSessionResponsibilityUnits({
    cataloguePath,
    request: "manifest repair verification",
    root: labRoot,
    limit: 10,
  });
  assert.ok(retrieved.some((result) => result.sessionId === "selected"));
  assert.deepEqual(searchSessionResponsibilityUnits({
    cataloguePath,
    request: "zznegativecontrolfixture",
    root: labRoot,
    limit: 10,
  }), []);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(cataloguePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(cataloguePath)).mode & 0o777, 0o700);
  }
});

test("a narrower root reuses unchanged full scans without content reads or catalogue downgrade", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-session-scope-cache-"));
  const sessionsDir = path.join(tmp, "sessions");
  const refineryHome = path.join(tmp, "refinery-home");
  const labRoot = path.join(tmp, "Lab");
  const project = path.join(labRoot, "refinery");
  const sibling = path.join(labRoot, "sibling");
  writeJsonl(path.join(sessionsDir, "rollout-selected.jsonl"), [
    { timestamp: "2026-07-14T01:00:00.000Z", type: "session_meta", payload: { id: "selected", cwd: project } },
    message("2026-07-14T01:01:00.000Z", "user", "Implement the selected project cache."),
    message("2026-07-14T01:02:00.000Z", "assistant", "The selected project cache is implemented."),
  ]);
  writeJsonl(path.join(sessionsDir, "rollout-sibling.jsonl"), [
    { timestamp: "2026-07-14T02:00:00.000Z", type: "session_meta", payload: { id: "sibling", cwd: sibling } },
    message("2026-07-14T02:01:00.000Z", "user", "Implement the sibling project cache."),
    message("2026-07-14T02:02:00.000Z", "assistant", "The sibling project cache is implemented."),
  ]);
  const common = {
    targets: ["codex:memories" as const],
    project,
    scope: "project",
    intent: "scope-cache-test",
    request: null,
    home: refineryHome,
    sourceLimit: 10,
    now: new Date("2026-07-14T04:00:00.000Z"),
  };
  const broad = await buildReviewPacket({
    ...common,
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(labRoot)}`)],
  });
  assert.equal(broad.documents.length, 2);
  assert.equal(diagnostics(broad).fullScans, 2);

  const narrow = await buildReviewPacket({
    ...common,
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(project)}`)],
  });
  assert.equal(narrow.documents.length, 1);
  assert.equal(diagnostics(narrow).cacheHits, 2);
  assert.equal(diagnostics(narrow).requestedFiles, 0);
  assert.equal(diagnostics(narrow).contentBytesRead, 0);
  assert.equal(diagnostics(narrow).unchangedContentReads, 0);
  assert.equal(diagnostics(narrow).excludedBeforeContentRead, 1);

  const broadAgain = await buildReviewPacket({
    ...common,
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(labRoot)}`)],
  });
  assert.equal(broadAgain.documents.length, 2);
  assert.equal(diagnostics(broadAgain).requestedFiles, 0);
  assert.equal(diagnostics(broadAgain).contentBytesRead, 0);
});

test("an incomplete full-scan marker triggers one repair read before becoming cacheable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-session-completeness-"));
  const sessionsDir = path.join(tmp, "sessions");
  const refineryHome = path.join(tmp, "refinery-home");
  const labRoot = path.join(tmp, "Lab");
  const project = path.join(labRoot, "refinery");
  writeJsonl(path.join(sessionsDir, "rollout-selected.jsonl"), [
    { timestamp: "2026-07-14T01:00:00.000Z", type: "session_meta", payload: { id: "repair", cwd: project } },
    message("2026-07-14T01:01:00.000Z", "user", "Repair a catalogue whose units were lost."),
    message("2026-07-14T01:02:00.000Z", "assistant", "The catalogue units are restored from source."),
  ]);
  const options = {
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(labRoot)}`)],
    targets: ["codex:memories" as const],
    project,
    scope: "project",
    intent: "catalogue-repair-test",
    request: null,
    home: refineryHome,
    sourceLimit: 10,
    now: new Date("2026-07-14T04:00:00.000Z"),
  };
  const initial = await buildReviewPacket(options);
  assert.equal(initial.documents.length, 1);

  const cataloguePath = resolveRefineryPaths({ cwd: project, home: refineryHome }).sessionCataloguePath;
  const database = new Database(cataloguePath);
  database.exec("DELETE FROM session_units; UPDATE session_files SET content_indexed = 0, unit_count = 0");
  database.close();

  const repaired = await buildReviewPacket(options);
  assert.equal(repaired.documents.length, 1);
  assert.equal(diagnostics(repaired).requestedFiles, 1);
  assert.equal(diagnostics(repaired).fullScans, 1);
  assert.equal(diagnostics(repaired).unchangedContentReads, 1);

  const cached = await buildReviewPacket(options);
  assert.equal(cached.documents.length, 1);
  assert.equal(diagnostics(cached).cacheHits, 1);
  assert.equal(diagnostics(cached).requestedFiles, 0);
  assert.equal(diagnostics(cached).contentBytesRead, 0);
  assert.equal(diagnostics(cached).unchangedContentReads, 0);
});

test("the session catalogue rejects a database created by a newer schema", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-session-newer-schema-"));
  const sessionsDir = path.join(tmp, "sessions");
  const refineryHome = path.join(tmp, "refinery-home");
  const labRoot = path.join(tmp, "Lab");
  const project = path.join(labRoot, "refinery");
  writeJsonl(path.join(sessionsDir, "rollout-selected.jsonl"), [
    { timestamp: "2026-07-14T01:00:00.000Z", type: "session_meta", payload: { id: "newer", cwd: project } },
    message("2026-07-14T01:01:00.000Z", "user", "Create the catalogue."),
  ]);
  const options = {
    sourceSpecs: [parseSourceSpec(`codex:sessions?home=${encodeURIComponent(sessionsDir)}&root=${encodeURIComponent(labRoot)}`)],
    targets: ["codex:memories" as const],
    project,
    scope: "project",
    intent: "newer-schema-test",
    request: null,
    home: refineryHome,
    sourceLimit: 10,
    now: new Date("2026-07-14T04:00:00.000Z"),
  };
  await buildReviewPacket(options);
  const cataloguePath = resolveRefineryPaths({ cwd: project, home: refineryHome }).sessionCataloguePath;
  const database = new Database(cataloguePath);
  database.prepare("INSERT INTO session_catalogue_migrations(version, applied_at) VALUES (?, ?)")
    .run(999, new Date().toISOString());
  database.close();

  await assert.rejects(
    buildReviewPacket(options),
    (error: unknown) => (error as { code?: string }).code === "SESSION_CATALOGUE_SCHEMA_UNSUPPORTED",
  );
});
