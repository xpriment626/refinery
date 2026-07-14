import type { ReviewPacketLimits, SourceDocument, SourceSet, SourceSpec } from "../core/types.ts";
export interface SessionCatalogueDiagnostics {
    schemaVersion: "refinery.session-catalogue-diagnostics.v1";
    candidateFiles: number;
    cacheHits: number;
    changedFiles: number;
    requestedFiles: number;
    headerScans: number;
    scopeScans: number;
    fullScans: number;
    excludedBeforeContentRead: number;
    mixedScopeRejected: number;
    unchangedContentReads: number;
    contentBytesRead: number;
    scopeBytesRead: number;
    selectedUnits: number;
    parseFailures: number;
}
export interface LoadedSessionSource {
    sourceSet: SourceSet;
    documents: SourceDocument[];
    warnings: string[];
    diagnostics: SessionCatalogueDiagnostics;
    isolation: {
        processSeparated: true;
        permissionModel: boolean;
    };
}
export declare const sessionCatalogueSchemaVersion: 3;
export interface SessionUnitSearchResult {
    unitId: string;
    sessionId: string;
    rank: number;
    text: string;
    metadata: Record<string, unknown>;
}
export declare function searchSessionResponsibilityUnits(args: {
    cataloguePath: string;
    request: string;
    limit?: number;
    root?: string;
}): SessionUnitSearchResult[];
export declare function loadCodexSessionsFromCatalogue(args: {
    spec: SourceSpec;
    index: number;
    project: string;
    scope: string;
    home?: string;
    limits: ReviewPacketLimits;
    now: Date;
}): Promise<LoadedSessionSource>;
