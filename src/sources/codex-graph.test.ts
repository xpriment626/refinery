import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMemory, SourceDocument, SourceSet } from "../core/types.ts";
import { buildCodexGraphSnapshot } from "./codex-graph.ts";

const project = "/tmp/refinery-project";

const sourceSets: SourceSet[] = [{
  id: "source-set:memories",
  spec: { raw: "codex:memories", kind: "codex:memories", value: null, params: {} },
  label: "codex:memories",
  role: "codex-memories",
  metadata: {},
}];

const documents: SourceDocument[] = [
  {
    id: "changing-content-id",
    sourceSet: "source-set:memories",
    role: "codex-memory-index",
    uri: "file:///tmp/memories/MEMORY.md",
    text: "# Memory index\n- Use $refinery for memory review.",
    metadata: { originKind: "memory-index", relPath: "MEMORY.md" },
  },
  {
    id: "session-content-id",
    sourceSet: "source-set:sessions",
    role: "codex-session-summary",
    uri: "file:///tmp/sessions/rollout.jsonl#session=session-1",
    text: "Codex session: session-1\nUser prompts:\n- Review Refinery memory.",
    metadata: { sessionId: "session-1", cwd: project, filePath: "/tmp/sessions/rollout.jsonl" },
  },
  {
    id: "skill-content-id",
    sourceSet: "source-set:skills",
    role: "codex-skill",
    uri: "file:///tmp/skills/refinery/SKILL.md",
    text: "---\nname: refinery\n---\nUse Refinery for memory review.",
    metadata: { skillName: "refinery", path: "/tmp/skills/refinery/SKILL.md" },
  },
];

const memories: ActiveMemory[] = [{
  id: "codex-memory:stable-memory-id",
  type: "operational",
  scope: "project",
  status: "active",
  body: "Use $refinery for memory review.",
  confidence: 0.9,
  provenance: {
    originKind: "memory-index",
    sourcePath: "MEMORY.md",
    line: 2,
    heading: "Memory index",
    threadId: "session-1",
    projectPath: project,
  },
}];

test("Codex graph adapter maps supported resources and deterministic evidence relationships", () => {
  const snapshot = buildCodexGraphSnapshot({ project, sourceSets, documents, activeMemories: memories });
  const kinds = new Set(snapshot.items.map((item) => item.kind));

  assert.deepEqual(
    [...kinds].sort(),
    ["evidence", "memory", "project", "session", "skill", "source_document"],
  );
  const memory = snapshot.items.find((item) => item.kind === "memory");
  const evidence = snapshot.items.find((item) => item.kind === "evidence");
  const source = snapshot.items.find((item) => item.kind === "source_document");
  assert.ok(memory);
  assert.ok(evidence);
  assert.ok(source);
  assert.equal(memory.sourceKey, "memory:MEMORY.md:2");
  assert.equal(memory.project, project);
  assert.equal(evidence.metadata.line, 2);
  assert.equal(source.sourceKey, "document:MEMORY.md");
  assert.equal(source.scope, "corpus");

  const edgeKinds = snapshot.edges.map((edge) => edge.kind);
  assert.equal(edgeKinds.includes("DERIVED_FROM"), true);
  assert.equal(edgeKinds.includes("OBSERVED_IN_SESSION"), true);
  assert.equal(edgeKinds.includes("APPLIES_TO_PROJECT"), true);
  assert.equal(edgeKinds.includes("REQUIRES_SKILL"), true);
  assert.equal(snapshot.edges.every((edge) => edge.derivation.length > 0), true);
  assert.equal(snapshot.edges.every((edge) => edge.confidence >= 0 && edge.confidence <= 1), true);
});

test("responsibility units attach to one sparse session parent and keep thread provenance", () => {
  const rootSource: SourceSet = {
    id: "source-set:root-sessions",
    spec: {
      raw: "codex:sessions?root=%2Ftmp%2FLab",
      kind: "codex:sessions",
      value: null,
      params: { root: "/tmp/Lab" },
    },
    label: "Lab sessions",
    role: "codex-sessions",
    metadata: {},
  };
  const unitDocuments: SourceDocument[] = [0, 1].map((ordinal) => ({
    id: `unit-doc-${ordinal}`,
    sourceSet: rootSource.id,
    role: "codex-session-responsibility-unit",
    uri: `codex-session://session-1/responsibility/unit-${ordinal}`,
    text: `Responsibility unit ${ordinal}`,
    metadata: {
      sessionId: "session-1",
      unitId: `unit-${ordinal}`,
      unitOrdinal: ordinal,
      cwdSet: ["/tmp/Lab/refinery"],
      endTimestamp: `2026-07-14T01:0${ordinal}:00.000Z`,
    },
  }));
  const snapshot = buildCodexGraphSnapshot({
    project: "/tmp/Lab",
    sourceSets: [rootSource],
    documents: unitDocuments,
    activeMemories: [
      {
        ...memories[0],
        provenance: { ...memories[0].provenance, projectPath: "/tmp/Lab/refinery" },
      },
      { ...memories[0], id: "global-root-exclusion", scope: "global", provenance: { threadId: "session-1" } },
      { ...memories[0], id: "other-root-exclusion", provenance: { projectPath: "/tmp/other" } },
    ],
  });
  const parent = snapshot.items.filter((item) => item.sourceKey === "session:session-1");
  const units = snapshot.items.filter((item) => item.sourceKey.startsWith("session:session-1:responsibility:"));
  assert.equal(parent.length, 1);
  assert.equal(parent[0]?.project, "/tmp/Lab");
  assert.equal(units.length, 2);
  assert.ok(units.every((unit) => unit.kind === "source_document"));
  assert.equal(snapshot.edges.filter((candidate) => candidate.derivation === "codex-responsibility-unit-session").length, 2);
  const observed = snapshot.edges.find((candidate) => candidate.kind === "OBSERVED_IN_SESSION");
  assert.equal(observed?.targetKey, "session:session-1");
  const memoryItems = snapshot.items.filter((item) => item.kind === "memory");
  assert.equal(memoryItems.length, 1);
  assert.equal(memoryItems[0]?.project, "/tmp/Lab");
});

