import type { LoadSourceCorpusOptions, SourceCorpus } from "./packets.ts";
export interface IsolatedSourceCorpus {
    corpus: SourceCorpus;
    isolation: {
        processSeparated: true;
        permissionModel: boolean;
        readRootCount: number;
        writeProbeDenied: boolean | null;
    };
}
export interface IsolatedSourceReaderOptions {
    timeoutMs?: number;
    maxResponseBytes?: number;
    writeProbePath?: string;
}
export declare function readSourceCorpusIsolated(options: LoadSourceCorpusOptions, readerOptions?: IsolatedSourceReaderOptions): Promise<IsolatedSourceCorpus>;
export declare function loadSourceCorpusIsolated(options: LoadSourceCorpusOptions): Promise<SourceCorpus>;
