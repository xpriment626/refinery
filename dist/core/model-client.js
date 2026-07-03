import { defaultModelMaxTokens } from "../env.js";
function shouldStreamChat(model) {
    if (model.provider.toLowerCase() === "coral")
        return true;
    try {
        return new URL(model.baseUrl).hostname.endsWith("coralcloud.ai");
    }
    catch {
        return model.baseUrl.includes("coralcloud.ai");
    }
}
function chatRequestBody(request) {
    const stream = shouldStreamChat(request.model);
    return {
        model: request.model.modelName,
        messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
        ],
        temperature: 0.1,
        max_tokens: request.model.maxTokens ?? defaultModelMaxTokens,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
}
function processStreamEvent(args) {
    const dataLines = args.rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    for (const data of dataLines) {
        if (data === "[DONE]")
            continue;
        const json = JSON.parse(data);
        if (typeof json.id === "string")
            args.metadata.responseId ??= json.id;
        if (typeof json.model === "string")
            args.metadata.responseModel ??= json.model;
        if (json.usage !== undefined)
            args.metadata.usage = json.usage;
        for (const choice of json.choices ?? []) {
            if (typeof choice.delta?.content === "string")
                args.content.push(choice.delta.content);
            if (typeof choice.finish_reason === "string")
                args.metadata.finishReason = choice.finish_reason;
        }
    }
}
async function readStreamingChatResponse(response, model) {
    if (!response.body) {
        throw new Error(`${model.provider} streaming response did not include a response body.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const content = [];
    const metadata = {
        responseId: null,
        responseModel: null,
        finishReason: null,
        usage: null,
    };
    let buffer = "";
    while (true) {
        const { value, done } = await reader.read();
        if (value) {
            buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
            let separatorIndex = buffer.indexOf("\n\n");
            while (separatorIndex >= 0) {
                const rawEvent = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + 2);
                processStreamEvent({ rawEvent, model, content, metadata });
                separatorIndex = buffer.indexOf("\n\n");
            }
        }
        if (done)
            break;
    }
    buffer += decoder.decode().replace(/\r\n/g, "\n");
    if (buffer.trim()) {
        processStreamEvent({ rawEvent: buffer, model, content, metadata });
    }
    const combined = content.join("");
    if (!combined.trim()) {
        throw new Error(`${model.provider} response did not include message content.`);
    }
    return {
        content: combined,
        metadata: {
            provider: model.provider,
            baseUrl: model.baseUrl,
            modelName: model.modelName,
            status: response.status,
            responseId: metadata.responseId,
            responseModel: metadata.responseModel,
            finishReason: metadata.finishReason,
            usage: metadata.usage,
        },
    };
}
export async function callOpenAiCompatibleChatWithMetadata(request) {
    const response = await fetch(`${request.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${request.model.apiKey}`,
        },
        body: JSON.stringify(chatRequestBody(request)),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`${request.model.provider} request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    if (shouldStreamChat(request.model)) {
        return readStreamingChatResponse(response, request.model);
    }
    const json = (await response.json());
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
        throw new Error(`${request.model.provider} response did not include message content.`);
    }
    return {
        content,
        metadata: {
            provider: request.model.provider,
            baseUrl: request.model.baseUrl,
            modelName: request.model.modelName,
            status: response.status,
            responseId: typeof json.id === "string" ? json.id : null,
            responseModel: typeof json.model === "string" ? json.model : null,
            finishReason: typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : null,
            usage: json.usage ?? null,
        },
    };
}
//# sourceMappingURL=model-client.js.map