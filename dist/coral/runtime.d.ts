import { type ResolveRefineryPathsOptions } from "../core/paths.ts";
export declare const coralRuntimeSource: {
    readonly repository: "Coral-Protocol/coral-server";
    readonly releaseChannel: "latest-stable";
    readonly releaseApi: "https://api.github.com/repos/Coral-Protocol/coral-server/releases/latest";
    readonly releaseBaseUrl: "https://github.com/Coral-Protocol/coral-server/releases/";
    readonly maximumAssetBytes: number;
};
export declare const minimumCoralJavaVersion = 24;
export interface JavaRuntimeStatus {
    command: string;
    present: boolean;
    majorVersion: number | null;
    sufficient: boolean;
}
export interface CoralReleaseArtifact {
    version: string;
    tag: string;
    assetName: string;
    assetUrl: string;
    releaseUrl: string;
    sha256: string;
    size: number;
}
export interface CoralRuntimeStatus {
    schemaVersion: "refinery.coral-runtime.v2";
    source: "github-release";
    repository: typeof coralRuntimeSource.repository;
    releaseChannel: typeof coralRuntimeSource.releaseChannel;
    installed: boolean;
    verified: boolean;
    installDir: string | null;
    jarPath: string | null;
    installedVersion: string | null;
    installedTag: string | null;
    expectedSha256: string | null;
    actualSha256: string | null;
    assetUrl: string | null;
    releaseUrl: string | null;
    provisionedAt: string | null;
    java: JavaRuntimeStatus;
}
export interface ProvisionCoralRuntimeOptions extends ResolveRefineryPathsOptions {
    confirmed: boolean;
    resolveRelease?: () => Promise<CoralReleaseArtifact>;
    downloadRelease?: (artifact: CoralReleaseArtifact, destination: string) => Promise<void>;
}
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare function coralRuntimeInstallDir(options?: ResolveRefineryPathsOptions, version?: string): string;
export declare function coralRuntimeJarPath(options?: ResolveRefineryPathsOptions): string | null;
export declare function verifyCoralRuntimeJarPath(jarPath: string): boolean;
export declare function inspectJavaRuntime(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): JavaRuntimeStatus;
export declare function inspectCoralRuntime(options?: ResolveRefineryPathsOptions): CoralRuntimeStatus;
export declare function resolveLatestCoralRelease(fetchImpl?: FetchLike): Promise<CoralReleaseArtifact>;
export declare function provisionCoralRuntime(options: ProvisionCoralRuntimeOptions): Promise<CoralRuntimeStatus>;
export {};
