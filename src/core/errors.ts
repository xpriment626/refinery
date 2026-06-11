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

export class RefineryError extends Error {
  code: string;
  phase?: string;
  runId?: string;
  runDir?: string;
  failedStep?: string;
  rawOutputPath?: string;
  status?: number;
  details?: unknown;

  constructor(code: string, message: string, context: RefineryErrorContext = {}) {
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

export function asRefineryError(
  error: unknown,
  fallback: RefineryErrorContext & { code: string } = { code: "REFINERY_ERROR" },
): RefineryError {
  if (error instanceof RefineryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RefineryError(fallback.code, message, fallback);
}

export function applyErrorContext(error: RefineryError, context: RefineryErrorContext): RefineryError {
  error.phase ??= context.phase;
  error.runId ??= context.runId;
  error.runDir ??= context.runDir;
  error.failedStep ??= context.failedStep;
  error.rawOutputPath ??= context.rawOutputPath;
  error.status ??= context.status;
  error.details ??= context.details;
  return error;
}

export function serializeRefineryError(error: RefineryError): Record<string, unknown> {
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
