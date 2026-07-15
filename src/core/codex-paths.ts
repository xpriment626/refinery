import os from "node:os";
import path from "node:path";

export type CodexPathEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function resolveCodexHome(
  explicitHome?: string,
  env: CodexPathEnvironment = process.env,
): string {
  return path.resolve(explicitHome ?? env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

export function resolveCodexMemoriesDir(
  explicitHome?: string,
  env: CodexPathEnvironment = process.env,
): string {
  return path.resolve(explicitHome ?? path.join(resolveCodexHome(undefined, env), "memories"));
}

export function resolveCodexSessionsDir(
  explicitHome?: string,
  env: CodexPathEnvironment = process.env,
): string {
  return path.resolve(explicitHome ?? path.join(resolveCodexHome(undefined, env), "sessions"));
}

export function resolveCodexSkillRoots(
  explicitHomes?: string,
  env: CodexPathEnvironment = process.env,
): string[] {
  if (explicitHomes) return explicitHomes.split(",").map((root) => path.resolve(root));
  return [
    path.join(resolveCodexHome(undefined, env), "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}
