import { type ResolveRefineryPathsOptions } from "../core/paths.ts";
export declare const coralRuntimePackage: {
    readonly name: "coralos-dev";
    readonly version: "1.2.0-SNAPSHOT-RC-3";
    readonly integrity: "sha512-geD+suwgrj2X9oSVGNLCk3IFKQ8pwlTaebFyP2Zi1hlox7zw766fDGg+mWhtmYRqvNcZmoZiymz7h+84H7HdQQ==";
    readonly tarball: "https://registry.npmjs.org/coralos-dev/-/coralos-dev-1.2.0-SNAPSHOT-RC-3.tgz";
};
export declare const minimumCoralJavaVersion = 24;
export interface JavaRuntimeStatus {
    command: string;
    present: boolean;
    majorVersion: number | null;
    sufficient: boolean;
}
export interface CoralRuntimeStatus {
    schemaVersion: "refinery.coral-runtime.v1";
    installed: boolean;
    verified: boolean;
    installDir: string;
    launcherPath: string;
    packageName: typeof coralRuntimePackage.name;
    expectedVersion: typeof coralRuntimePackage.version;
    installedVersion: string | null;
    expectedIntegrity: typeof coralRuntimePackage.integrity;
    installedIntegrity: string | null;
    installedTarball: string | null;
    provenance: {
        registryTarball: typeof coralRuntimePackage.tarball;
    };
    java: JavaRuntimeStatus;
}
export declare function coralRuntimeInstallDir(options?: ResolveRefineryPathsOptions): string;
export declare function coralRuntimeLauncherPath(options?: ResolveRefineryPathsOptions): string;
export declare function inspectJavaRuntime(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): JavaRuntimeStatus;
export declare function inspectCoralRuntime(options?: ResolveRefineryPathsOptions): CoralRuntimeStatus;
export declare function provisionCoralRuntime(options: ResolveRefineryPathsOptions & {
    confirmed: boolean;
}): Promise<CoralRuntimeStatus>;
