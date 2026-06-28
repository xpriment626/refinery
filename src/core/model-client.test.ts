import assert from "node:assert/strict";
import test from "node:test";
import { callOpenRouterChatWithMetadata } from "./model-client.ts";

test("callOpenRouterChatWithMetadata uses chat completions and returns redacted metadata", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        model: "deepseek/deepseek-v4-pro",
        usage: { prompt_tokens: 2, completion_tokens: 3 },
        choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await callOpenRouterChatWithMetadata({
      model: {
        provider: "openrouter",
        modelName: "deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.invalid/api/v1",
        apiKey: "secret-key",
      },
      system: "system prompt",
      user: "user prompt",
    });

    assert.equal(result.content, "{\"ok\":true}");
    assert.equal(result.metadata.responseId, "chatcmpl-test");
    assert.equal(result.metadata.finishReason, "stop");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://openrouter.invalid/api/v1/chat/completions");
    assert.equal((requests[0].init.headers as Record<string, string>).authorization, "Bearer secret-key");
    const body = JSON.parse(String(requests[0].init.body)) as { model: string; messages: unknown[] };
    assert.equal(body.model, "deepseek/deepseek-v4-pro");
    assert.equal(body.messages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