test("Codex memory graph identity remains stable when body-derived Codex memory ids change", () => {
  const changed: ActiveMemory = {
    ...memories[0],
    id: "codex-memory:changed-body-id",
    body: "Use $refinery for graph-backed memory review.",
  };
  const first = buildCodexGraphSnapshot({ project, sourceSets, documents, activeMemories: memories });
  const second = buildCodexGraphSnapshot({ project, sourceSets, documents, activeMemories: [changed] });
  const firstMemory = first.items.find((item) => item.kind === "memory");
  const secondMemory = second.items.find((item) => item.kind === "memory");

  assert.ok(firstMemory);
  assert.ok(secondMemory);
  assert.equal(secondMemory.sourceKey, firstMemory.sourceKey);
  assert.notEqual(secondMemory.content, firstMemory.content);
  assert.notEqual(secondMemory.metadata.memoryId, firstMemory.metadata.memoryId);
});

test("Codex graph snapshot excludes unrelated project memories while retaining global memory", () => {
  const unrelated: ActiveMemory = {
    ...memories[0],
    id: "codex-memory:unrelated",
    body: "Unrelated project memory.",
    provenance: { ...memories[0].provenance, sourcePath: "OTHER.md", line: 4, projectPath: "/tmp/other-project" },
  };
  const global: ActiveMemory = {
    ...memories[0],
    id: "codex-memory:global",
    body: "Global user preference.",
    scope: "global",
    provenance: { ...memories[0].provenance, sourcePath: "memory_summary.md", line: 5, projectPath: null },
  };

  const snapshot = buildCodexGraphSnapshot({
    project,
    sourceSets,
    documents,
    activeMemories: [...memories, unrelated, global],
  });
  const memoryIds = snapshot.items
    .filter((candidate) => candidate.kind === "memory")
    .map((candidate) => candidate.metadata.memoryId);

  assert.equal(memoryIds.includes("codex-memory:stable-memory-id"), true);
  assert.equal(memoryIds.includes("codex-memory:global"), true);
  assert.equal(memoryIds.includes("codex-memory:unrelated"), false);
});

test("Codex graph keeps same-named skills from different roots as distinct resources", () => {
  const duplicateSkill: SourceDocument = {
    ...documents[2],
    id: "skill-content-id-agents-root",
    uri: "file:///tmp/agents-skills/refinery/SKILL.md",
    metadata: { skillName: "refinery", path: "/tmp/agents-skills/refinery/SKILL.md" },
  };
  const snapshot = buildCodexGraphSnapshot({
    project,
    sourceSets,
    documents: [...documents, duplicateSkill],
    activeMemories: memories,
  });
  const skills = snapshot.items.filter((candidate) => candidate.kind === "skill");
  const requiresSkill = snapshot.edges.filter((candidate) => candidate.kind === "REQUIRES_SKILL");

  assert.equal(skills.length, 2);
  assert.equal(new Set(skills.map((skill) => skill.sourceKey)).size, 2);
  assert.equal(requiresSkill.length, 2);
});

test("Codex graph deduplicates the same canonical source selected more than once", () => {
  const snapshot = buildCodexGraphSnapshot({
    project,
    sourceSets,
    documents: [documents[0], documents[0]],
    activeMemories: memories,
  });
  const identities = snapshot.items.map((candidate) => `${candidate.sourceAdapter}\0${candidate.sourceKey}`);

  assert.equal(new Set(identities).size, identities.length);
});

test("explicit global Codex session sources remain globally retrievable", () => {
  const sessionSet: SourceSet = {
    id: "source-set:sessions",
    spec: { raw: "codex:sessions?scope=global", kind: "codex:sessions", value: null, params: { scope: "global" } },
    label: "codex:sessions?scope=global",
    role: "codex-sessions",
    metadata: {},
  };
  const snapshot = buildCodexGraphSnapshot({
    project,
    sourceSets: [sessionSet],
    documents: [documents[1]],
    activeMemories: [],
  });
  const session = snapshot.items.find((candidate) => candidate.kind === "session");

  assert.ok(session);
  assert.equal(session.scope, "global");
  assert.equal(session.project, null);
});
