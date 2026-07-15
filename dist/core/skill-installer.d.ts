export interface CodexSkillInstallResult {
    requested: boolean;
    action: "installed" | "upgraded" | "unchanged" | "preserved" | "overwritten" | "skipped";
    path: string;
    managed: boolean;
    conflict: boolean;
    packageVersion: string;
    installedTreeHash: string | null;
    bundledTreeHash: string;
    reason: "not-requested" | "missing" | "managed-current" | "managed-stale" | "customized" | "force";
    next: string | null;
}
export interface CodexSkillInspection {
    path: string;
    exists: boolean;
    state: "missing" | "current" | "stale-managed" | "customized";
    managed: boolean;
    conflict: boolean;
    installedTreeHash: string | null;
    bundledTreeHash: string;
    installedPackageVersion: string | null;
}
export declare function hashSkillTree(root: string): string;
export declare function inspectManagedCodexSkill(options: {
    sourceDir: string;
    installPath: string;
}): CodexSkillInspection;
export declare function installManagedCodexSkill(options: {
    sourceDir: string;
    installPath: string;
    packageVersion: string;
    force?: boolean;
    skip?: boolean;
}): CodexSkillInstallResult;
