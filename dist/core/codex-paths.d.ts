export type CodexPathEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
export declare function resolveCodexHome(explicitHome?: string, env?: CodexPathEnvironment): string;
export declare function resolveCodexMemoriesDir(explicitHome?: string, env?: CodexPathEnvironment): string;
export declare function resolveCodexSessionsDir(explicitHome?: string, env?: CodexPathEnvironment): string;
export declare function resolveCodexSkillRoots(explicitHomes?: string, env?: CodexPathEnvironment): string[];
