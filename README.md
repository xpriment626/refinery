# refinery

Refinery is a storage-agnostic memory refinement core. It defines specialist
contracts and runtime adapters for turning caller-provided session history,
source slices, existing memory candidates, and policy context into structured
memory-refinement outputs.

The core package does not require `refinery.db`, does not own customer memory
storage, and does not activate durable memory on its own. Persistence of
proposals, approvals, rejections, and final memories belongs to the integrating
app or customer-owned store unless the optional reference adapter is selected.

## Requirements

- Node.js >= 24.

## Product Boundary

Refinery core owns:

- framework-neutral specialist contracts under `src/core/specialists/`
- stateless prompt construction for each specialist
- runtime adapters such as the Mastra adapter under `src/runtimes/`
- a stateless MCP stdio surface for exposing specialist contracts and prompt
  construction

Integrators own:

- source discovery and normalization
- durable storage
- user approval workflows
- final memory writes, updates, supersessions, archives, and merges
- privacy, tenancy, auth, and customer-specific retention policy

The current Claude/Codex session-history plus SQLite implementation lives under
`examples/reference-sqlite/`. It is a runnable reference adapter for local
experiments, not the required product surface.

## Core Commands

```bash
# Run the storage-agnostic MCP stdio server.
npm run mcp

# Run all core and reference-adapter tests.
npm test
```

The core MCP server exposes:

- `refinery_list_specialists`
- `refinery_get_specialist_contract`
- `refinery_build_specialist_prompt`

These tools do not read or write SQLite. They expose the portable specialist
contracts that other runtimes, MCP hosts, or agent frameworks can bind to their
own data sources.

## Specialist Pipeline

The first refinement scaffold is:

```text
Capture -> Distillation -> Schema -> Relevance -> Relationship Review
```

Each specialist is defined as a prompt, input contract, output contract, and
tool boundary. The definitions are framework-neutral; Mastra is currently an
execution adapter, and Coral or another runtime can be added as another adapter.

Schema owns memory-type routing. It emits proposal-compatible `memory_type`
plus richer evaluation metadata: `primary_type`, optional `secondary_type`,
`type_confidence`, `type_rationale`, `ambiguities`, `durability`, and `ttl`.

Relationship Review is a bounded comparison pass. It classifies candidate
relationships as `novel`, `duplicate`, `refinement`, `contradiction`,
`supersession`, or `too_weak`. It does not write, promote, archive, or activate
memory.

## Reference SQLite Adapter

The optional reference adapter demonstrates one possible local implementation:

- import Claude Code JSONL session history and legacy `memory/*.md`
- copy raw source evidence into `.refinery/raw/`
- store source, memory, and proposal lifecycle rows in `.refinery/refinery.db`
- expose SQLite-backed MCP read tools
- run throwaway Mastra-backed specialist experiments against imported local data

```bash
# Create/migrate the local reference instance.
npm run reference:sqlite -- up

# Import Claude Code history for the current working directory.
cd /path/to/your/project
node /abs/path/to/refinery/examples/reference-sqlite/cli.ts import claude-code

# Or target another directory explicitly.
npm run reference:sqlite -- import claude-code --path /path/to/your/project

# Inspect reference-adapter data.
npm run reference:sqlite -- inspect sources
npm run reference:sqlite -- inspect memories

# Approval-gated proposal lifecycle in the reference adapter.
npm run reference:sqlite -- proposals seed
npm run reference:sqlite -- proposals list
npm run reference:sqlite -- proposals show <id>
npm run reference:sqlite -- proposals approve <id> [--by <actor>]
npm run reference:sqlite -- proposals reject <id> [--by <actor>]

# Run the SQLite-backed MCP stdio server.
npm run mcp:reference-sqlite
```

The reference MCP server exposes:

- `refinery_search_memory`
- `refinery_get_memory`
- `refinery_get_project_context`

Those tools are intentionally adapter-specific. They read from the reference
SQLite store under `REFINERY_HOME` or the default `.refinery/` instance.

## Reference Experiments

Throwaway specialist behavior tests are stored under `.refinery/experiments/`.
They are local artifacts, not canonical memory state.

```bash
cp .env.example .env
# set OPENROUTER_API_KEY in .env
npm run experiment:capture
npm run experiment:distillation
npm run experiment:schema
npm run experiment:relevance
npm run experiment:relationship-review
npm run experiment:workflow
```

Each experiment writes `input.json`, `output.raw.md`, `output.parsed.json`, and
`eval.md`. The sequential workflow experiment additionally writes per-step
artifacts under:

```text
.refinery/experiments/workflow-<timestamp>/
  input.json
  steps/
    capture/{input.json,output.raw.md,output.parsed.json}
    distillation/{input.json,output.raw.md,output.parsed.json}
    schema/{input.json,output.raw.md,output.parsed.json}
    relevance/{input.json,output.raw.md,output.parsed.json}
    relationship-review/{input.json,output.raw.md,output.parsed.json}
  workflow.output.json
  eval.md
```

Experiments do not write to `refinery.db`, create proposals, activate memory, or
involve Coral.

## Layout

```text
src/
  core/
    specialists/       # storage-agnostic specialist contracts and prompt helpers
  runtimes/
    mastra/            # Mastra adapter for specialist execution
  env.ts               # local model config loader
  mcp.ts               # storage-agnostic MCP stdio server

examples/
  reference-sqlite/
    cli.ts             # local reference adapter CLI
    config.ts          # .refinery path resolution
    db.ts              # node:sqlite schema and migrations
    discovery.ts       # Claude Code history discovery
    retrieval.ts       # SQLite active-memory retrieval
    proposals.ts       # reference approval lifecycle
    mcp.ts             # SQLite-backed MCP read tools
    experiments/       # local Mastra experiment harnesses
```
