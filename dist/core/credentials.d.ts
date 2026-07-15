export type AuthProvider = "coral";
export interface StoredAuthOptions {
    home?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cwd?: string;
}
export interface StoredAuthStatus {
    provider: AuthProvider;
    present: boolean;
    path: string;
    source: "credentials" | "missing";
    secure: boolean;
    mode: "0600" | "platform-managed" | null;
}
export interface ModelAuthStatus {
    present: boolean;
    source: "env:CORAL_API_KEY" | "credentials:coral" | "missing";
    provider: AuthProvider | null;
    credentialPath?: string;
}
export declare function storedAuthPath(providerInput: string, options?: StoredAuthOptions): string;
export declare function writeStoredAuth(providerInput: string, value: string, options?: StoredAuthOptions): StoredAuthStatus;
export declare function readStoredAuth(providerInput: string, options?: StoredAuthOptions): string;
export declare function storedAuthStatus(providerInput: string, options?: StoredAuthOptions): StoredAuthStatus;
export declare function removeStoredAuth(providerInput: string, options?: StoredAuthOptions): StoredAuthStatus;
export declare function resolveModelApiKey(args: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    localEnv?: Record<string, string | undefined>;
    home?: string;
    cwd?: string;
}): {
    apiKey: string;
    status: ModelAuthStatus;
};
