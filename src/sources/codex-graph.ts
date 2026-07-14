import path from "node:path";
import type { ActiveMemory, SourceDocument, SourceSet } from "../core/types.ts";
import type { GraphEdgeInput, GraphSourceItem } from "../core/graph/sync.ts";
import { RefineryError } from "../core/errors.ts";

const CODEX_GRAPH_ADAPTER = "codex";

export interface CodexGraphSnapshot {
  sourceSpecs: string[];
  items: GraphSourceItem[];
  edges: GraphEdgeInput[];
}

function uniqueGraphItems(items: GraphSourceItem[]): GraphSourceItem[] {
  const unique = new Map<string, GraphSourceItem>();
  for (const item of items) {
    const identity = `${item.sourceAdapter}\0${item.sourceKey}`;
    const existing = unique.get(identity);
    if (!existing) {
      unique.set(identity, item);
      continue;
    }
    if (
      existing.kind !== item.kind
      || existing.scope !== item.scope
      || existing.project !== item.project
      || existing.content !== item.content
    ) {
      throw new RefineryError(
        "GRAPH_SOURCE_CONFLICT",
        `Canonical graph source was loaded more than once with conflicting content: ${item.sourceKey}`,
        { phase: "graph-source", details: { sourceAdapter: item.sourceAdapter, sourceKey: item.sourceKey } },
      );
    }
  }
  return [...unique.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  return typeof metadata[key] === "string" && metadata[key] ? String(metadata[key]) : null;
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number | null {
  return typeof metadata[key] === "number" && Number.isFinite(metadata[key]) ? Number(metadata[key]) : null;
}

function documentKind(document: SourceDocument): GraphSourceItem["kind"] {
  if (document.role === "codex-session-summary") return "session";
  if (document.role === "codex-skill") return "skill";
  return "source_document";
}

function documentSourceKey(document: SourceDocument): string {
  if (document.role === "codex-session-responsibility-unit") {
    const sessionId = stringMetadata(document.metadata, "sessionId") ?? "unknown";
    const unitId = stringMetadata(document.metadata, "unitId") ?? document.id;
    return `session:${sessionId}:responsibility:${unitId}`;
  }
  if (document.role === "codex-session-summary") {
    return `session:${stringMetadata(document.metadata, "sessionId") ?? document.uri}`;
  }
  if (document.role === "codex-skill") {
    return `skill:${stringMetadata(document.metadata, "path") ?? stringMetadata(document.metadata, "skillName") ?? document.uri}`;
  }
  return `document:${stringMetadata(document.metadata, "relPath") ?? document.uri}`;
}

function documentLabel(document: SourceDocument): string {
  if (document.role === "codex-session-responsibility-unit") {
    const sessionId = stringMetadata(document.metadata, "sessionId") ?? document.id;
    const ordinal = numberMetadata(document.metadata, "unitOrdinal");
    return `Codex responsibility ${sessionId}${ordinal === null ? "" : ` #${ordinal + 1}`}`;
  }
  if (document.role === "codex-session-summary") {
    return `Codex session ${stringMetadata(document.metadata, "sessionId") ?? document.id}`;
  }
  if (document.role === "codex-skill") {
    return `$${stringMetadata(document.metadata, "skillName") ?? "skill"}`;
  }
  return stringMetadata(document.metadata, "relPath") ?? document.uri;
}

function documentProject(document: SourceDocument): string | null {
  const candidate = stringMetadata(document.metadata, "cwd") ?? stringMetadata(document.metadata, "projectPath");
  if (candidate) return path.resolve(candidate);
  const cwdSet = document.metadata.cwdSet;
  return Array.isArray(cwdSet) && typeof cwdSet[0] === "string" ? path.resolve(cwdSet[0]) : null;
}

function sourceModifiedAt(metadata: Record<string, unknown>): string | null {
  return stringMetadata(metadata, "endTimestamp")
    ?? stringMetadata(metadata, "lastTimestamp")
    ?? stringMetadata(metadata, "updatedAt")
    ?? stringMetadata(metadata, "timestamp");
}

function memoryProject(memory: ActiveMemory): string | null {
  const provenance = memory.provenance ?? {};
  const candidate = stringMetadata(provenance, "projectPath") ?? stringMetadata(provenance, "cwd");
  return candidate ? path.resolve(candidate) : null;
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function edge(args: Omit<GraphEdgeInput, "sourceAdapter" | "targetAdapter">): GraphEdgeInput {
  return {
    sourceAdapter: CODEX_GRAPH_ADAPTER,
    targetAdapter: CODEX_GRAPH_ADAPTER,
    ...args,
  };
}

export function buildCodexGraphSnapshot(args: {
  project: string;
  sourceSets: SourceSet[];
  documents: SourceDocument[];
  activeMemories: ActiveMemory[];
}): CodexGraphSnapshot {
  const project = path.resolve(args.project);
  const projectKey = `project:${project}`;
  const items: GraphSourceItem[] = [{
    sourceAdapter: CODEX_GRAPH_ADAPTER,
    sourceKey: projectKey,
    kind: "project",
    scope: "project",
    project,
    label: path.basename(project) || project,
    content: project,
    uri: null,
    metadata: { path: project },
  }];
  const edges: GraphEdgeInput[] = [];
  const documentBySourcePath = new Map<string, GraphSourceItem>();
  const sessionById = new Map<string, GraphSourceItem>();
  const skillsByName = new Map<string, GraphSourceItem[]>();
  const sourceSetsById = new Map(args.sourceSets.map((sourceSet) => [sourceSet.id, sourceSet]));
  const rootProjectScope = args.sourceSets.some((sourceSet) => (
    (sourceSet.spec.kind === "codex:sessions" || sourceSet.spec.kind === "codex:memories")
    && typeof sourceSet.spec.params.root === "string"
    && path.resolve(sourceSet.spec.params.root) === project
  ));

  for (const document of args.documents) {
    const kind = documentKind(document);
    const sourceSet = sourceSetsById.get(document.sourceSet);
    const globallyScopedSession = sourceSet?.spec.kind === "codex:sessions" && sourceSet.spec.params.scope === "global";
    const rootScopedSource = (sourceSet?.spec.kind === "codex:sessions" || sourceSet?.spec.kind === "codex:memories")
      && Boolean(sourceSet.spec.params.root);
    const callerProjectDocument = sourceSet?.spec.kind === "file" || sourceSet?.spec.kind === "glob";
    const metadataProject = documentProject(document);
    const itemProject = globallyScopedSession ? null : rootScopedSource ? project : metadataProject ?? (callerProjectDocument ? project : null);
    const itemScope = kind === "skill" || globallyScopedSession
      ? "global"
      : itemProject
        ? "project"
        : kind === "source_document" && sourceSet?.spec.kind === "codex:memories"
          ? "corpus"
          : "global";
    const item: GraphSourceItem = {
      sourceAdapter: CODEX_GRAPH_ADAPTER,
      sourceKey: documentSourceKey(document),
      kind,
      scope: itemScope,
      project: itemProject,
      label: documentLabel(document),
      content: document.text,
      uri: document.uri,
      metadata: {
        ...document.metadata,
        sourceSet: document.sourceSet,
        role: document.role,
      },
      sourceModifiedAt: sourceModifiedAt(document.metadata),
    };
    items.push(item);
    if (document.role === "codex-session-responsibility-unit") {
      const sessionId = stringMetadata(document.metadata, "sessionId");
      if (sessionId) {
        let parent = sessionById.get(sessionId);
        if (!parent) {
          parent = {
            sourceAdapter: CODEX_GRAPH_ADAPTER,
            sourceKey: `session:${sessionId}`,
            kind: "session",
            scope: itemScope,
            project: itemProject,
            label: `Codex session ${sessionId}`,
            content: `Codex session ${sessionId} responsibility-unit index.`,
            uri: `codex-session://${encodeURIComponent(sessionId)}`,
            metadata: { sessionId, responsibilityUnits: true },
            sourceModifiedAt: item.sourceModifiedAt,
          };
          items.push(parent);
          sessionById.set(sessionId, parent);
          if (itemProject === project) {
            edges.push(edge({
              sourceKey: parent.sourceKey,
              targetKey: projectKey,
              kind: "APPLIES_TO_PROJECT",
              confidence: 1,
              derivation: "codex-session-scope",
              evidenceRefs: [{ sessionId }],
            }));
          }
        }
        edges.push(edge({
          sourceKey: item.sourceKey,
          targetKey: parent.sourceKey,
          kind: "DERIVED_FROM",
          confidence: 1,
          derivation: "codex-responsibility-unit-session",
          evidenceRefs: [{ sessionId, unitId: stringMetadata(document.metadata, "unitId") }],
        }));
      }
    }
    const relPath = stringMetadata(document.metadata, "relPath");
    if (relPath) documentBySourcePath.set(relPath, item);
    const sessionId = stringMetadata(document.metadata, "sessionId");
    if (sessionId && document.role !== "codex-session-responsibility-unit") sessionById.set(sessionId, item);
    const skillName = stringMetadata(document.metadata, "skillName");
    if (skillName) skillsByName.set(skillName, [...(skillsByName.get(skillName) ?? []), item]);
    if (itemProject === project) {
      edges.push(edge({
        sourceKey: item.sourceKey,
        targetKey: projectKey,
        kind: "APPLIES_TO_PROJECT",
        confidence: 1,
        derivation: "codex-project-metadata",
        evidenceRefs: [{ uri: document.uri, metadataField: "cwd" }],
      }));
    }
  }

  for (const memory of args.activeMemories.filter((candidate) => {
    if (candidate.status !== "active") return false;
    const candidateProject = memoryProject(candidate);
    return rootProjectScope
      ? Boolean(candidateProject && pathWithin(candidateProject, project))
      : candidate.scope === "global" || candidateProject === project;
  })) {
    const provenance = memory.provenance ?? {};
    const sourcePath = stringMetadata(provenance, "sourcePath");
    const line = numberMetadata(provenance, "line");
    const canonicalMemoryProject = memoryProject(memory);
    const itemProject = rootProjectScope && canonicalMemoryProject && pathWithin(canonicalMemoryProject, project)
      ? project
      : canonicalMemoryProject;
    const stableMemoryKey = sourcePath
      ? `memory:${sourcePath}:${line ?? "document"}`
      : `memory:${memory.id}`;
    const memoryItem: GraphSourceItem = {
      sourceAdapter: CODEX_GRAPH_ADAPTER,
      sourceKey: stableMemoryKey,
      kind: "memory",
      scope: memory.scope,
      project: itemProject,
      label: stringMetadata(provenance, "heading") ?? memory.body.slice(0, 96),
      content: memory.body,
      uri: sourcePath ? `codex-memory://${sourcePath}${line ? `#L${line}` : ""}` : `codex-memory://${memory.id}`,
      metadata: {
        memoryId: memory.id,
        memoryType: memory.type,
        status: memory.status,
        confidence: memory.confidence ?? null,
        ...provenance,
      },
      sourceModifiedAt: stringMetadata(provenance, "updatedAt"),
    };
    items.push(memoryItem);
    if (itemProject === project) {
      edges.push(edge({
        sourceKey: memoryItem.sourceKey,
        targetKey: projectKey,
        kind: "APPLIES_TO_PROJECT",
        confidence: 1,
        derivation: "codex-memory-project-scope",
        evidenceRefs: [{ memoryId: memory.id, projectPath: itemProject }],
      }));
    }

    const sourceDocument = sourcePath ? documentBySourcePath.get(sourcePath) : undefined;
    if (sourceDocument) {
      const evidenceKey = `evidence:${sourcePath}:${line ?? "document"}`;
      const evidenceItem: GraphSourceItem = {
        sourceAdapter: CODEX_GRAPH_ADAPTER,
        sourceKey: evidenceKey,
        kind: "evidence",
        scope: memory.scope,
        project: itemProject,
        label: `${sourcePath}${line ? `:${line}` : ""}`,
        content: memory.body,
        uri: `${sourceDocument.uri ?? `codex-memory://${sourcePath}`}${line ? `#L${line}` : ""}`,
        metadata: { sourcePath, line, memoryId: memory.id },
        sourceModifiedAt: memoryItem.sourceModifiedAt,
      };
      items.push(evidenceItem);
      edges.push(edge({
        sourceKey: memoryItem.sourceKey,
        targetKey: evidenceKey,
        kind: "DERIVED_FROM",
        confidence: 1,
        derivation: "codex-memory-line-provenance",
        evidenceRefs: [{ sourcePath, line }],
      }));
      edges.push(edge({
        sourceKey: evidenceKey,
        targetKey: sourceDocument.sourceKey,
        kind: "DERIVED_FROM",
        confidence: 1,
        derivation: "codex-evidence-document-provenance",
        evidenceRefs: [{ sourcePath, line }],
      }));
    }

    const threadId = stringMetadata(provenance, "threadId");
    const session = threadId ? sessionById.get(threadId) : undefined;
    if (session) {
      edges.push(edge({
        sourceKey: memoryItem.sourceKey,
        targetKey: session.sourceKey,
        kind: "OBSERVED_IN_SESSION",
        confidence: 1,
        derivation: "codex-thread-id-match",
        evidenceRefs: [{ memoryId: memory.id, threadId }],
      }));
    }

    for (const [skillName, skills] of skillsByName) {
      const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?:^|\\s)\\$${escaped}(?=\\s|[.,;:!?)]|$)`, "i").test(memory.body)) continue;
      for (const skill of skills) {
        edges.push(edge({
          sourceKey: memoryItem.sourceKey,
          targetKey: skill.sourceKey,
          kind: "REQUIRES_SKILL",
          confidence: 1,
          derivation: "codex-explicit-skill-reference",
          evidenceRefs: [{ memoryId: memory.id, skillName }],
        }));
      }
    }
  }

  return {
    sourceSpecs: [...new Set(args.sourceSets.map((sourceSet) => sourceSet.spec.raw))].sort(),
    items: uniqueGraphItems(items),
    edges: edges.sort((left, right) => {
      const leftKey = `${left.sourceKey}\0${left.kind}\0${left.targetKey}`;
      const rightKey = `${right.sourceKey}\0${right.kind}\0${right.targetKey}`;
      return leftKey.localeCompare(rightKey);
    }),
  };
}
