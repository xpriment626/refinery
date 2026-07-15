export interface SetupLifecycleOptions {
    home?: string;
    project: string;
    codexHome?: string;
    ttlMs?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}
export declare function setupLifecycleStatus(options: SetupLifecycleOptions): Promise<Record<string, unknown>>;
export declare function stopSetupLifecycle(options: SetupLifecycleOptions): Promise<Record<string, unknown>>;
export declare function startSetupLifecycle(options: SetupLifecycleOptions): Promise<Record<string, unknown>>;
export declare function serveSetupLifecycle(options: SetupLifecycleOptions & {
    instanceId: string;
}): Promise<void>;
