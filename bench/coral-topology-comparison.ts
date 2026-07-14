import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

interface RunMetrics {
  runId: string;
  topology: string;
  inputIdentity: string;
  model: string | null;
  callCount: number;
  status200Count: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptChars: number;
  proposalCount: number;
  citationValidity: number;
  unsupportedFinalProposals: number;
  duplicateFinalRate: number;
  normalizedConclusions: string[];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((value) => Object.keys(value).length > 0) : [];
}

function readJson(filePath: string): JsonRecord {
  return record(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function referenceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referenceIds);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as JsonRecord).flatMap(([key, entry]) => {
    if (entry && typeof entry === "object") return referenceIds(entry);
    return /(?:^|_)(?:id|uri)$/.test(key) && (typeof entry === "string" || typeof entry === "number")
      ? [String(entry)]
      : [];
  });
}

function normalizeConclusion(proposal: JsonRecord): string {
  const body = typeof proposal.body === "string"
    ? proposal.body
    : typeof proposal.replacementBody === "string" ? proposal.replacementBody : "";
  const action = typeof proposal.action === "string" ? proposal.action : "";
  return `${action}\0${body.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export function auditCoralRun(runDir: string): RunMetrics {
  const input = readJson(path.join(runDir, "input.json"));
  const paid = readJson(path.join(runDir, "paid-run.json"));
  const review = readJson(path.join(runDir, "review.json"));
  const usage = record(paid.usage);
  const proposals = records(review.proposals);
  const packet = record(input.derivedViews);
  const chunks = records(packet.source_chunks);
  const allowedIds = new Set(chunks.flatMap((chunk) => [
    ...(typeof chunk.id === "string" ? [chunk.id] : []),
    ...(typeof chunk.uri === "string" ? [chunk.uri] : []),
    ...referenceIds(chunk.refs),
  ]));
  const supported = proposals.filter((proposal) => {
    const refs = Array.isArray(proposal.sourceRefs) ? proposal.sourceRefs : [];
    return refs.length > 0 && refs.every((ref) => referenceIds(ref).some((id) => allowedIds.has(id)));
  }).length;
  const normalized = proposals.map(normalizeConclusion).filter(Boolean).sort();
  const unique = new Set(normalized);
  return {
    runId: typeof review.runId === "string" ? review.runId : path.basename(runDir),
    topology: typeof paid.topology === "string" ? paid.topology : "unknown",
    inputIdentity: hashJson(input),
    model: typeof paid.model === "string" ? paid.model : null,
    callCount: number(usage.callCount),
    status200Count: number(usage.status200Count),
    promptTokens: nullableNumber(usage.promptTokens),
    completionTokens: nullableNumber(usage.completionTokens),
    totalTokens: nullableNumber(usage.totalTokens),
    promptChars: number(usage.promptChars),
    proposalCount: proposals.length,
    citationValidity: proposals.length === 0 ? 1 : supported / proposals.length,
    unsupportedFinalProposals: proposals.length - supported,
    duplicateFinalRate: normalized.length === 0 ? 0 : (normalized.length - unique.size) / normalized.length,
    normalizedConclusions: normalized,
  };
}

function reduction(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before <= 0) return null;
  return (before - after) / before;
}

export function compareCoralTopologyRuns(baselineDir: string, sparseDir: string): JsonRecord {
  const baseline = auditCoralRun(path.resolve(baselineDir));
  const sparse = auditCoralRun(path.resolve(sparseDir));
  const callReduction = reduction(baseline.callCount, sparse.callCount);
  const tokenReduction = reduction(baseline.totalTokens, sparse.totalTokens);
  const promptCharReduction = reduction(baseline.promptChars, sparse.promptChars);
  const conclusionParity = JSON.stringify(baseline.normalizedConclusions) === JSON.stringify(sparse.normalizedConclusions);
  const thresholds = {
    identicalInput: baseline.inputIdentity === sparse.inputIdentity,
    provider200s: baseline.status200Count === baseline.callCount && sparse.status200Count === sparse.callCount,
    citationValidity: baseline.citationValidity === 1 && sparse.citationValidity === 1,
    unsupportedFinalProposals: baseline.unsupportedFinalProposals === 0 && sparse.unsupportedFinalProposals === 0,
    duplicateFinalRate: baseline.duplicateFinalRate <= 0.05 && sparse.duplicateFinalRate <= 0.05,
    efficiency: (callReduction ?? -Infinity) >= 0.5 || (tokenReduction ?? -Infinity) >= 0.5,
    noQualityRegression: conclusionParity,
  };
  return {
    schemaVersion: "refinery.coral-topology-comparison.v1",
    corpusIdentity: baseline.inputIdentity,
    baseline,
    sparse,
    reductions: { callReduction, tokenReduction, promptCharReduction },
    conclusionParity,
    thresholds,
    pass: Object.values(thresholds).every(Boolean),
  };
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const baseline = argument("--baseline");
  const sparse = argument("--sparse");
  if (!baseline || !sparse) throw new Error("Usage: coral-topology-comparison --baseline <run-dir> --sparse <run-dir> [--output <json>]");
  const result = compareCoralTopologyRuns(baseline, sparse);
  const output = argument("--output");
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
}
