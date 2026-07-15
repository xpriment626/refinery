import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RefineryError } from "../errors.js";
export const memoryGraphSchemaVersion = "refinery.memory-graph.v1";
export const memoryGraphIndexerVersion = "refinery.memory-graph-indexer.v1";
export const memoryGraphNodeKinds = [
    "memory",
    "source_document",
    "session",
    "skill",
    "project",
    "evidence",
];
export const memoryGraphEdgeKinds = [
    "DERIVED_FROM",
    "OBSERVED_IN_SESSION",
    "APPLIES_TO_PROJECT",
    "SUPPORTS",
    "CONTRADICTS",
    "SUPERSEDES",
    "DUPLICATES",
    "SAME_TOPIC_AS",
    "REQUIRES_SKILL",
];
export class JsonGraphStore {
    location;
    constructor(location) {
        this.location = path.resolve(location);
    }
    read() {
        if (!fs.existsSync(this.location))
            return null;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.location, "utf8"));
            if (parsed.schemaVersion !== memoryGraphSchemaVersion ||
                parsed.indexerVersion !== memoryGraphIndexerVersion ||
                typeof parsed.project !== "string" ||
                !Array.isArray(parsed.nodes) ||
                !Array.isArray(parsed.revisions) ||
                !Array.isArray(parsed.edges)) {
                throw new Error("graph index schema is unsupported or incomplete");
            }
            return parsed;
        }
        catch (error) {
            throw new RefineryError("GRAPH_INDEX_INVALID", `Could not read Refinery graph index at ${this.location}: ${error instanceof Error ? error.message : String(error)}`, { phase: "graph-store", details: { graphPath: this.location } });
        }
    }
    write(index) {
        const parent = path.dirname(this.location);
        const temporary = `${this.location}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
        try {
            fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
            fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            fs.renameSync(temporary, this.location);
            if (process.platform !== "win32")
                fs.chmodSync(this.location, 0o600);
        }
        catch (error) {
            throw new RefineryError("GRAPH_STORE_WRITE_FAILED", `Could not write Refinery graph index at ${this.location}: ${error instanceof Error ? error.message : String(error)}`, { phase: "graph-store", details: { graphPath: this.location } });
        }
        finally {
            if (fs.existsSync(temporary))
                fs.rmSync(temporary, { force: true });
        }
    }
}
function hash(parts) {
    const digest = crypto.createHash("sha256");
    parts.forEach((part) => digest.update(part).update("\0"));
    return digest.digest("hex");
}
function nodeIdFor(item) {
    return `graph-node:${hash([item.sourceAdapter, item.sourceKey]).slice(0, 24)}`;
}
function normalizeContent(content) {
    return content.replace(/\r\n?/g, "\n");
}
function revisionFor(item, nodeId, indexedAt) {
    const content = normalizeContent(item.content);
    const contentHash = hash([content]);
    return {
        id: `graph-revision:${hash([nodeId, contentHash, memoryGraphIndexerVersion]).slice(0, 24)}`,
        nodeId,
        contentHash,
        indexerVersion: memoryGraphIndexerVersion,
        content,
        charCount: content.length,
        indexedAt,
        sourceModifiedAt: item.sourceModifiedAt ?? null,
    };
}
function assertUniqueItems(items) {
    const identities = new Set();
    for (const item of items) {
        const identity = `${item.sourceAdapter}\0${item.sourceKey}`;
        if (identities.has(identity)) {
            throw new RefineryError("GRAPH_SOURCE_DUPLICATE", `Graph source identity is duplicated: ${item.sourceAdapter}:${item.sourceKey}`, { phase: "graph-sync", details: { sourceAdapter: item.sourceAdapter, sourceKey: item.sourceKey } });
        }
        identities.add(identity);
    }
}
function edgeIdentity(sourceAdapter, sourceKey) {
    return `${sourceAdapter}\0${sourceKey}`;
}
function materializeEdges(inputs, nodes) {
    const nodesBySource = new Map(nodes.map((node) => [edgeIdentity(node.sourceAdapter, node.sourceKey), node]));
    const edges = inputs.map((input) => {
        const source = nodesBySource.get(edgeIdentity(input.sourceAdapter, input.sourceKey));
        const target = nodesBySource.get(edgeIdentity(input.targetAdapter, input.targetKey));
        if (!source || !target) {
            const missing = [
                ...(!source ? [`${input.sourceAdapter}:${input.sourceKey}`] : []),
                ...(!target ? [`${input.targetAdapter}:${input.targetKey}`] : []),
            ];
            throw new RefineryError("GRAPH_EDGE_ENDPOINT_MISSING", `Graph edge ${input.kind} references missing endpoint(s): ${missing.join(", ")}`, { phase: "graph-sync", details: { edge: input, missing } });
        }
        const confidence = Math.max(0, Math.min(1, input.confidence));
        return {
            id: `graph-edge:${hash([
                source.id,
                target.id,
                input.kind,
                source.currentRevisionId,
                input.derivation,
            ]).slice(0, 24)}`,
            sourceNodeId: source.id,
            targetNodeId: target.id,
            kind: input.kind,
            sourceRevisionId: source.currentRevisionId,
            confidence,
            provenance: {
                derivation: input.derivation,
                evidenceRefs: input.evidenceRefs ?? [],
                metadata: input.metadata ?? {},
            },
        };
    });
    const unique = new Map(edges.map((edge) => [edge.id, edge]));
    return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}
export function syncMemoryGraph(args) {
    assertUniqueItems(args.items);
    const project = path.resolve(args.project);
    const previous = args.store.read();
    const previousForProject = previous?.project === project ? previous : null;
    const previousNodes = new Map(previousForProject?.nodes.map((node) => [node.id, node]) ?? []);
    const previousRevisions = new Map(previousForProject?.revisions.map((revision) => [revision.id, revision]) ?? []);
    const indexedAt = (args.now ?? new Date()).toISOString();
    const nodes = [];
    const currentRevisions = [];
    const changedNodeIds = [];
    const createdNodeIds = [];
    const updatedNodeIds = [];
    const createdRevisionIds = [];
    let createdNodes = 0;
    let updatedNodes = 0;
    let unchangedNodes = 0;
    let createdRevisions = 0;
    const sortedItems = [...args.items].sort((left, right) => {
        const leftKey = `${left.sourceAdapter}\0${left.sourceKey}`;
        const rightKey = `${right.sourceAdapter}\0${right.sourceKey}`;
        return leftKey.localeCompare(rightKey);
    });
    for (const item of sortedItems) {
        const id = nodeIdFor(item);
        const revision = revisionFor(item, id, indexedAt);
        const priorNode = previousNodes.get(id);
        const priorRevision = previousRevisions.get(revision.id);
        const node = {
            id,
            sourceAdapter: item.sourceAdapter,
            sourceKey: item.sourceKey,
            kind: item.kind,
            scope: item.scope,
            project: item.project ? path.resolve(item.project) : null,
            label: item.label,
            uri: item.uri,
            currentRevisionId: revision.id,
            metadata: item.metadata,
        };
        if (!priorNode) {
            createdNodes += 1;
            createdNodeIds.push(id);
            changedNodeIds.push(id);
        }
        else if (JSON.stringify(priorNode) !== JSON.stringify(node)) {
            updatedNodes += 1;
            updatedNodeIds.push(id);
            changedNodeIds.push(id);
        }
        else {
            unchangedNodes += 1;
        }
        if (!priorRevision) {
            createdRevisions += 1;
            createdRevisionIds.push(revision.id);
        }
        currentRevisions.push(priorRevision ?? revision);
        nodes.push(node);
    }
    const currentNodeIds = new Set(nodes.map((node) => node.id));
    const removedNodeIds = [...previousNodes.keys()].filter((id) => !currentNodeIds.has(id)).sort();
    const currentRevisionIds = new Set(currentRevisions.map((revision) => revision.id));
    const removedRevisionIds = [...previousRevisions.keys()].filter((id) => !currentRevisionIds.has(id)).sort();
    const removedRevisions = removedRevisionIds.length;
    const edges = materializeEdges(args.edges, nodes);
    const currentEdgeIds = new Set(edges.map((edge) => edge.id));
    const previousEdges = new Map(previousForProject?.edges.map((edge) => [edge.id, edge]) ?? []);
    const previousEdgeIds = new Set(previousEdges.keys());
    const createdEdgeIds = edges.filter((edge) => !previousEdgeIds.has(edge.id)).map((edge) => edge.id).sort();
    const updatedEdgeIds = edges
        .filter((edge) => previousEdges.has(edge.id) && JSON.stringify(previousEdges.get(edge.id)) !== JSON.stringify(edge))
        .map((edge) => edge.id)
        .sort();
    const removedEdgeIds = previousForProject?.edges.filter((edge) => !currentEdgeIds.has(edge.id)).map((edge) => edge.id).sort() ?? [];
    const removedEdges = removedEdgeIds.length;
    const index = {
        schemaVersion: memoryGraphSchemaVersion,
        indexerVersion: memoryGraphIndexerVersion,
        project,
        sourceSpecs: [...new Set(args.sourceSpecs)].sort(),
        syncedAt: indexedAt,
        nodes,
        revisions: currentRevisions.sort((left, right) => left.id.localeCompare(right.id)),
        edges,
    };
    const delta = {
        createdNodeIds: createdNodeIds.sort(),
        updatedNodeIds: updatedNodeIds.sort(),
        removedNodeIds,
        createdRevisionIds: createdRevisionIds.sort(),
        removedRevisionIds,
        createdEdgeIds,
        updatedEdgeIds,
        removedEdgeIds,
    };
    args.store.write(index, previousForProject, delta);
    return {
        index,
        summary: {
            createdNodes,
            updatedNodes,
            unchangedNodes,
            removedNodes: removedNodeIds.length,
            createdRevisions,
            removedRevisions,
            updatedEdges: updatedEdgeIds.length,
            removedEdges,
            nodes: index.nodes.length,
            revisions: index.revisions.length,
            edges: index.edges.length,
        },
        delta,
        changedNodeIds: changedNodeIds.sort(),
        removedNodeIds,
    };
}
//# sourceMappingURL=sync.js.map