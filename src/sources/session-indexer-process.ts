import fs from "node:fs";
import {
  cwdMatchesFilter,
  cwdSetMatchesFilter,
  parseSessionStream,
  readSessionHeader,
  scanSessionScope,
  sessionIndexerSchemaVersion,
  type IndexedSessionFile,
  type SessionScopeFilter,
} from "./codex-session-parser.ts";

interface SessionIndexRequest {
  schemaVersion: typeof sessionIndexerSchemaVersion;
  requestId: string;
  filter: SessionScopeFilter;
  files: Array<{ filePath: string; mode: "probe" | "full" }>;
}

function writeResponse(response: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(response));
}

function validFilter(value: unknown): value is SessionScopeFilter {
  if (!value || typeof value !== "object") return false;
  const filter = value as Record<string, unknown>;
  return (filter.kind === "global" && filter.path === null)
    || ((filter.kind === "root" || filter.kind === "exact") && typeof filter.path === "string");
}

async function main(): Promise<void> {
  let request: SessionIndexRequest;
  try {
    const input = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error("session index request exceeds 16MB");
    request = JSON.parse(input) as SessionIndexRequest;
    if (request.schemaVersion !== sessionIndexerSchemaVersion || typeof request.requestId !== "string"
      || !validFilter(request.filter) || !Array.isArray(request.files)
      || request.files.some((file) => !file || typeof file.filePath !== "string" || !["probe", "full"].includes(file.mode))) {
      throw new Error("session index request schema is invalid");
    }
  } catch (error) {
    writeResponse({
      schemaVersion: sessionIndexerSchemaVersion,
      requestId: "invalid",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  try {
    const files: IndexedSessionFile[] = [];
    for (const candidate of request.files) {
      const header = await readSessionHeader(candidate.filePath);
      if (candidate.mode === "probe" && !cwdMatchesFilter(header.cwd, request.filter)) {
        files.push({
          filePath: candidate.filePath,
          scanMode: "header",
          sessionId: header.sessionId,
          sessionMetaCwd: header.cwd,
          cwdSet: header.cwd ? [header.cwd] : [],
          firstTimestamp: header.timestamp,
          lastTimestamp: header.timestamp,
          lineCount: 1,
          mixedScope: false,
          parseFailures: 0,
          bytesRead: 0,
          scopeBytesRead: header.bytesRead,
          units: [],
        });
        continue;
      }
      let scopeBytesRead = 0;
      if (candidate.mode === "probe") {
        const scope = await scanSessionScope(candidate.filePath, header);
        scope.mixedScope = !cwdSetMatchesFilter(scope.cwdSet, request.filter);
        if (scope.mixedScope) {
          files.push(scope);
          continue;
        }
        scopeBytesRead = scope.scopeBytesRead;
      }
      const parsed = await parseSessionStream(candidate.filePath, header);
      parsed.scopeBytesRead = scopeBytesRead;
      parsed.mixedScope = !cwdSetMatchesFilter(parsed.cwdSet, request.filter);
      if (parsed.mixedScope) {
        parsed.scanMode = "scope";
        parsed.units = [];
      }
      files.push(parsed);
    }
    writeResponse({
      schemaVersion: sessionIndexerSchemaVersion,
      requestId: request.requestId,
      ok: true,
      files,
      isolation: {
        processSeparated: true,
        permissionModel: Boolean(process.permission),
      },
    });
  } catch (error) {
    writeResponse({
      schemaVersion: sessionIndexerSchemaVersion,
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

await main();
