# refinery

Refinery is a Coral-first memory-maintenance CLI and storage-agnostic refinement
core. Its default product path runs coordinated Coral specialists over Codex
memory files and existing memory candidates, then emits reviewable proposal
artifacts for the host app or coding agent to apply elsewhere.

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
# Create a local Refinery instance under ./.refinery.
refinery instance init --json

# Create a fresh local instance from a previous .refinery DB/raw store.
refinery instance init --from /path/to/old/.refinery --reset --json

# Validate an agent-facing memory-store adapter.
refinery adapter check --adapter ./my-memory-adapter.mjs --json

# Probe the built-in bounded Codex memory adapter.
refinery adapter check --adapter codex-memory --probe --json

# Probe adapter reads and validate returned record shapes.
refinery adapter check --adapter ./my-memory-adapter.mjs --probe --scope project --json

# Run the default live Coral-coordinated dry-run review over ~/.codex/memories.
refinery review --project . --source codex-memory --target codex-memory --json

# Ask a pointed memory-maintenance question.
refinery review --project . --source codex-memory --target codex-memory \
  --intent stale-audit \
  --request "Find Codex memories that may be stale after recent repo moves." --json

# Advanced local debugging: run the old sequential adapter-backed scaffold.
refinery review --runtime sequential --adapter ./my-memory-adapter.mjs --scope project --json

# Advanced local debugging: run live sequential specialist calls.
refinery review --runtime sequential --mode live --adapter ./my-memory-adapter.mjs --scope project --json

# Inspect an existing review trial without re-running review.
refinery trial inspect --run-dir ./.refinery/trials/<run-id> --json

# Deliver the final review bundle to an app-owned callback/sink.
refinery review --project . --source codex-memory --target codex-memory \
  --sink-url https://your-app.example/refinery/proposals \
  --sink-timeout-ms 10000 --json

# Validate a local module descriptor without loading module code.
refinery module check --descriptor ./refinery-module.json --json

# Run the same CLI path against an existing Coral server without starting one.
refinery review --project . --source codex-memory --target codex-memory \
  --coral-url http://localhost:5555 --coral-no-start --json

# Advanced attachment: reuse a caller-owned Coral session/thread.
refinery review --project . --source codex-memory --target codex-memory \
  --coral-url http://localhost:5555 --coral-no-start \
  --coral-namespace existing-namespace \
  --coral-session-id existing-session --coral-thread-id existing-thread --json

# From a local checkout before linking/installing the bin:
node src/cli.ts review --project . --source codex-memory --target codex-memory --json

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

## Agent-Callable CLI

The promoted integration surface is CLI-first. Agents and automations should be
able to call Refinery, receive stable JSON, inspect run artifacts,
and hand proposal bundles to their own approval/apply path.

The CLI currently exposes:

- `refinery instance init --home <dir> --from <dir> --reset --json`
- `refinery adapter check --adapter <path|reference-sqlite|codex-memory> --memory-home <dir> --probe --scope <scope> --json`
- `refinery review --project <dir> --source codex-memory --target codex-memory --memory-home <dir> --intent <intent> --request <text> --home <dir> --run-id <id> --sink-url <url> --sink-timeout-ms <ms> --json`
- `refinery trial inspect --run-dir <dir> --json`
- `refinery module check --descriptor <path> --json`

`review` is dry-run only. By default it starts or targets Coral, creates a
bounded session/thread, waits for the five Refinery specialists, seeds a review
intake, collects live LLM-backed specialist outputs through Coral extended
state, writes a run directory, and emits proposal-shaped JSON. It does not
approve proposals, mutate memory, or write to the backing store.

Advanced attachment flags let a caller provide an existing Coral URL,
namespace, session id, and thread id. Refinery only tears down the session and
server process it created itself; caller-owned Coral sessions/threads are left
running.

JSON output is the machine contract. Successful review payloads include
`ok: true`, `schemaVersion: "refinery.review.v1"`, `metadata`, `proposals`, and
`rejected`. When `--json` is present, CLI failures emit `ok: false` with
`error.code`, `error.message`, optional `error.phase`, and `runId`/`runDir` when
available. Non-JSON terminal usage still reports failures on stderr.

Review metadata records reproducibility inputs: mode, adapter, scope, intent,
request, creation time, sink URL, source limits, specialist order, runtime
adapter, Coral namespace/session/thread refs, and redacted model provider/base
URL/model name for live runs. API keys are never emitted.

