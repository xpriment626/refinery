import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refineryReviewSchemaVersion, } from "./types.js";
import { serializeRefineryError, RefineryError } from "./errors.js";
import { writeReviewArtifactManifest } from "./artifacts.js";
import {} from "./intents.js";
const DEFAULT_SINK_TIMEOUT_MS = 10_000;
const MAX_SINK_RESPONSE_TEXT_CHARS = 4000;
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
export function writeReviewFailureStatus(args) {
    const status = {
        ok: false,
        schemaVersion: refineryReviewSchemaVersion,
        command: "review",
        status: "failed",
        runId: args.runId,
        runDir: args.runDir,
        scope: args.scope,
        mode: args.mode,
        failedStep: args.error.failedStep ?? null,
        rawOutputPath: args.error.rawOutputPath ?? null,
        createdAt: args.createdAt,
        failedAt: new Date().toISOString(),
        error: serializeRefineryError(args.error),
        ...(args.intent ? { intent: args.intent } : {}),
        ...(args.request !== undefined ? { request: args.request } : {}),
    };
    writeJson(path.join(args.runDir, "status.json"), status);
    writeJson(path.join(args.runDir, "review.json"), status);
    writeReviewArtifactManifest({
        runDir: args.runDir,
        runId: args.runId,
        scope: args.scope,
        mode: args.mode,
        status: "failed",
        createdAt: args.createdAt,
        failedAt: status.failedAt,
        failedStep: status.failedStep,
        rawOutputPath: status.rawOutputPath,
        error: status.error,
        intent: args.intent,
        request: args.request,
    });
    return status;
}
export async function deliverReviewSink(sink, result) {
    const parsedUrl = new URL(sink.url);
    if (parsedUrl.protocol === "file:") {
        const target = fileURLToPath(parsedUrl);
        writeJson(target, result);
        return {
            url: sink.url,
            ok: true,
            status: 0,
            deliveredAt: new Date().toISOString(),
            responseText: target,
        };
    }
    const timeoutMs = sink.timeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(sink.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(sink.headers ?? {}),
            },
            body: JSON.stringify(result),
            signal: controller.signal,
        });
    }
    catch (error) {
        if (controller.signal.aborted) {
            throw new RefineryError("SINK_CALLBACK_TIMEOUT", `Review sink callback timed out after ${timeoutMs}ms.`, { phase: "sink" });
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
    const responseText = (await response.text()).slice(0, MAX_SINK_RESPONSE_TEXT_CHARS);
    const sinkResult = {
        url: sink.url,
        ok: response.ok,
        status: response.status,
        deliveredAt: new Date().toISOString(),
        responseText,
    };
    if (!response.ok) {
        throw new RefineryError("SINK_CALLBACK_FAILED", `Review sink callback failed with status ${response.status}: ${responseText}`, { phase: "sink", status: response.status });
    }
    return sinkResult;
}
//# sourceMappingURL=review.js.map