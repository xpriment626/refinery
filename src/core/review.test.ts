import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReview, type ReviewRunResult } from "./review.ts";
import type { MemoryStoreAdapter } from "./adapter.ts";

function fixtureAdapter(): MemoryStoreAdapter {
  return {
    name: "fixture-memory",
    async listSourceEvidence() {
      return [
        {
          id: "source:1",
          kind: "session",
          path: "/tmp/session.jsonl",
          text: "Refinery emits proposed memory maintenance; the host app owns durable mutation.",
          refs: [{ source_id: "source:1", chunk_index: 0 }],
        },
      ];
    },
    async searchSourceEvidence() {
      return this.listSourceEvidence({ scope: "project" });
    },
    async getSourceEvidence() {
      return null;
    },
    async listActiveMemories() {
      return [
        {
          id: "memory:1",
          type: "procedural",
          scope: "project",
          status: "active",
          body: "Refinery core stays storage agnostic.",
        },
      ];
    },
    async searchActiveMemories() {
      return this.listActiveMemories({ scope: "project" });
    },
    async getActiveMemory() {
      return null;
    },
  };
}

function startSinkServer(): Promise<{
  url: string;
  received: () => unknown[];
  close: () => Promise<void>;
}> {
  const received: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        body: JSON.parse(body),
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}/refinery-callback`,
        received: () => received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function startStatusSinkServer(status: number, body: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}/refinery-callback`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function startHangingSinkServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, _res) => {
    // Intentionally never respond; the sink timeout should abort this request.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}/refinery-callback`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("runReview posts a proposal sink callback after writing artifacts", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-review-sink-"));
  const sink = await startSinkServer();
  try {
    const result = await runReview({
      adapter: fixtureAdapter(),
      scope: "project",
      runId: "sink-test",
      outputDir,
      sink: { url: sink.url },
    });

    assert.equal(result.sink?.ok, true);
    assert.equal(result.sink?.status, 202);
    assert.equal(result.schemaVersion, "refinery.review.v1");
    assert.equal(sink.received().length, 1);
    const request = sink.received()[0] as {
      method: string;
      contentType: string;
      body: ReviewRunResult;
    };
    assert.equal(request.method, "POST");
    assert.match(request.contentType, /application\/json/);
    assert.equal(request.body.command, "review");
    assert.equal(request.body.schemaVersion, "refinery.review.v1");
    assert.equal(request.body.runId, "sink-test");
    assert.equal(request.body.proposals.length, 1);
    assert.equal(fs.existsSync(path.join(outputDir, "sink-test", "review.json")), true);
    assert.equal(fs.existsSync(path.join(outputDir, "sink-test", "sink.json")), true);
    const sinkArtifact = JSON.parse(
      fs.readFileSync(path.join(outputDir, "sink-test", "sink.json"), "utf8"),
    );
    assert.equal(sinkArtifact.ok, true);
    assert.equal(sinkArtifact.url, sink.url);
  } finally {
    await sink.close();
  }
});

test("runReview writes failed artifacts when an HTTP sink returns non-2xx", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-review-sink-fail-"));
  const sink = await startStatusSinkServer(503, "temporarily unavailable");
  try {
    await assert.rejects(
      () =>
        runReview({
          adapter: fixtureAdapter(),
          scope: "project",
          runId: "sink-fail-test",
          outputDir,
          sink: { url: sink.url },
        }),
      /Review sink callback failed/,
    );

    const status = JSON.parse(
      fs.readFileSync(path.join(outputDir, "sink-fail-test", "status.json"), "utf8"),
    );
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "SINK_CALLBACK_FAILED");
    assert.equal(status.runDir, path.join(outputDir, "sink-fail-test"));
  } finally {
    await sink.close();
  }
});

test("runReview aborts hanging sink callbacks with a timeout", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-review-sink-timeout-"));
  const sink = await startHangingSinkServer();
  try {
    await assert.rejects(
      () =>
        runReview({
          adapter: fixtureAdapter(),
          scope: "project",
          runId: "sink-timeout-test",
          outputDir,
          sink: { url: sink.url, timeoutMs: 20 },
        }),
      /timed out/,
    );

    const status = JSON.parse(
      fs.readFileSync(path.join(outputDir, "sink-timeout-test", "status.json"), "utf8"),
    );
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "SINK_CALLBACK_TIMEOUT");
  } finally {
    await sink.close();
  }
});
