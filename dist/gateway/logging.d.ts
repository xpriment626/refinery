export type GatewayLogger = (level: string, event: string, details?: Record<string, unknown>) => void;
export declare function createBoundedGatewayLogger(logPathInput: string, options?: {
    maxBytes?: number;
}): GatewayLogger;
