export declare const uiConfigSchemaVersion: "refinery.ui-config.v1";
export interface UiConfig {
    schemaVersion: typeof uiConfigSchemaVersion;
    browserOpenOnSync: boolean;
}
export declare function readUiConfig(options?: {
    home?: string;
    project?: string;
}): UiConfig;
export declare function writeUiConfig(options: {
    home?: string;
    project?: string;
    browserOpenOnSync: boolean;
}): UiConfig;
