import assert from "node:assert/strict";
import test from "node:test";
import { callCoralChatWithMetadata } from "./model-client.ts";

test("callCoralChatWithMetadata uses Coral streaming chat completions", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        [
          'data: {"id":"coral-chatcmpl-test","model":"gpt-5.4-nano","choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"gpt-5.4-nano","choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"gpt-5.4-nano","choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}',
          "",
          'data: {"id":"coral-chatcmpl-test","model":"gpt-5.4-nano","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
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
    const result = await callCoralChatWithMetadata({
      model: {
        provider: "coral",
        modelName: "gpt-5.4-nano",
        baseUrl: "https://llm.coralcloud.ai/openai/v1",
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
    assert.equal(requests[0].url, "https://llm.coralcloud.ai/openai/v1/chat/completions");
    assert.equal((requests[0].init.headers as Record<string, string>).authorization, "Bearer coral-secret");
    const body = JSON.parse(String(requests[0].init.body)) as { model: string; stream: boolean; stream_options: unknown };
    assert.equal(body.model, "gpt-5.4-nano");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
