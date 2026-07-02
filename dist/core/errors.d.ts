export interface RefineryErrorContext {
    code?: string;
    phase?: string;
    runId?: string;
    runDir?: string;
    failedStep?: string;
    rawOutputPath?: string;
    status?: number;
    details?: unknown;
}
export declare class RefineryError extends Error {
    code: string;
    phase?: string;
    runId?: string;
    runDir?: string;
    failedStep?: string;
    rawOutputPath?: string;
    status?: number;
    details?: unknown;
    constructor(code: string, message: string, context?: RefineryErrorContext);
}
export declare function asRefineryError(error: unknown, fallback?: RefineryErrorContext & {
    code: string;
}): RefineryError;
export declare function applyErrorContext(error: RefineryError, context: RefineryErrorContext): RefineryError;
export declare function serializeRefineryError(error: RefineryError): Record<string, unknown>;
