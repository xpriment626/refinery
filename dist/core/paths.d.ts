export interface RefineryPaths {
    home: string;
    configDir: string;
    credentialsDir: string;
    runsRootDir: string;
    projectKey: string;
    runsDir: string;
}
export interface ResolveRefineryPathsOptions {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}
export declare function expandHome(p: string): string;
export declare function projectKeyForPath(projectPath: string): string;
export declare function resolveRefineryPaths(options?: ResolveRefineryPathsOptions): RefineryPaths;
