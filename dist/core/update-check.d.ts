export declare const updateCheckTtlMs: number;
export declare const updateCheckTimeoutMs = 1500;
export interface UpdateCheckResult {
    currentVersion: string;
    latestVersion: string;
    checkedAt: number;
    source: "cache" | "registry";
    updateAvailable: boolean;
}
export interface CheckForUpdateOptions {
    packageName: string;
    currentVersion: string;
    cachePath: string;
    now?: number;
    timeoutMs?: number;
    fetcher?: typeof fetch;
}
export declare function compareVersions(left: string, right: string): number;
export declare function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult | null>;
export declare function formatUpdateNotice(packageName: string, result: UpdateCheckResult): string;
