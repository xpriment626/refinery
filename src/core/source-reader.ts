import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RefineryError } from "./errors.ts";
import type { LoadSourceCorpusOptions, SourceCorpus } from "./packets.ts";
import type { LoadedSessionSource } from "../sources/codex-session-catalogue.ts";

const sourceReaderProtocolVersion = "refinery.source-reader.v1" as const;

interface SourceReaderRequest {
  schemaVersion: typeof sourceReaderProtocolVersion;
  requestId: string;
  options: Omit<LoadSourceCorpusOptions, "now"> & { now: string | null };
  writeProbePath: string | null;
}

interface SourceReaderResponse {
  schemaVersion: typeof sourceReaderProtocolVersion;
  requestId: string;
  ok: boolean;
  corpus?: SourceCorpus;
  isolation?: {
    processSeparated: true;
    permissionModel: boolean;
    readRootCount: number;
    writeProbeDenied: boolean | null;
  };
  error?: {
    code: string;
    message: string;
    phase?: string;
    details?: Record<string, unknown>;
  };
}

export interface IsolatedSourceCorpus {
  corpus: SourceCorpus;
  isolation: {
    processSeparated: true;
    permissionModel: boolean;
    readRootCount: number;
    writeProbeDenied: boolean | null;
  };
}

export interface IsolatedSourceReaderOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  writeProbePath?: string;
}

function globRoot(patternInput: string): string {
  const pattern = path.resolve(patternInput);
  const wildcard = pattern.search(/[*?[\]]/);
  if (wildcard < 0) return path.dirname(pattern);
  const prefix = pattern.slice(0, wildcard);
  const slash = prefix.lastIndexOf(path.sep);
  return slash > 0 ? prefix.slice(0, slash) : path.parse(pattern).root;
}

