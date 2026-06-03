#!/usr/bin/env node
import { resolvePaths } from "./config.ts";
import { getMemory, getProjectContext, searchMemory } from "./retrieval.ts";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const tools = [
  {
    name: "refinery_search_memory",
    description: "Search active project-scoped Refinery memories with provenance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Lexical query over memory body and provenance." },
        limit: { type: "number", description: "Maximum number of memories to return." },
        type: { type: "string", description: "Optional memory type filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "refinery_get_memory",
    description: "Get one active project-scoped Refinery memory by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "refinery_get_project_context",
    description:
      "Return readable project-context synthesis plus structured supporting active memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or topic to orient around." },
        limit: { type: "number", description: "Maximum number of supporting memories." },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text: string, structuredContent: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function handleToolCall(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const paths = resolvePaths();
  if (name === "refinery_search_memory") {
    const result = searchMemory(paths, {
      query: typeof args.query === "string" ? args.query : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      type: typeof args.type === "string" ? args.type : undefined,
    });
    return textResult(JSON.stringify(result, null, 2), { memories: result });
  }

  if (name === "refinery_get_memory") {
    if (typeof args.id !== "number") throw new Error("refinery_get_memory requires numeric id");
    const result = getMemory(paths, { id: args.id });
    return textResult(result ? JSON.stringify(result, null, 2) : "Memory not found.", {
      memory: result,
    });
  }

  if (name === "refinery_get_project_context") {
    const result = getProjectContext(paths, {
      query: typeof args.query === "string" ? args.query : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return textResult(result.orientation, result);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function response(id: JsonRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errorResponse(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function handleMessage(message: JsonRpcRequest): string | null {
  if (message.method === "notifications/initialized") return null;

  try {
    if (message.method === "initialize") {
      return response(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "refinery", version: "0.0.1" },
      });
    }

    if (message.method === "tools/list") {
      return response(message.id, { tools });
    }

    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = params.name;
      const args = params.arguments;
      if (typeof name !== "string") throw new Error("tools/call requires tool name");
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        throw new Error("tools/call arguments must be an object");
      }
      return response(message.id, handleToolCall(name, (args ?? {}) as Record<string, unknown>));
    }

    return errorResponse(message.id, -32601, `Method not found: ${message.method ?? "(missing)"}`);
  } catch (e) {
    return errorResponse(message.id, -32000, (e as Error).message);
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const out = handleMessage(JSON.parse(line) as JsonRpcRequest);
        if (out) process.stdout.write(out + "\n");
      }
      newline = buffer.indexOf("\n");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`Fatal MCP server error: ${(e as Error).stack}\n`);
    process.exit(1);
  });
}
