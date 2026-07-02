export class RefineryError extends Error {
    code;
    phase;
    runId;
    runDir;
    failedStep;
    rawOutputPath;
    status;
    details;
    constructor(code, message, context = {}) {
        super(message);
        this.name = "RefineryError";
        this.code = code;
        this.phase = context.phase;
        this.runId = context.runId;
        this.runDir = context.runDir;
        this.failedStep = context.failedStep;
        this.rawOutputPath = context.rawOutputPath;
        this.status = context.status;
        this.details = context.details;
    }
}
export function asRefineryError(error, fallback = { code: "REFINERY_ERROR" }) {
    if (error instanceof RefineryError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return new RefineryError(fallback.code, message, fallback);
}
export function applyErrorContext(error, context) {
    error.phase ??= context.phase;
    error.runId ??= context.runId;
    error.runDir ??= context.runDir;
    error.failedStep ??= context.failedStep;
    error.rawOutputPath ??= context.rawOutputPath;
    error.status ??= context.status;
    error.details ??= context.details;
    return error;
}
export function serializeRefineryError(error) {
    return {
        code: error.code,
        message: error.message,
        ...(error.phase ? { phase: error.phase } : {}),
        ...(error.failedStep ? { failedStep: error.failedStep } : {}),
        ...(error.rawOutputPath ? { rawOutputPath: error.rawOutputPath } : {}),
        ...(typeof error.status === "number" ? { status: error.status } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
    };
}
//# sourceMappingURL=errors.js.map