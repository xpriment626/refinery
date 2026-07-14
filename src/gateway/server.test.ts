import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LibsqlGraphStore } from "../core/graph/libsql-store.ts";
import { syncMemoryGraph } from "../core/graph/sync.ts";
import { resolveRefineryPaths } from "../core/paths.ts";
import { createGatewayServer } from "./server.ts";

function request(options: {
  port: number;
  path: string;
  method?: string;
  token?: string;
  host?: string;
  origin?: string;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: options.method ?? "GET",
      headers: {
        Host: options.host ?? `127.0.0.1:${options.port}`,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(options.body) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("gateway validates Host, Origin, capability, methods, and bounded JSON", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-server-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const token = "test-capability-that-is-long-enough";
  const paths = resolveRefineryPaths({ home, cwd: project });
  const store = new LibsqlGraphStore(paths.graphIndexPath);
  syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:gateway"],
    items: [
      { sourceAdapter: "test", sourceKey: "memory:one", kind: "memory", scope: "project", project, label: "Gateway node one", content: "One", uri: null, metadata: {} },
      { sourceAdapter: "test", sourceKey: "memory:two", kind: "memory", scope: "project", project, label: "Gateway node two", content: "Two", uri: null, metadata: {} },
    ],
    edges: [{ sourceAdapter: "test", sourceKey: "memory:one", targetAdapter: "test", targetKey: "memory:two", kind: "SUPPORTS", confidence: 1, derivation: "test" }],
  });
  store.close();
  const gateway = createGatewayServer({ home, project, capability: token });
  const address = await gateway.listen();
  try {
    assert.equal(address.host, "127.0.0.1");
    const unauthenticated = await request({ port: address.port, path: "/api/v1/health" });
    assert.equal(unauthenticated.status, 401);
    assert.doesNotMatch(unauthenticated.body, new RegExp(token));

    const badHost = await request({ port: address.port, path: "/api/v1/health", token, host: "attacker.example" });
    assert.equal(badHost.status, 421);
    const badOrigin = await request({ port: address.port, path: "/api/v1/health", token, origin: "https://attacker.example" });
    assert.equal(badOrigin.status, 403);

    const health = await request({ port: address.port, path: "/api/v1/health", token, origin: `http://127.0.0.1:${address.port}` });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    assert.match(String(health.headers["content-security-policy"]), /default-src 'none'/);
    assert.doesNotMatch(health.body, new RegExp(token));

    const invalidMethod = await request({ port: address.port, path: "/api/v1/health", token, method: "POST" });
    assert.equal(invalidMethod.status, 405);
    const snapshot = await request({ port: address.port, path: "/api/v1/graph/snapshot?maxNodes=10&maxEdges=10", token });
    assert.equal(snapshot.status, 200);
    const snapshotJson = JSON.parse(snapshot.body) as { nodes: unknown[]; edges: unknown[]; changeSequence: number; graphPath?: string };
    assert.equal(snapshotJson.nodes.length, 2);
    assert.equal(snapshotJson.edges.length, 1);
    assert.equal(snapshotJson.changeSequence, 1);
    assert.equal(snapshotJson.graphPath, undefined);
    assert.doesNotMatch(snapshot.body, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const delta = await request({ port: address.port, path: `/api/v1/graph/delta?after=${snapshotJson.changeSequence}`, token });
    assert.equal(delta.status, 200);
    assert.equal(JSON.parse(delta.body).sequence, snapshotJson.changeSequence);
    const nodeId = (JSON.parse(snapshot.body) as { nodes: Array<{ id: string }> }).nodes[0]!.id;
    const inspection = await request({ port: address.port, path: `/api/v1/graph/node/${encodeURIComponent(nodeId)}`, token });
    assert.equal(inspection.status, 200);
    assert.doesNotMatch(inspection.body, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(JSON.parse(inspection.body).node.uri, undefined);
    assert.equal(JSON.parse(inspection.body).node.metadata, undefined);
    const planned = await request({ port: address.port, path: "/api/v1/graph/plan", token, method: "POST", body: JSON.stringify({ request: "Gateway node" }) });
    assert.equal(planned.status, 200);
    assert.doesNotMatch(planned.body, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(JSON.parse(planned.body).plan.objective, undefined);
    const missing = await request({ port: address.port, path: "/api/v1/graph/node/missing-node", token });
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.body, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const pushedEvent = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE event timed out")), 1_000);
      const eventRequest = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/v1/events",
        headers: { Host: `127.0.0.1:${address.port}`, Authorization: `Bearer ${token}` },
      });
      eventRequest.on("response", (eventResponse) => {
        let body = "";
        let published = false;
        eventResponse.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (!published && body.includes("event: connected")) {
            published = true;
            gateway.events.publish({ type: "graph-synced", occurredAt: "2026-07-11T00:00:00.000Z", projectKey: "test", payload: { changed: 2 } });
          }
          if (body.includes("event: graph-synced")) {
            clearTimeout(timeout);
            eventResponse.destroy();
            resolve(body);
          }
        });
      });
      eventRequest.on("error", reject);
      eventRequest.end();
    });
    assert.match(pushedEvent, /"changed":2/);
    const oversized = await request({ port: address.port, path: "/api/v1/graph/plan", token, method: "POST", body: JSON.stringify({ request: "x".repeat(70_000) }) });
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.body).error.code, "REQUEST_TOO_LARGE");
    const malformed = await request({ port: address.port, path: "/api/v1/graph/plan", token, method: "POST", body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error.code, "INVALID_JSON");
    const changes = await request({ port: address.port, path: "/api/v1/graph/changes?after=0", token });
    assert.equal(changes.status, 200);
    assert.equal(Array.isArray(JSON.parse(changes.body).changes), true);
    assert.equal(JSON.parse(changes.body).changes[0].delta, undefined);
  } finally {
    await gateway.close();
  }
});

test("gateway serves built UI assets with browser-safe MIME types", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-gateway-assets-"));
  const staticDir = path.join(tmp, "ui");
  fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><script type=module src=/assets/app.js></script>");
  fs.writeFileSync(path.join(staticDir, "assets", "app.js"), "export const ready = true;\n");
  fs.writeFileSync(path.join(staticDir, "assets", "app.css"), "body { color: black; }\n");
  const gateway = createGatewayServer({
    home: path.join(tmp, "home"),
    project: path.join(tmp, "project"),
    capability: "asset-test-capability",
    staticDir,
  });
  const address = await gateway.listen();
  try {
    const html = await request({ port: address.port, path: "/" });
    const script = await request({ port: address.port, path: "/assets/app.js" });
    const style = await request({ port: address.port, path: "/assets/app.css" });
    const missingScript = await request({ port: address.port, path: "/assets/missing.js" });
    assert.match(String(html.headers["content-type"]), /^text\/html/);
    assert.match(String(script.headers["content-type"]), /^text\/javascript/);
    assert.match(String(style.headers["content-type"]), /^text\/css/);
    assert.equal(missingScript.status, 404);
    assert.match(String(missingScript.headers["content-type"]), /^application\/json/);
    assert.equal(script.headers["x-content-type-options"], "nosniff");
  } finally {
    await gateway.close();
  }
});
