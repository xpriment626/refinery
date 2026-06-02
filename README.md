# refinery

Local Refinery memory service — **ingestion-and-inspection slice** (Stage A).

This is the first reroll-driven vertical slice. It does exactly one thing well:
import the real Claude Code history for a working directory into a local
canonical store and let you inspect it. Refinement, proposals, MCP retrieval,
the dashboard, the watcher, auth, vector search, and cloud deployment are
deliberately **out of scope** here — clean seams are left for them.

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
```

`npm run refinery -- <args>` is also wired as a convenience.

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
```