Modes:

- `coral` (default): coordinated Coral specialist run.
- `sequential deterministic`: advanced local scaffold pass, no model calls.
- `sequential live`: advanced non-coordinated specialist calls:
  `Capture -> Distillation -> Schema -> Relevance -> Relationship Review`.

Use `--runtime sequential` to access the sequential modes for local debugging.
The default `review` command is the Coral-coordinated product path.

Sink/callback behavior is deliberately app-owned. `--sink-url` posts the final
review bundle after artifacts are written. The receiving app decides whether to
commit memory updates, queue human review, archive for auditability, or reject
the proposals. The sink result is written to `sink.json` inside the trial.
HTTP sink calls time out after 10000ms by default; override with
`--sink-timeout-ms`.

Every review run writes `manifest.json` as the module-facing artifact index.
The manifest records schema version, run id, mode, adapter, scope, status,
timestamps, runtime/model metadata when present, step order, and paths to
review, proposal, rejection, status, sink, Coral, transcript, and step
artifacts.

`refinery trial inspect --run-dir <dir> --json` reads an existing run directory
without invoking an adapter or model. It returns run status, counts, proposal
action distribution, proposal lifecycle distribution, step artifact presence,
sink summary, and failed-run error details when present. Inspecting a failed run
succeeds as an inspection command while reporting that run's own `ok: false`
and `status: "failed"`.

### Local Instance Home

The packaged CLI defaults to a caller-owned local instance at `$PWD/.refinery`.
Set `REFINERY_HOME` or pass `--home <dir>` to point at a different instance.
The instance layout is:

```text
.refinery/
  refinery.db       # optional reference SQLite state
  raw/              # immutable source evidence copied by reference ingestion
  trials/           # dry-run review outputs
```

`refinery instance init --from <old-home> --reset --json` archives any existing
destination home as `.refinery.archive-<timestamp>`, copies `refinery.db` and
`raw/` from the old home, and starts with an empty `trials/` directory. It does
not copy old `experiments/`, `runs/`, or prior `trials/` directories.

Run artifacts are written under `.refinery/trials/<run-id>/` by default:

```text
input.json
manifest.json
metadata.json
proposals.json
rejected.json
review.json
coral.json         # Coral session/thread/runtime evidence for coordinated runs
transcript.json    # transcript excerpts for coordinated runs
steps/
  capture/{input.json,output.raw.md,output.parsed.json}
  distillation/{input.json,output.raw.md,output.parsed.json}
  schema/{input.json,output.raw.md,output.parsed.json}
  relevance/{input.json,output.raw.md,output.parsed.json}
  relationship-review/{input.json,output.raw.md,output.parsed.json}
```

For live Coral runs, each step `input.json` also records the specialist agent,
prompt version, redacted model identity, provider metadata, and prompt used for
that specialist call. `output.raw.md` is the raw model response and
`output.parsed.json` is written only after schema validation succeeds. Failed
specialist calls write `steps/<step>/error.json` plus a failed run manifest.

Failed reviews that reach a run directory write `status.json` and a failed
`review.json` containing `status: "failed"`, the error payload, failed step
when known, and a raw-output path when a live specialist returned invalid JSON.
Coral failures also write `coral.json` with session/thread/runtime/model
evidence available up to the failure point. Step directories preserve
`input.json`, `output.raw.md`, and `error.json` when available so another agent
can inspect the failed run.

Proposals use two separate vocabularies:

- `action`: the recommended memory-maintenance operation.
- `lifecycle`: the review/workflow state of the recommendation.

The default CLI path uses Coral coordination to prove the installed-agent
surface. The sequential scaffold remains available for local debugging of
adapter, JSON, artifact, and proposal contracts without starting Coral.

### Adapter Contract

Adapters are caller-owned bridges to external memory stores. They must expose:

- `name: string`
- `listSourceEvidence({ scope, limit? })`
- `searchSourceEvidence({ scope, query, limit? })`
- `getSourceEvidence({ scope, id })`
- `listActiveMemories({ scope, limit? })`
- `searchActiveMemories({ scope, query, limit? })`
- `getActiveMemory({ scope, id })`

Optional mutation capability:

- `applyProposal({ proposal, approvedBy, dryRun? })`

