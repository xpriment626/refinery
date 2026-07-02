#!/usr/bin/env node
import { buildSpecialistInstructions, buildSpecialistUserPrompt, specialists, } from "./core/specialists/index.js";
const tools = [
    {
        name: "refinery_list_specialists",
        description: "List storage-agnostic Refinery specialist contracts.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "refinery_get_specialist_contract",
        description: "Return one specialist prompt, input contract, output contract, and tool boundary.",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    enum: specialists.map((specialist) => specialist.name),
                },
            },
            required: ["name"],
            additionalProperties: false,
        },
    },
    {
        name: "refinery_build_specialist_prompt",
        description: "Build a stateless system/user prompt pair for a specialist over caller-provided input.",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    enum: specialists.map((specialist) => specialist.name),
                },
                input: {
                    description: "Caller-provided source slice, candidates, proposals, or context.",
                },
            },
            required: ["name", "input"],
            additionalProperties: false,
        },
    },
];
function getSpecialist(name) {
    if (typeof name !== "string")
        throw new Error("specialist name must be a string");
    const specialist = specialists.find((candidate) => candidate.name === name);
    if (!specialist)
        throw new Error(`Unknown specialist: ${name}`);
    return specialist;
}
function textResult(text, structuredContent) {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}
function handleToolCall(name, args = {}) {
    if (name === "refinery_list_specialists") {
        const result = specialists.map((specialist) => ({
            name: specialist.name,
            purpose: specialist.purpose,
            allowedTools: specialist.toolBoundary.allowedTools,
            forbiddenTools: specialist.toolBoundary.forbiddenTools,
        }));
        return textResult(JSON.stringify(result, null, 2), { specialists: result });
    }
    if (name === "refinery_get_specialist_contract") {
        const specialist = getSpecialist(args.name);
        return textResult(JSON.stringify(specialist, null, 2), { specialist });
    }
    if (name === "refinery_build_specialist_prompt") {
        const specialist = getSpecialist(args.name);
        const result = {
            specialist: specialist.name,
            system: buildSpecialistInstructions(specialist),
            user: buildSpecialistUserPrompt(args.input),
        };
        return textResult(JSON.stringify(result, null, 2), result);
    }
    throw new Error(`Unknown tool: ${name}`);
}
function response(id, result) {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function errorResponse(id, code, message) {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
export function handleMessage(message) {
    if (message.method === "notifications/initialized")
        return null;
    try {
        if (message.method === "initialize") {
            return response(message.id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "refinery-core", version: "0.0.1" },
            });
        }
        if (message.method === "tools/list") {
            return response(message.id, { tools });
        }
        if (message.method === "tools/call") {
            const params = message.params ?? {};
            const name = params.name;
            const args = params.arguments;
            if (typeof name !== "string")
                throw new Error("tools/call requires tool name");
            if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
                throw new Error("tools/call arguments must be an object");
            }
            return response(message.id, handleToolCall(name, (args ?? {})));
        }
        return errorResponse(message.id, -32601, `Method not found: ${message.method ?? "(missing)"}`);
    }
    catch (e) {
        return errorResponse(message.id, -32000, e.message);
    }
}
async function main() {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of process.stdin) {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                const out = handleMessage(JSON.parse(line));
                if (out)
                    process.stdout.write(out + "\n");
            }
            newline = buffer.indexOf("\n");
        }
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => {
        process.stderr.write(`Fatal MCP server error: ${e.stack}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=mcp.js.map