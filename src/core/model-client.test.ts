import assert from "node:assert/strict";
import test from "node:test";
import { callOpenAiCompatibleChatWithMetadata } from "./model-client.ts";

test("callOpenAiCompatibleChatWithMetadata uses chat completions and returns redacted metadata", async () => {
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
    const result = await callOpenAiCompatibleChatWithMetadata({
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

test("callOpenAiCompatibleChatWithMetadata supports Coral DeepSeek proxy as an OpenAI-compatible endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        [
          'data: {"id":"coral-chatcmpl-test","model":"deepseek-v4-pro","choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"deepseek-v4-pro","choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"deepseek-v4-pro","choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ));
      controller.close();
    },
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const result = await callOpenAiCompatibleChatWithMetadata({
      model: {
        provider: "coral",
        modelName: "deepseek-v4-pro",
        baseUrl: "https://llm.coralcloud.ai/deepseek/v1",
        apiKey: "coral-secret",
      },
      system: "system prompt",
      user: "user prompt",
    });

    assert.equal(result.content, "{\"ok\":true}");
    assert.equal(result.metadata.provider, "coral");
    assert.equal(result.metadata.responseId, "coral-chatcmpl-test");
    assert.deepEqual(result.metadata.usage, { prompt_tokens: 2, completion_tokens: 3 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://llm.coralcloud.ai/deepseek/v1/chat/completions");
    assert.equal((requests[0].init.headers as Record<string, string>).authorization, "Bearer coral-secret");
    const body = JSON.parse(String(requests[0].init.body)) as { model: string; stream: boolean; stream_options: unknown };
    assert.equal(body.model, "deepseek-v4-pro");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
