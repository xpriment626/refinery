import assert from "node:assert/strict";
import test from "node:test";
import { verifyCoralCredential } from "./verification.ts";

test("Coral credential verification uses registry and model catalogue without generation", async () => {
  const requests: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (url.endsWith("/api/v1/registry")) return Response.json([]);
    if (url.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "gpt-5.4-nano" }] });
    return new Response(null, { status: 404 });
  };
  const result = await verifyCoralCredential({
    apiKey: "coral-test-secret",
    cloudApiUrl: "http://127.0.0.1:4111",
    modelBaseUrl: "http://127.0.0.1:4222/openai/v1",
    fetchImpl,
    now: new Date("2026-07-15T00:00:00.000Z"),
  });

  assert.equal(result.verified, true);
  assert.equal(result.modelCatalogue.modelName, "gpt-5.4-nano");
  assert.deepEqual(requests.map((request) => request.method), ["GET", "GET"]);
  assert.equal(requests.every((request) => request.auth === "Bearer coral-test-secret"), true);
  assert.equal(requests.some((request) => /chat|completion|response/i.test(request.url)), false);
  assert.doesNotMatch(JSON.stringify(result), /coral-test-secret/);
});

test("Coral credential verification rejects auth failures without reflecting secrets", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "coral-test-secret" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    verifyCoralCredential({
      apiKey: "coral-test-secret",
      cloudApiUrl: "http://127.0.0.1:4111",
      modelBaseUrl: "http://127.0.0.1:4222/openai/v1",
      fetchImpl,
    }),
    (error: Error) => !error.message.includes("coral-test-secret") && /HTTP 401/.test(error.message),
  );
});
