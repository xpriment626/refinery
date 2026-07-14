import fs from "node:fs";
import path from "node:path";
import { RefineryError } from "../core/errors.js";
import { resolveRefineryPaths } from "../core/paths.js";
export const uiConfigSchemaVersion = "refinery.ui-config.v1";
export function readUiConfig(options = {}) {
    const paths = resolveRefineryPaths({ home: options.home, cwd: options.project ?? process.cwd() });
    if (!fs.existsSync(paths.uiConfigPath))
        return { schemaVersion: uiConfigSchemaVersion, browserOpenOnSync: false };
    try {
        const parsed = JSON.parse(fs.readFileSync(paths.uiConfigPath, "utf8"));
        if (parsed.schemaVersion !== uiConfigSchemaVersion || typeof parsed.browserOpenOnSync !== "boolean") {
            throw new Error("UI config schema is invalid");
        }
        return parsed;
    }
    catch (error) {
        throw new RefineryError("UI_CONFIG_INVALID", `Could not read Refinery UI config: ${error instanceof Error ? error.message : String(error)}`, { phase: "ui-config", details: { configPath: paths.uiConfigPath } });
    }
}
export function writeUiConfig(options) {
    const paths = resolveRefineryPaths({ home: options.home, cwd: options.project ?? process.cwd() });
    const config = { schemaVersion: uiConfigSchemaVersion, browserOpenOnSync: options.browserOpenOnSync };
    const temporary = `${paths.uiConfigPath}.tmp-${process.pid}`;
    try {
        fs.mkdirSync(path.dirname(paths.uiConfigPath), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(paths.uiConfigPath), 0o700);
        fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, paths.uiConfigPath);
        fs.chmodSync(paths.uiConfigPath, 0o600);
        return config;
    }
    catch (error) {
        if (fs.existsSync(temporary))
            fs.rmSync(temporary, { force: true });
        throw new RefineryError("UI_CONFIG_WRITE_FAILED", `Could not write Refinery UI config: ${error instanceof Error ? error.message : String(error)}`, { phase: "ui-config", details: { configPath: paths.uiConfigPath } });
    }
}
//# sourceMappingURL=config.js.map