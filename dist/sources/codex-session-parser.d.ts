export declare const sessionIndexerSchemaVersion: "refinery.session-indexer.v1";
export type SessionScanMode = "header" | "scope" | "full";
export interface SessionScopeFilter {
    kind: "exact" | "root" | "global";
    path: string | null;
}
export interface SessionResponsibilityUnit {
    id: string;
    ordinal: number;
    sessionId: string;
    startLine: number;
    endLine: number;
    startTimestamp: string | null;
    endTimestamp: string | null;
    cwdSet: string[];
    phase: string;
    boundaryReasons: string[];
    text: string;
    metadata: Record<string, unknown>;
}
export interface IndexedSessionFile {
    filePath: string;
    scanMode: SessionScanMode;
    sessionId: string;
    sessionMetaCwd: string | null;
    cwdSet: string[];
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    lineCount: number;
    mixedScope: boolean;
    parseFailures: number;
    bytesRead: number;
    scopeBytesRead: number;
    units: SessionResponsibilityUnit[];
}
export declare function cwdMatchesFilter(cwd: string | null, filter: SessionScopeFilter): boolean;
export declare function cwdSetMatchesFilter(cwds: string[], filter: SessionScopeFilter): boolean;
export declare function readSessionHeader(filePath: string): Promise<{
    sessionId: string;
    cwd: string | null;
    timestamp: string | null;
    bytesRead: number;
}>;
export declare function scanSessionScope(filePath: string, header?: Awaited<ReturnType<typeof readSessionHeader>>): Promise<IndexedSessionFile>;
export declare function parseSessionStream(filePath: string, header?: Awaited<ReturnType<typeof readSessionHeader>>): Promise<IndexedSessionFile>;