function sourceReadRoots(options: LoadSourceCorpusOptions): string[] {
  const roots = new Set<string>();
  for (const spec of options.sourceSpecs) {
    switch (spec.kind) {
      case "codex:memories":
        roots.add(resolveCodexMemoriesDir(spec.params.home ?? options.memoryHome));
        break;
      case "codex:sessions":
        roots.add(resolveCodexSessionsDir(spec.params.home));
        break;
      case "codex:skills":
        for (const root of resolveCodexSkillRoots(spec.params.home)) {
          roots.add(path.resolve(root));
        }
        break;
      case "file":
        if (spec.value) roots.add(path.resolve(spec.value));
        break;
      case "glob":
        if (spec.value) roots.add(globRoot(spec.value));
        break;
    }
  }
  return [...roots].sort();
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
  return Object.fromEntries([
    ...allowed.map((key) => [key, process.env[key]] as const).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ["NODE_NO_WARNINGS", "1"],
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCorpus(value: unknown, options: LoadSourceCorpusOptions): SourceCorpus {
  if (!isRecord(value) || !Array.isArray(value.sourceSets) || !Array.isArray(value.documents)
    || !Array.isArray(value.activeMemories) || !Array.isArray(value.warnings)) {
    throw new Error("source reader returned an invalid corpus shape");
  }
  const maximumDocuments = options.sourceSpecs.length * options.limits.sourceLimit;
  if (value.sourceSets.length > options.sourceSpecs.length || value.documents.length > maximumDocuments
    || value.activeMemories.length > options.sourceSpecs.length * options.limits.activeMemoryLimit) {
    throw new Error("source reader returned a corpus outside the requested item limits");
  }
  for (const document of value.documents) {
    if (!isRecord(document) || typeof document.id !== "string" || typeof document.text !== "string"
      || typeof document.uri !== "string" || document.text.length > options.limits.documentCharLimit) {
      throw new Error("source reader returned an invalid or oversized document");
    }
  }
  return value as unknown as SourceCorpus;
}

async function readGenericSourceCorpusIsolated(
  options: LoadSourceCorpusOptions,
  readerOptions: IsolatedSourceReaderOptions = {},
): Promise<IsolatedSourceCorpus> {
  const requestId = crypto.randomUUID();
  const extension = path.extname(fileURLToPath(import.meta.url));
  const entryPath = path.resolve(import.meta.dirname, `../sources/source-reader-process${extension}`);
  const runtimeRoot = path.resolve(import.meta.dirname, "..");
  const packageJsonPath = path.resolve(runtimeRoot, "..", "package.json");
  const readRoots = sourceReadRoots(options);
  const permissionRoots = [...new Set([runtimeRoot, packageJsonPath, ...readRoots])];
  const request: SourceReaderRequest = {
    schemaVersion: sourceReaderProtocolVersion,
    requestId,
    options: { ...options, now: options.now?.toISOString() ?? null },
    writeProbePath: readerOptions.writeProbePath ? path.resolve(readerOptions.writeProbePath) : null,
  };
  const timeoutMs = Math.max(1_000, Math.min(120_000, readerOptions.timeoutMs ?? 30_000));
  const calculatedMaximum = options.sourceSpecs.length * options.limits.sourceLimit * options.limits.documentCharLimit * 1.25
    + options.sourceSpecs.length * options.limits.activeMemoryLimit * 4_096
    + 1_000_000;
  const maxResponseBytes = Math.max(1_000_000, Math.min(
    256 * 1024 * 1024,
    readerOptions.maxResponseBytes ?? calculatedMaximum,
  ));

  return new Promise<IsolatedSourceCorpus>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--permission",
      ...permissionRoots.map((root) => `--allow-fs-read=${root}`),
      entryPath,
    ], {
      cwd: process.cwd(),
      env: sanitizedChildEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: unknown, result?: IsolatedSourceCorpus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new RefineryError(
        "SOURCE_READER_TIMEOUT",
        `Read-only source reader exceeded ${timeoutMs}ms.`,
        { phase: "source-reader", details: { timeoutMs } },
      ));
    }, timeoutMs);
    child.on("error", (error) => finish(new RefineryError(
      "SOURCE_READER_START_FAILED",
      `Could not start read-only source reader: ${error.message}`,
      { phase: "source-reader" },
    )));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxResponseBytes) {
        child.kill("SIGKILL");
        finish(new RefineryError(
          "SOURCE_READER_RESPONSE_TOO_LARGE",
          `Read-only source reader exceeded its ${maxResponseBytes}-byte response limit.`,
          { phase: "source-reader", details: { maxResponseBytes } },
        ));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      let response: SourceReaderResponse;
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as SourceReaderResponse;
      } catch (error) {
        finish(new RefineryError(
          "SOURCE_READER_PROTOCOL_ERROR",
          `Read-only source reader returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          { phase: "source-reader", details: { code, signal, stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2_000) } },
        ));
        return;
      }
      if (response.schemaVersion !== sourceReaderProtocolVersion || response.requestId !== requestId) {
        finish(new RefineryError("SOURCE_READER_PROTOCOL_ERROR", "Read-only source reader response identity is invalid.", { phase: "source-reader" }));
        return;
      }
      if (!response.ok || !response.corpus || !response.isolation) {
        finish(new RefineryError(
          response.error?.code ?? "SOURCE_READER_FAILED",
          response.error?.message ?? `Read-only source reader exited with code ${code ?? "unknown"}.`,
          { phase: response.error?.phase ?? "source-reader", details: response.error?.details },
        ));
        return;
      }
      try {
        finish(undefined, { corpus: validateCorpus(response.corpus, options), isolation: response.isolation });
      } catch (error) {
        finish(new RefineryError(
          "SOURCE_READER_PROTOCOL_ERROR",
          error instanceof Error ? error.message : String(error),
          { phase: "source-reader" },
        ));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function emptyIsolation(): IsolatedSourceCorpus["isolation"] {
  return {
    processSeparated: true,
    permissionModel: true,
    readRootCount: 0,
    writeProbeDenied: null,
  };
}

export async function readSourceCorpusIsolated(
  options: LoadSourceCorpusOptions,
  readerOptions: IsolatedSourceReaderOptions = {},
): Promise<IsolatedSourceCorpus> {
  const sessionEntries = options.sourceSpecs
    .map((spec, index) => ({ spec, index: options.sourceIndexes?.[index] ?? index }))
    .filter(({ spec }) => spec.kind === "codex:sessions");
  if (sessionEntries.length === 0) return readGenericSourceCorpusIsolated(options, readerOptions);
  const { loadCodexSessionsFromCatalogue } = await import("../sources/codex-session-catalogue.ts");

  const genericEntries = options.sourceSpecs
    .map((spec, index) => ({ spec, index: options.sourceIndexes?.[index] ?? index }))
    .filter(({ spec }) => spec.kind !== "codex:sessions");
  const generic = genericEntries.length > 0
    ? await readGenericSourceCorpusIsolated({
      ...options,
      sourceSpecs: genericEntries.map(({ spec }) => spec),
      sourceIndexes: genericEntries.map(({ index }) => index),
    }, readerOptions)
    : { corpus: { sourceSets: [], documents: [], activeMemories: [], warnings: [] }, isolation: emptyIsolation() };

  const sessionSources: LoadedSessionSource[] = [];
  for (const entry of sessionEntries) {
    sessionSources.push(await loadCodexSessionsFromCatalogue({
      spec: entry.spec,
      index: entry.index,
      project: options.project,
      scope: options.scope,
      home: options.home,
      limits: options.limits,
      now: options.now ?? new Date(),
    }));
  }
  const indexBySourceSetId = new Map<string, number>();
  generic.corpus.sourceSets.forEach((sourceSet, index) => {
    indexBySourceSetId.set(sourceSet.id, genericEntries[index]?.index ?? index);
  });
  sessionSources.forEach((source, index) => {
    indexBySourceSetId.set(source.sourceSet.id, sessionEntries[index]?.index ?? index);
  });
  const sourceSets = [
    ...generic.corpus.sourceSets,
    ...sessionSources.map((source) => source.sourceSet),
  ].sort((left, right) => (indexBySourceSetId.get(left.id) ?? 0) - (indexBySourceSetId.get(right.id) ?? 0));
  const documentOrder = new Map(sourceSets.map((sourceSet, index) => [sourceSet.id, index]));
  const documents = [
    ...generic.corpus.documents,
    ...sessionSources.flatMap((source) => source.documents),
  ].sort((left, right) => (documentOrder.get(left.sourceSet) ?? 0) - (documentOrder.get(right.sourceSet) ?? 0));
  return {
    corpus: {
      sourceSets,
      documents,
      activeMemories: generic.corpus.activeMemories,
      warnings: [...generic.corpus.warnings, ...sessionSources.flatMap((source) => source.warnings)],
    },
    isolation: {
      processSeparated: true,
      permissionModel: generic.isolation.permissionModel
        && sessionSources.every((source) => source.isolation.permissionModel),
      readRootCount: generic.isolation.readRootCount + sessionSources.length,
      writeProbeDenied: generic.isolation.writeProbeDenied,
    },
  };
}

export async function loadSourceCorpusIsolated(options: LoadSourceCorpusOptions): Promise<SourceCorpus> {
  return (await readSourceCorpusIsolated(options)).corpus;
}
import { resolveCodexMemoriesDir, resolveCodexSessionsDir, resolveCodexSkillRoots } from "./codex-paths.ts";
