# refinery

Local Refinery memory service — **Stage A local memory slice**.

This is a reroll-driven vertical slice. It imports real Claude Code history for
a working directory into a local canonical store, lets you inspect it, governs
proposal activation, and exposes active project memories through MCP read tools.
Live LLM refinement, Coral coordination, the dashboard, the watcher, auth,
vector search, source-snapshot writes, and cloud deployment remain out of scope
for this slice.

## Requirements

- Node.js >= 24 (uses built-in `node:sqlite` and native TypeScript type
  stripping — no build step, no native modules to compile).

## Commands

```bash
# Start the local Refinery instance (create/migrate the relational store + raw
# source store). This is the single startup command.
node src/cli.ts up

# Import Claude Code history for the CURRENT working directory.
# The encoded Claude project path is derived from the cwd at runtime — never
# hardcoded — so this works from any project directory.
cd /path/to/your/project
node /abs/path/to/refinery/src/cli.ts import claude-code
#   ...or target another directory explicitly:
node src/cli.ts import claude-code --path /path/to/your/project

# Inspect what was imported.
node src/cli.ts inspect sources    # JSONL sessions + legacy memory files, with provenance
node src/cli.ts inspect memories   # memories (active/superseded/archived), with provenance

# Proposal review & activation (approval-gated lifecycle).
node src/cli.ts proposals seed              # insert deterministic seed proposals (idempotent)
node src/cli.ts proposals list              # list proposals + lifecycle status
node src/cli.ts proposals show <id>         # full 8-field proposal contract
node src/cli.ts proposals approve <id> [--by <actor>]   # the ONLY path to active memory
node src/cli.ts proposals reject  <id> [--by <actor>]   # never becomes active

# Run the MCP stdio server for agent-facing read tools.
node src/mcp.ts
```

`npm run refinery -- <args>` is also wired as a convenience.
`npm run mcp` starts the MCP stdio server. `npm test` runs the local smoke tests.
`npm run experiment:<specialist>` runs one throwaway Mastra-backed specialist
LLM smoke test using the local `.env` model config.

## What it does

- **Discovery.** Maps the working directory to its Claude Code project-history
  folder (`~/.claude/projects/<encoded-path>`) by deriving the encoding at
  runtime (`/` and `.` → `-`).
- **Import.** Ingests every top-level `*.jsonl` session and every legacy
  `memory/*.md` file. Legacy memory files are imported as **active** memories
  tagged with provenance `claude-memory-legacy`. Source files are read-only and
  never modified; raw bytes are copied into a content-addressed raw store.
- **Idempotent.** Re-running the import does not duplicate rows
  (`UNIQUE(project_id, source_path)` and `UNIQUE(source_id)`).
- **Inspectable.** Both sources and active memories list back with provenance
  (source path, content hash, timestamps).

## Proposal lifecycle (governance spine)

Durable memory is governed (pattern-language §5: proposals-not-direct-writes).
A proposal carries the full eight-field contract — memory type, proposed scope,
atomic body, confidence, rationale, source transcript references, suggested
mutation operation (`create`/`update`/`supersede`/`archive`/`merge`), and an
existing-memory target when the op is not `create`.

```
proposal (status 'proposed')
  --approve--> ACTIVE memory   (records approver + timestamp; memory links back
               (the only path)   to its originating proposal + source evidence)
  --reject---> status 'rejected' (never activates)
```

Activation side-effects by op: `create` adds one active memory; `update` /
`supersede` / `merge` add the new memory and demote the target to `superseded`
(net active unchanged); `archive` moves the target to `archived`. **Nothing
becomes active except through an explicit `approve`.** This slice seeds
proposals deterministically; the LLM refiner that generates them is a later
slice and plugs into this same contract.

## MCP read tools

The Stage A MCP server runs over stdio and exposes read-only tools:

- `refinery_search_memory` — searches active project-scoped memories and returns
  structured records with provenance.
- `refinery_get_memory` — hydrates one active project-scoped memory by id.
- `refinery_get_project_context` — returns readable project-context synthesis
  plus structured supporting memories and provenance identifiers.

The tools read from the canonical SQLite store under `REFINERY_HOME` or the
default `.refinery/` instance. They do not write source snapshots, generate
proposals, or activate memory.

## Local specialist scaffold

The first local refinement scaffold lives under `src/specialists/`:

```
Capture -> Distillation -> Schema -> Relevance
```

Each specialist is separate code with a prompt, input contract, output contract,
and allowed/forbidden tool boundary. The sequential harness describes the local
handoff shape. The live experiment runtime wraps those same framework-neutral
specialist definitions as Mastra agents; Mastra is the execution adapter, not
the domain contract. Coral coordination is a later substitution for the
harness, not part of this slice.

## Local LLM experiments

Throwaway specialist behavior tests are stored under `.refinery/experiments/`.
They are local instance artifacts, not canonical memory state.

```bash
cp .env.example .env
# set OPENROUTER_API_KEY in .env
npm run experiment:capture
npm run experiment:distillation
npm run experiment:schema
npm run experiment:relevance
```

Each experiment writes `input.json`, wraps the specialist as a Mastra agent,
calls the configured OpenRouter model through Mastra, saves `output.raw.md`,
validates the specialist output contract into `output.parsed.json`, and writes
`eval.md`. Capture selects a deterministic compact slice from imported Fabrick
Claude Code session history. Distillation uses the latest successful Capture
output when available, Schema uses the latest successful Distillation output
when available, and Relevance uses the latest successful Schema output when
available. Each runner also has a fixture fallback so it remains runnable
independently. Experiments do **not** write to `refinery.db`, create proposals,
activate memory, or involve Coral.

## Storage layout (authority boundaries)

The local instance lives under `.refinery/` (gitignored):

- `.refinery/refinery.db` — **canonical** relational record (SQLite): `project`,
  `source`, `memory`. Lifecycle (`status`), `scope`, `type`, and provenance are
  first-class fields from the start.
- `.refinery/raw/<sha256>` — **raw source evidence**: immutable, content-
  addressed copies of every imported file. The object-store analog; the DB
  points back to it.

## Layout

```
src/
  cli.ts        # command entrypoint (up | import claude-code | inspect …)
  config.ts     # instance-home / db / raw-store path resolution
  db.ts         # node:sqlite open + schema + idempotent helpers
  discovery.ts  # cwd → encoded path → session/memory discovery
  hash.ts       # sha256 of source files (read-only)
  mastra/       # Mastra runtime adapter for specialist experiments
  mcp.ts        # MCP stdio server exposing Stage A read tools
  retrieval.ts  # active project memory retrieval + project context synthesis
  experiments/  # throwaway LLM experiment harnesses
  specialists/  # local specialist contracts + sequential harness scaffold
```
