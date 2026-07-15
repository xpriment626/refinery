import os from "node:os";
import path from "node:path";
export function resolveCodexHome(explicitHome, env = process.env) {
    return path.resolve(explicitHome ?? env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}
export function resolveCodexMemoriesDir(explicitHome, env = process.env) {
    return path.resolve(explicitHome ?? path.join(resolveCodexHome(undefined, env), "memories"));
}
export function resolveCodexSessionsDir(explicitHome, env = process.env) {
    return path.resolve(explicitHome ?? path.join(resolveCodexHome(undefined, env), "sessions"));
}
export function resolveCodexSkillRoots(explicitHomes, env = process.env) {
    if (explicitHomes)
        return explicitHomes.split(",").map((root) => path.resolve(root));
    return [
        path.join(resolveCodexHome(undefined, env), "skills"),
        path.join(os.homedir(), ".agents", "skills"),
    ];
}
//# sourceMappingURL=codex-paths.js.map