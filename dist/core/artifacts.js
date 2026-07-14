import fs from "node:fs";
import path from "node:path";
import { refineryReviewSchemaVersion } from "./types.js";
import { RefineryError } from "./errors.js";
import {} from "./intents.js";
export const reviewStepOrder = [
    "claim-scout",
    "memory-cartographer",
    "evidence-auditor",
    "proposal-editor",
    "decision-synthesizer",
];
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function existingRel(runDir, relPath) {
    return fs.existsSync(path.join(runDir, relPath)) ? relPath : undefined;
}
function readArrayCount(runDir, relPath) {
    const filePath = path.join(runDir, relPath);
    if (!fs.existsSync(filePath))
        return 0;
    const parsed = readJson(filePath);
    return Array.isArray(parsed) ? parsed.length : 0;
}
function readOptionalObject(runDir, relPath) {
    const filePath = path.join(runDir, relPath);
    if (!fs.existsSync(filePath))
        return undefined;
    const parsed = readJson(filePath);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : undefined;
}
function buildStepArtifacts(runDir) {
    return Object.fromEntries(reviewStepOrder.map((step) => [
        step,
        {
            input: existingRel(runDir, `steps/${step}/input.json`),
            outputRaw: existingRel(runDir, `steps/${step}/output.raw.md`),
            outputParsed: existingRel(runDir, `steps/${step}/output.parsed.json`),
        },
    ]));
}
function buildArtifactPaths(runDir) {
    return {
        manifest: "manifest.json",
        input: existingRel(runDir, "input.json"),
        sourceCounts: existingRel(runDir, "source-counts.json"),
        metadata: existingRel(runDir, "metadata.json"),
        review: existingRel(runDir, "review.json"),
        proposals: existingRel(runDir, "proposals.json"),
        rejected: existingRel(runDir, "rejected.json"),
        claims: existingRel(runDir, "claims.json"),
        challengeLedger: existingRel(runDir, "challenge-ledger.json"),
        deliberation: existingRel(runDir, "deliberation.json"),
        responsibilityPlan: existingRel(runDir, "responsibility-plan.json"),
        graphContext: existingRel(runDir, "graph-context.json"),
        status: existingRel(runDir, "status.json"),
        sink: existingRel(runDir, "sink.json"),
        coral: existingRel(runDir, "coral.json"),
        transcript: existingRel(runDir, "transcript.json"),
        skillCandidates: existingRel(runDir, "skillCandidates.json"),
        steps: buildStepArtifacts(runDir),
    };
}
export function writeReviewArtifactManifest(args) {
    const counts = args.counts ?? {
        proposals: readArrayCount(args.runDir, "proposals.json"),
        rejected: readArrayCount(args.runDir, "rejected.json"),
    };
    const manifest = {
        ok: args.status === "succeeded",
        schemaVersion: refineryReviewSchemaVersion,
        command: "review",
        runId: args.runId,
        runDir: args.runDir,
        mode: args.mode,
        scope: args.scope,
        ...(args.intent ? { intent: args.intent } : {}),
        ...(args.request !== undefined ? { request: args.request } : {}),
        status: args.status,
        createdAt: args.createdAt,
        ...(args.failedAt ? { failedAt: args.failedAt } : {}),
        ...(args.failedStep !== undefined ? { failedStep: args.failedStep } : {}),
        ...(args.rawOutputPath !== undefined ? { rawOutputPath: args.rawOutputPath } : {}),
        counts,
        ...(args.metadata?.runtime && typeof args.metadata.runtime === "object"
            ? { runtime: args.metadata.runtime }
            : {}),
        ...(args.metadata?.model && typeof args.metadata.model === "object"
            ? { model: args.metadata.model }
            : {}),
        stepOrder: reviewStepOrder,
        artifacts: buildArtifactPaths(args.runDir),
        ...(args.error ? { error: args.error } : {}),
    };
    writeJson(path.join(args.runDir, "manifest.json"), manifest);
    return manifest;
}
function readManifest(runDir) {
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        throw new RefineryError("TRIAL_INVALID", "Run directory is missing manifest.json.", {
            phase: "trial-inspect",
            runDir,
        });
    }
    try {
        const parsed = readJson(manifestPath);
        if (parsed.schemaVersion !== refineryReviewSchemaVersion ||
            parsed.command !== "review" ||
            typeof parsed.runId !== "string" ||
            typeof parsed.runDir !== "string" ||
            (parsed.status !== "succeeded" && parsed.status !== "failed")) {
            throw new Error("manifest.json does not match the Refinery review manifest contract.");
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof RefineryError)
            throw error;
        throw new RefineryError("TRIAL_INVALID", error instanceof Error ? error.message : String(error), { phase: "trial-inspect", runDir });
    }
}
function readProposals(runDir) {
    const proposalsPath = path.join(runDir, "proposals.json");
    if (!fs.existsSync(proposalsPath))
        return [];
    const parsed = readJson(proposalsPath);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
}
function countByStringField(records, field) {
    const counts = {};
    for (const record of records) {
        const value = record[field];
        if (typeof value !== "string" || !value)
            continue;
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
}
function deliberationSummary(runDir) {
    const parsed = readOptionalObject(runDir, "deliberation.json");
    const summary = parsed && typeof parsed.summary === "object" && parsed.summary !== null && !Array.isArray(parsed.summary)
        ? parsed.summary
        : {};
    return {
        claims: typeof summary.claims === "number" ? summary.claims : readArrayCount(runDir, "claims.json"),
        challenges: typeof summary.challenges === "number" ? summary.challenges : readArrayCount(runDir, "challenge-ledger.json"),
        moves: typeof summary.moves === "number" ? summary.moves : 0,
        unresolvedChallenges: typeof summary.unresolvedChallenges === "number" ? summary.unresolvedChallenges : 0,
    };
}
function stepPresence(runDir) {
    return Object.fromEntries(reviewStepOrder.map((step) => [
        step,
        {
            input: fs.existsSync(path.join(runDir, `steps/${step}/input.json`)),
            outputRaw: fs.existsSync(path.join(runDir, `steps/${step}/output.raw.md`)),
            outputParsed: fs.existsSync(path.join(runDir, `steps/${step}/output.parsed.json`)),
        },
    ]));
}
export function inspectReviewRun(runDirInput) {
    const runDir = path.resolve(runDirInput);
    if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        throw new RefineryError("TRIAL_NOT_FOUND", `Run directory not found: ${runDir}`, {
            phase: "trial-inspect",
            runDir,
        });
    }
    const manifest = readManifest(runDir);
    const proposals = readProposals(runDir);
    const status = readOptionalObject(runDir, "status.json");
    const sink = readOptionalObject(runDir, "sink.json");
    return {
        ok: manifest.ok,
        command: "trial inspect",
        schemaVersion: manifest.schemaVersion,
        runId: manifest.runId,
        runDir,
        mode: manifest.mode,
        status: manifest.status,
        counts: manifest.counts ?? {
            proposals: proposals.length,
            rejected: readArrayCount(runDir, "rejected.json"),
        },
        actionDistribution: countByStringField(proposals, "action"),
        lifecycleDistribution: countByStringField(proposals, "lifecycle"),
        deliberation: deliberationSummary(runDir),
        steps: stepPresence(runDir),
        artifacts: manifest.artifacts,
        ...(sink ? { sink } : {}),
        ...(status?.error && typeof status.error === "object" ? { error: status.error } : {}),
        manifest,
    };
}
//# sourceMappingURL=artifacts.js.map