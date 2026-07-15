export interface RefineryPaths {
    home: string;
    configDir: string;
    credentialsDir: string;
    runsRootDir: string;
    projectKey: string;
    runsDir: string;
    cataloguesDir: string;
    sessionCataloguePath: string;
    graphsDir: string;
    graphIndexPath: string;
    legacyGraphIndexPath: string;
    gatewayDir: string;
    gatewayStatePath: string;
    gatewayLogPath: string;
    uiConfigPath: string;
    setupDir: string;
    setupStatePath: string;
    setupReceiptPath: string;
    runtimeDir: string;
    coralRuntimeRootDir: string;
}
export interface ResolveRefineryPathsOptions {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}
export declare function expandHome(p: string): string;
export declare function projectKeyForPath(projectPath: string): string;
export declare function resolveRefineryPaths(options?: ResolveRefineryPathsOptions): RefineryPaths;
