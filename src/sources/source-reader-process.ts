import fs from "node:fs";
import { asRefineryError, serializeRefineryError } from "../core/errors.ts";
import { loadSourceCorpus, type LoadSourceCorpusOptions } from "../core/packets.ts";

const schemaVersion = "refinery.source-reader.v1" as const;

interface ReaderRequest {
  schemaVersion: typeof schemaVersion;
  requestId: string;
  options: Omit<LoadSourceCorpusOptions, "now"> & { now: string | null };
  writeProbePath: string | null;
}

function writeResponse(response: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(response));
}

async function main(): Promise<void> {
  let request: ReaderRequest;
  try {
    const input = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 1_000_000) throw new Error("source reader request exceeds 1MB");
    request = JSON.parse(input) as ReaderRequest;
    if (request.schemaVersion !== schemaVersion || typeof request.requestId !== "string") {
      throw new Error("source reader request schema is invalid");
    }
  } catch (error) {
    writeResponse({
      schemaVersion,
      requestId: "invalid",
      ok: false,
      error: { code: "SOURCE_READER_PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), phase: "source-reader" },
    });
    process.exitCode = 1;
    return;
  }

  try {
    let writeProbeDenied: boolean | null = null;
    if (request.writeProbePath) {
      try {
        fs.writeFileSync(request.writeProbePath, "permission boundary failed");
        writeProbeDenied = false;
      } catch {
        writeProbeDenied = true;
      }
    }
    const corpus = await loadSourceCorpus({
      ...request.options,
      now: request.options.now ? new Date(request.options.now) : undefined,
    });
    writeResponse({
      schemaVersion,
      requestId: request.requestId,
      ok: true,
      corpus,
      isolation: {
        processSeparated: true,
        permissionModel: Boolean(process.permission),
        readRootCount: process.permission ? 1 : 0,
        writeProbeDenied,
      },
    });
  } catch (error) {
    writeResponse({
      schemaVersion,
      requestId: request.requestId,
      ok: false,
      error: serializeRefineryError(asRefineryError(error, { code: "SOURCE_READER_FAILED", phase: "source-reader" })),
    });
    process.exitCode = 1;
  }
}

await main();
