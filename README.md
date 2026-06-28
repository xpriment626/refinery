# refinery

Refinery is a Codex-first memory review CLI. It reads bounded Codex memory
files, runs a dry-run Coral-coordinated specialist review, and emits proposal
artifacts that a coding agent or host app can inspect before applying changes
elsewhere.

Refinery does not approve proposals, apply edits, or own durable memory truth.
For the first useful version, Codex memories are the only built-in memory
surface.

## Requirements

- Node.js >= 24.
- Codex memories enabled and available under `~/.codex/memories`, or another
  explicitly provided directory named `memories`.
- Model credentials for live review, usually `OPENROUTER_API_KEY` or
  `MODEL_API_KEY`.

## Commands

```bash
# Verify the local Codex memory source is readable.
refinery doctor --json

# Verify a non-default Codex memory directory.
refinery doctor --memory-home /path/to/memories --json

# Run a dry-run stale-memory audit over Codex memories.
refinery review \
  --project . \
  --intent stale-audit \
  --request "Find Codex memories that may be stale after recent repo moves." \
  --json

# Inspect an existing run without invoking Coral or a model.
refinery trial inspect --run-dir ./.refinery/trials/<run-id> --json
```

The CLI always emits structured JSON for these commands. Failures use
`ok: false` with `error.code`, `error.message`, and `error.phase` when known.
Secrets are not emitted.

## Memory Source

The built-in Codex memory reader is intentionally bounded. It accepts only a
directory named `memories`, normally `~/.codex/memories`, and does not crawl all
of `~/.codex`.

Indexed files:

- `MEMORY.md`
- `memory_summary.md`
- `rollout_summaries/*.md`
- `extensions/ad_hoc/**/*.md`

Records use opaque IDs such as `codex-source:<hash>` and
`codex-memory:<hash>`. Proposal targets should use those opaque IDs rather than
database IDs or file offsets.

## Review

`refinery review` is dry-run only. It starts or targets Coral, creates a bounded
session/thread, runs the five Refinery specialists, writes a trial directory,
and returns proposed memory-maintenance actions.

Supported review intents:

```text
general-review
stale-audit
forget-candidates
update-candidates
conflict-audit
scope-audit
```

Proposal actions:

```text
create, update, supersede, merge, archive, retag, quarantine,
promote, demote, ttl_update, contradiction_review
```

Proposal lifecycle states:

```text
proposed, needs_review, accepted, rejected, deferred,
applied_externally, superseded, archived_for_audit
```

New proposals default to `lifecycle: "proposed"`. Applying or rejecting them is
owned by the caller.

## Trial Artifacts

Local runtime state is limited to review trials by default:

```text
.refinery/
  trials/
    <run-id>/
      input.json
      manifest.json
      metadata.json
      proposals.json
      rejected.json
      review.json
      coral.json
      transcript.json
      steps/
        capture/{input.json,output.raw.md,output.parsed.json}
        distillation/{input.json,output.raw.md,output.parsed.json}
        schema/{input.json,output.raw.md,output.parsed.json}
        relevance/{input.json,output.raw.md,output.parsed.json}
        relationship-review/{input.json,output.raw.md,output.parsed.json}
```

Failed reviews that reach a run directory write `status.json`, failed
`review.json`, and any available step error artifacts. Use `trial inspect` for a
stable summary instead of scraping file paths.

## Coral Runtime

The default runtime is Coral. Refinery owns local executable agent manifests
under `coral/agents/*` and a repo-local config at `coral/refinery-config.toml`.
The CLI can also attach to an existing Coral server:

```bash
refinery review \
  --coral-url http://localhost:5555 \
  --coral-no-start \
  --json
```

Caller-owned Coral sessions and threads are not torn down by Refinery.

## Development

```bash
PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH" npm test
```

The test suite covers the Codex memory adapter, Codex-first CLI contract, Coral
worker/conductor helpers, artifact inspection, model client, intents, MCP
specialist prompt tools, and specialist contracts.