`adapter check` validates the adapter shape by default. Add `--probe` to perform
small `listSourceEvidence` and `listActiveMemories` reads and validate returned
record shapes. Probe mode expects opaque string IDs, source text, and active
memory `id`, `type`, `scope`, `status`, and `body` fields.

The built-in `codex-memory` adapter is a bounded filesystem adapter for
`~/.codex/memories`. Pass `--memory-home <dir>` to target another directory
named `memories`; Refinery intentionally rejects broader parent directories and
does not scan all of `~/.codex`. The adapter indexes `MEMORY.md`,
`memory_summary.md`, `rollout_summaries/*.md`, and
`extensions/ad_hoc/**/*.md` as source evidence and active-memory candidates with
stable opaque IDs, origin kind, relative file path, heading/line provenance
when available, and rollout thread/update metadata when present.

Agent-facing records should use opaque string IDs. Numeric database IDs are an
adapter implementation detail and should not leak into core contracts.

The action taxonomy for maintenance proposals is:

```text
create, update, supersede, merge, archive, retag, quarantine,
promote, demote, ttl_update, contradiction_review
```

The lifecycle taxonomy for proposal handling is:

```text
proposed, needs_review, accepted, rejected, deferred,
applied_externally, superseded, archived_for_audit
```

Newly emitted proposals default to `lifecycle: "proposed"`. `accepted` means a
reviewer or workflow accepted the recommendation. `applied_externally` means a
host app or customer-owned system performed the durable mutation. Refinery core
does not perform that mutation.

Review intents are strict enum values:

```text
general-review, stale-audit, forget-candidates,
update-candidates, conflict-audit, scope-audit
```

Use `--intent <intent>` with optional `--request <text>` to make a review more
pointed, such as stale-memory review or forget-candidate discovery. The intent
is included in CLI validation, input packets, Coral seed messages, specialist
payloads, metadata, manifests, and final JSON. Proposal records may include
intent-specific fields: `stalenessReason`, `forgetReason`, `updateReason`,
`conflictReason`, `scopeReason`, `replacementBody`, and `ambiguities`.

### Module Descriptor Contract

Module descriptors are minimal, machine-checkable records for future runtime,
adapter, sink, and workbench packages. `refinery module check` validates the
descriptor shape without importing or executing module code.

```json
{
  "schemaVersion": "refinery.module.v1",
  "kind": "runtime",
  "name": "refinery-example-runtime",
  "version": "0.0.1",
  "entrypoint": "./dist/index.js",
  "capabilities": ["review.live"]
}
```

Supported descriptor kinds are `runtime`, `adapter`, `sink`, and `workbench`.
This is a compatibility skeleton, not package discovery or Coral/Pi loading.

### Module Invocation Contract

Future Coral, Pi, and workbench modules should treat the CLI as a subprocess
contract:

- pass `--json` and parse stdout as JSON
- use `--output-dir` and `--run-id` for deterministic artifact locations
- inspect `schemaVersion` before consuming outputs
- read `manifest.json` instead of inferring artifact paths from prose
- use `trial inspect` for post-run summaries
- rely on structured `ok`/`error.code` envelopes for failure handling
- rely on redacted metadata only; secrets such as API keys are never emitted
- keep durable memory writes in the host app or adapter layer

## Specialist Pipeline

The first refinement scaffold is:

```text
Capture -> Distillation -> Schema -> Relevance -> Relationship Review
```

Each specialist is defined as a prompt, input contract, output contract, and
tool boundary. The definitions are framework-neutral. The default CLI path
binds them as separate Coral agents, while Mastra/sequential runners remain
debugging and experimentation surfaces.

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

## Harness Surfaces

Refinery's core specialist contracts do not depend on Pi, OpenCode, Cursor, or
Coral. The default CLI product path does use Coral coordination.

- Pi is a candidate runtime for optional interactive workbench sessions,
  specialist follow-up, and custom harnesses.
- OpenCode is a useful reference for open coding-agent server integration.
- Cursor is a useful reference for managed cloud coding-agent orchestration.

The default product surface remains the agent-callable CLI. Harness-specific
work should stay optional and outside `refinery-core` unless a stable adapter or
runtime boundary has been proven.

## Layout

```text
src/
  cli.ts                # agent-callable CLI entrypoint
  core/
    adapter.ts          # storage-adapter and proposal/action contracts
    review.ts           # dry-run review scaffold over an adapter
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
