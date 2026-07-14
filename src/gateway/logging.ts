import fs from "node:fs";
import path from "node:path";

export type GatewayLogger = (level: string, event: string, details?: Record<string, unknown>) => void;

export function createBoundedGatewayLogger(
  logPathInput: string,
  options: { maxBytes?: number } = {},
): GatewayLogger {
  const logPath = path.resolve(logPathInput);
  const backupPath = `${logPath}.1`;
  const maxBytes = Math.max(256, Math.floor(options.maxBytes ?? 1_000_000));
  const parent = path.dirname(logPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("gateway log directory must be a regular directory");
  fs.chmodSync(parent, 0o700);

  return (level, event, details = {}) => {
    let line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details })}\n`;
    if (Buffer.byteLength(line) > maxBytes) {
      line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, detailsTruncated: true })}\n`;
    }
    const bytes = Buffer.byteLength(line);
    if (fs.existsSync(logPath)) {
      const stat = fs.lstatSync(logPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gateway log must be a regular file");
      if (stat.size + bytes > maxBytes) {
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
        fs.renameSync(logPath, backupPath);
        fs.chmodSync(backupPath, 0o600);
      }
    }
    fs.appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    fs.chmodSync(logPath, 0o600);
  };
}
