import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getMemoryGraphStatus, inspectMemoryGraphNode, planMemoryGraph } from "../core/graph/service.js";
import { LibsqlGraphStore } from "../core/graph/libsql-store.js";
import { asRefineryError, serializeRefineryError } from "../core/errors.js";
import { projectKeyForPath, resolveRefineryPaths } from "../core/paths.js";
import { createGatewayEventBus } from "./conductor-seam.js";
const gatewayApiVersion = "refinery.gateway.v1";
const MAX_BODY_BYTES = 64 * 1024;
const staticContentTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".map", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".woff2", "font/woff2"],
]);
function staticContentType(filePath) {
    return staticContentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}
function secureHeaders(api) {
    return {
        "Cache-Control": "no-store",
        "Content-Security-Policy": api
            ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
    };
}
function writeJson(response, status, value) {
    const body = `${JSON.stringify(value)}\n`;
    response.writeHead(status, { ...secureHeaders(true), "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
}
function writeError(response, status, code, message, details) {
    writeJson(response, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}
function publicEdge(edge) {
    return { id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, kind: edge.kind, confidence: edge.confidence };
}
function publicPlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        id: plan.id,
        generatedAt: plan.generatedAt,
        limits: plan.limits,
        seeds: plan.seeds,
        selectedNodes: plan.selectedNodes.map(({ selectedText: _selectedText, ...selected }) => selected),
        traversedEdges: plan.traversedEdges.map(publicEdge),
        responsibilityUnits: plan.responsibilityUnits,
        awakeSeeds: plan.awakeSeeds,
        sleepingOneHop: plan.sleepingOneHop,
        exclusions: plan.exclusions.map(({ details: _details, ...exclusion }) => exclusion),
        budgetExhaustion: plan.budgetExhaustion,
        warnings: plan.warnings,
        runtimeProjection: plan.runtimeProjection,
    };
}
function writePublicGatewayFailure(response, error, statusHint) {
    const errorCode = typeof error?.code === "string"
        ? error.code
        : "GATEWAY_REQUEST_FAILED";
    const serialized = serializeRefineryError(asRefineryError(error, { code: errorCode, phase: "gateway-api" }));
    const status = statusHint ?? (serialized.code === "GRAPH_NODE_NOT_FOUND" || serialized.code === "GRAPH_INDEX_NOT_FOUND" ? 404 : 500);
    const message = serialized.code === "GRAPH_NODE_NOT_FOUND"
        ? "The requested graph node was not found. Refresh the graph snapshot and retry."
        : serialized.code === "GRAPH_INDEX_NOT_FOUND"
            ? "The local graph is unavailable. Run `refinery graph sync --json` and retry."
            : serialized.code === "GRAPH_PROJECT_MISMATCH"
                ? "The graph belongs to a different project. Restart the gateway for the requested project."
                : serialized.code === "INVALID_JSON"
                    ? "The request body is not valid JSON."
                    : serialized.code === "INVALID_JSON_BODY"
                        ? "The request body must be a JSON object."
                        : serialized.code === "REQUEST_TOO_LARGE"
                            ? "The request body exceeds the 64KB gateway limit."
                            : serialized.code === "CONTENT_TYPE_REQUIRED"
                                ? "Use Content-Type: application/json for this request."
                                : "The gateway request failed safely. Use the Refinery CLI for detailed local diagnostics.";
    writeJson(response, status, { ok: false, error: { code: serialized.code, message, phase: serialized.phase } });
}
function sameSecret(candidate, expected) {
    const left = crypto.createHash("sha256").update(candidate).digest();
    const right = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(left, right);
}
async function readJsonBody(request) {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > MAX_BODY_BYTES)
        throw Object.assign(new Error("request body exceeds 64KB"), { status: 413, code: "REQUEST_TOO_LARGE" });
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim();
    if (contentType !== "application/json")
        throw Object.assign(new Error("application/json is required"), { status: 415, code: "CONTENT_TYPE_REQUIRED" });
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw Object.assign(new Error("request body exceeds 64KB"), { status: 413, code: "REQUEST_TOO_LARGE" });
        chunks.push(buffer);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw Object.assign(new Error("request body is not valid JSON"), { status: 400, code: "INVALID_JSON" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw Object.assign(new Error("JSON body must be an object"), { status: 400, code: "INVALID_JSON_BODY" });
    }
    return parsed;
}
export function createGatewayServer(options) {
    const project = path.resolve(options.project);
    const home = path.resolve(options.home);
    const projectKey = projectKeyForPath(project);
    const events = createGatewayEventBus();
    const eventClients = new Set();
    let listenAddress = null;
    let closing = false;
    const closeEventClients = () => {
        for (const client of eventClients) {
            client.unsubscribe();
            client.response.end();
        }
        eventClients.clear();
    };
    const server = http.createServer(async (request, response) => {
        const api = request.url?.startsWith("/api/") ?? false;
        const expectedHosts = listenAddress
            ? new Set([`127.0.0.1:${listenAddress.port}`, `localhost:${listenAddress.port}`, `[::1]:${listenAddress.port}`])
            : new Set();
        const host = String(request.headers.host ?? "").toLowerCase();
        if (!expectedHosts.has(host)) {
            writeError(response, 421, "HOST_NOT_ALLOWED", "Gateway requests must use the active loopback host and port.");
            return;
        }
        const origin = request.headers.origin;
        if (origin) {
            const allowedOrigins = new Set([`http://127.0.0.1:${listenAddress.port}`, `http://localhost:${listenAddress.port}`, `http://[::1]:${listenAddress.port}`]);
            if (!allowedOrigins.has(origin)) {
                writeError(response, 403, "ORIGIN_NOT_ALLOWED", "Gateway request Origin is not allowed.");
                return;
            }
        }
        if (api) {
            const authorization = String(request.headers.authorization ?? "");
            const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
            if (!bearer || !sameSecret(bearer, options.capability)) {
                writeError(response, 401, "CAPABILITY_REQUIRED", "A valid gateway capability is required.");
                return;
            }
        }
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${listenAddress.port}`);
        try {
            if (url.pathname === "/api/v1/events") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for gateway events.");
                response.writeHead(200, {
                    ...secureHeaders(true),
                    "Content-Type": "text/event-stream; charset=utf-8",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                });
                let client;
                const unsubscribe = events.subscribe((event) => {
                    const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
                    if (!response.write(frame)) {
                        unsubscribe();
                        eventClients.delete(client);
                        response.end();
                    }
                });
                client = { response, unsubscribe };
                eventClients.add(client);
                request.on("close", () => {
                    unsubscribe();
                    eventClients.delete(client);
                });
                response.write(`event: connected\ndata: ${JSON.stringify({ ok: true, projectKey })}\n\n`);
                return;
            }
            if (url.pathname === "/api/v1/health") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for gateway health.");
                writeJson(response, 200, {
                    ok: true,
                    schemaVersion: gatewayApiVersion,
                    service: "refinery-gateway",
                    project: { key: projectKey, label: path.basename(project) || "project" },
                    uptimeSeconds: Math.floor(process.uptime()),
                });
                return;
            }
            if (url.pathname === "/api/v1/graph/status") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for graph status.");
                const status = getMemoryGraphStatus({ home, project });
                const { graphPath: _graphPath, project: _projectPath, ...publicStatus } = status;
                writeJson(response, 200, { ...publicStatus, project: { key: projectKey, label: path.basename(project) || "project" } });
                return;
            }
            if (url.pathname === "/api/v1/graph/snapshot") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for graph snapshots.");
                const maxNodes = Math.max(1, Math.min(50_000, Number(url.searchParams.get("maxNodes") ?? 25_000)));
                const maxEdges = Math.max(0, Math.min(200_000, Number(url.searchParams.get("maxEdges") ?? 100_000)));
                if (!Number.isFinite(maxNodes) || !Number.isFinite(maxEdges))
                    return writeError(response, 400, "INVALID_LIMIT", "Snapshot limits must be finite numbers.");
                const paths = resolveRefineryPaths({ home, cwd: project });
                const store = new LibsqlGraphStore(paths.graphIndexPath, { legacyJsonPath: paths.legacyGraphIndexPath });
                try {
                    const snapshot = store.readVisualizationSnapshot({ maxNodes, maxEdges });
                    if (!snapshot)
                        return writeError(response, 404, "GRAPH_INDEX_NOT_FOUND", "Run refinery graph sync before opening the graph UI.", { next: "refinery graph sync --json" });
                    writeJson(response, 200, { ok: true, ...snapshot });
                }
                finally {
                    store.close();
                }
                return;
            }
            if (url.pathname === "/api/v1/graph/delta") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for graph deltas.");
                const after = Number(url.searchParams.get("after") ?? 0);
                if (!Number.isSafeInteger(after) || after < 0)
                    return writeError(response, 400, "INVALID_SEQUENCE", "Delta sequence must be a non-negative safe integer.");
                const paths = resolveRefineryPaths({ home, cwd: project });
                const store = new LibsqlGraphStore(paths.graphIndexPath, { legacyJsonPath: paths.legacyGraphIndexPath });
                try {
                    writeJson(response, 200, { ok: true, ...store.readVisualizationDelta({ afterSequence: after, maxEvents: 50 }) });
                }
                finally {
                    store.close();
                }
                return;
            }
            if (url.pathname.startsWith("/api/v1/graph/node/")) {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for node inspection.");
                const nodeId = decodeURIComponent(url.pathname.slice("/api/v1/graph/node/".length));
                if (!nodeId || nodeId.length > 512)
                    return writeError(response, 400, "INVALID_NODE_ID", "Node id is missing or too long.");
                const inspection = inspectMemoryGraphNode({ home, project, nodeId });
                const maxContentChars = 50_000;
                const contentTruncated = inspection.revision.content.length > maxContentChars;
                writeJson(response, 200, {
                    ok: true,
                    command: inspection.command,
                    node: {
                        id: inspection.node.id,
                        label: inspection.node.label,
                        kind: inspection.node.kind,
                        scope: inspection.node.scope,
                        sourceAdapter: inspection.node.sourceAdapter,
                        hasUri: Boolean(inspection.node.uri),
                    },
                    revision: {
                        id: inspection.revision.id,
                        nodeId: inspection.revision.nodeId,
                        content: inspection.revision.content.slice(0, maxContentChars),
                        indexedAt: inspection.revision.indexedAt,
                        sourceModifiedAt: inspection.revision.sourceModifiedAt,
                        charCount: inspection.revision.charCount,
                        contentTruncated,
                    },
                    incomingEdges: inspection.incomingEdges.map(publicEdge),
                    outgoingEdges: inspection.outgoingEdges.map(publicEdge),
                    truncated: inspection.truncated,
                });
                return;
            }
            if (url.pathname === "/api/v1/graph/plan") {
                if (request.method !== "POST")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use POST for graph planning.");
                const body = await readJsonBody(request);
                if (typeof body.request !== "string" || body.request.length > 20_000)
                    return writeError(response, 400, "INVALID_REQUEST", "Plan request must be a string no longer than 20,000 characters.");
                const seeds = Array.isArray(body.seeds) ? body.seeds.filter((seed) => typeof seed === "string").slice(0, 20) : [];
                const planned = planMemoryGraph({ home, project, scope: "project", request: body.request, explicitNodeIds: seeds });
                writeJson(response, 200, { ok: true, command: "graph plan", retrieval: planned.retrieval, plan: publicPlan(planned.plan) });
                return;
            }
            if (url.pathname === "/api/v1/graph/changes") {
                if (request.method !== "GET")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use GET for graph changes.");
                const after = Number(url.searchParams.get("after") ?? 0);
                if (!Number.isSafeInteger(after) || after < 0)
                    return writeError(response, 400, "INVALID_SEQUENCE", "Change sequence must be a non-negative safe integer.");
                const paths = resolveRefineryPaths({ home, cwd: project });
                const store = new LibsqlGraphStore(paths.graphIndexPath, { legacyJsonPath: paths.legacyGraphIndexPath });
                try {
                    const changes = store.readChanges({ afterSequence: after, limit: 20 });
                    const latestSequence = store.diagnostics().changeSequence;
                    writeJson(response, 200, {
                        ok: true,
                        afterSequence: after,
                        latestSequence,
                        hasMore: (changes.at(-1)?.sequence ?? after) < latestSequence,
                        changes: changes.map((change) => ({
                            sequence: change.sequence,
                            syncedAt: change.syncedAt,
                            counts: {
                                createdNodes: change.delta.createdNodeIds.length,
                                updatedNodes: change.delta.updatedNodeIds.length,
                                removedNodes: change.delta.removedNodeIds.length,
                                createdRevisions: change.delta.createdRevisionIds.length,
                                removedRevisions: change.delta.removedRevisionIds.length,
                                createdEdges: change.delta.createdEdgeIds.length,
                                updatedEdges: change.delta.updatedEdgeIds.length,
                                removedEdges: change.delta.removedEdgeIds.length,
                            },
                        })),
                    });
                }
                finally {
                    store.close();
                }
                return;
            }
            if (url.pathname === "/api/v1/events/publish") {
                if (request.method !== "POST")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use POST to publish an event.");
                const body = await readJsonBody(request);
                if (body.type !== "graph-synced")
                    return writeError(response, 400, "INVALID_EVENT", "Only graph-synced events are accepted.");
                const incomingPayload = typeof body.payload === "object" && body.payload ? body.payload : {};
                const changed = typeof incomingPayload.changed === "object" && incomingPayload.changed ? incomingPayload.changed : {};
                const event = events.publish({
                    type: "graph-synced",
                    occurredAt: new Date().toISOString(),
                    projectKey,
                    payload: {
                        ...(typeof incomingPayload.syncedAt === "string" ? { syncedAt: incomingPayload.syncedAt.slice(0, 64) } : {}),
                        changed: {
                            nodes: Number.isSafeInteger(changed.nodes) ? Math.max(0, Number(changed.nodes)) : 0,
                            edges: Number.isSafeInteger(changed.edges) ? Math.max(0, Number(changed.edges)) : 0,
                        },
                    },
                });
                writeJson(response, 202, { ok: true, sequence: event.sequence });
                return;
            }
            if (url.pathname === "/api/v1/shutdown") {
                if (request.method !== "POST")
                    return writeError(response, 405, "METHOD_NOT_ALLOWED", "Use POST to stop the gateway.");
                if (closing)
                    return writeJson(response, 202, { ok: true, stopping: true });
                closing = true;
                events.publish({ type: "gateway-stopping", occurredAt: new Date().toISOString(), projectKey, payload: {} });
                writeJson(response, 202, { ok: true, stopping: true });
                setImmediate(async () => {
                    await options.onShutdown?.();
                    closeEventClients();
                    server.close();
                });
                return;
            }
            if (api) {
                writeError(response, 404, "API_NOT_FOUND", "Gateway API route not found.");
                return;
            }
            if (request.method !== "GET" && request.method !== "HEAD")
                return writeError(response, 405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported for UI assets.");
            const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
            const staticRoot = options.staticDir ? path.resolve(options.staticDir) : null;
            const filePath = staticRoot ? path.resolve(staticRoot, relative) : null;
            if (filePath && filePath.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const body = fs.readFileSync(filePath);
                response.writeHead(200, { ...secureHeaders(false), "Content-Type": staticContentType(filePath), "Content-Length": body.length });
                response.end(request.method === "HEAD" ? undefined : body);
                return;
            }
            const fallback = "<!doctype html><meta charset=utf-8><title>Refinery</title><main>Refinery UI is not built.</main>";
            if (path.extname(relative)) {
                writeError(response, 404, "UI_ASSET_NOT_FOUND", "UI asset not found.");
                return;
            }
            response.writeHead(200, { ...secureHeaders(false), "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(fallback) });
            response.end(request.method === "HEAD" ? undefined : fallback);
        }
        catch (error) {
            const record = error;
            writePublicGatewayFailure(response, error, record.status);
        }
    });
    return {
        events,
        listen(port = 0) {
            return new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, "127.0.0.1", () => {
                    server.off("error", reject);
                    const address = server.address();
                    if (!address || typeof address === "string")
                        return reject(new Error("gateway did not receive a TCP address"));
                    listenAddress = { host: "127.0.0.1", port: address.port };
                    events.publish({ type: "gateway-started", occurredAt: new Date().toISOString(), projectKey, payload: { port: address.port } });
                    resolve(listenAddress);
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                closeEventClients();
                if (!server.listening)
                    return resolve();
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}
//# sourceMappingURL=server.js.map