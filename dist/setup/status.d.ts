import type { CoralCredentialVerification } from "../coral/verification.ts";
export declare const setupStatusSchemaVersion: "refinery.setup-status.v1";
export declare const setupReceiptSchemaVersion: "refinery.setup-receipt.v1";
interface CredentialRevision {
    path: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    device: string;
    inode: string;
}
export interface SetupReceipt {
    schemaVersion: typeof setupReceiptSchemaVersion;
    project: string;
    completedAt: string;
    credential: CredentialRevision;
    coral: CoralCredentialVerification;
}
export interface SetupIssue {
    code: string;
    severity: "human" | "repair";
    message: string;
    repair: {
        command: string | null;
        requiresHumanConfirmation: boolean;
    };
}
export declare function writeSetupReceipt(args: {
    home?: string;
    project: string;
    coral: CoralCredentialVerification;
}): SetupReceipt;
export declare function readSetupReceipt(args: {
    home?: string;
    project: string;
}): SetupReceipt | null;
export declare function inspectSetup(args: {
    home?: string;
    project: string;
    codexHome?: string;
    memoryHome?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Record<string, unknown>;
export {};
