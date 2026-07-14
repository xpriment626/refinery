import type { ActiveMemory, SourceDocument, SourceSet } from "../core/types.ts";
import type { GraphEdgeInput, GraphSourceItem } from "../core/graph/sync.ts";
export interface CodexGraphSnapshot {
    sourceSpecs: string[];
    items: GraphSourceItem[];
    edges: GraphEdgeInput[];
}
export declare function buildCodexGraphSnapshot(args: {
    project: string;
    sourceSets: SourceSet[];
    documents: SourceDocument[];
    activeMemories: ActiveMemory[];
}): CodexGraphSnapshot;
