# refinery

Refinery is a Codex-first memory review CLI. It reads bounded Codex memory
files, runs a dry-run Coral-coordinated specialist review, and emits proposal
artifacts that a coding agent or host app can inspect before applying changes
elsewhere.

Refinery does not approve proposals, apply edits, or own durable memory truth.
For the first useful version, Codex memories are the only built-in memory
surface.

## Requirements

- Node.js >= 22.
- Codex memories enabled and available under `~/.codex/memories`, or another
  explicitly provided directory named `memories`.
- Model credentials for live review, usually `OPENROUTER_API_KEY` or
  `MODEL_API_KEY`.

## Install

```bash
npm install -g @itsshadowai/refinery
refinery init --json
refinery doctor --json
```

`refinery init` creates global Refinery state under `~/.refinery` and installs
the bundled `$refinery` Codex skill into `${CODEX_HOME:-~/.codex}/skills/refinery`.
It preserves an existing installed skill unless `--force` is passed.

## Commands

```bash
# Verify the local Codex memory source is readable.
refinery doctor --json

# Verify the installed CLI version.
refinery version --json

# Verify a non-default Codex memory directory.
refinery doctor --memory-home /path/to/memories --json

# Run a dry-run stale-memory audit over Codex memories.
refinery review \
  --project . \
  --intent stale-audit \
  --request "Find Codex memories that may be stale after recent repo moves." \
  --json

# Seed a live Coral Console debate/critique session without writing run artifacts.
refinery console run \
  --project . \
  --intent stale-audit \
  --json

# Inspect an existing run without invoking Coral or a model.
refinery trial inspect --run-dir ~/.refinery/runs/by-project/<project-key>/<run-id> --json
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

`refinery review` is dry-run only. It starts or targets Coral, creates bounded
proposal and critique threads, runs the five Refinery specialists, writes a run
directory, and returns proposed memory-maintenance actions.

The default workflow is debate/critique. Claim Scout extracts candidate memory
claims, Memory Cartographer maps nearby active memories, Evidence Auditor checks
support and provenance, Proposal Editor turns surviving claims into typed
proposal packets, and Decision Synthesizer resolves challenges into final
proposals, rejected candidates, and unresolved questions. Each specialist
message is persisted under that step's `messages/` artifact directory.

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

Runtime state is globally organized by default:

```text
~/.refinery/
  config/
  credentials/
  runs/
    by-project/
      <project-key>/
        <run-id>/
          input.json
          manifest.json
          metadata.json
          proposals.json
          rejected.json
          claims.json
          challenge-ledger.json
          deliberation.json
          review.json
          coral.json
          transcript.json
          steps/
            claim-scout/{input.json,output.raw.md,output.parsed.json}
            memory-cartographer/{input.json,output.raw.md,output.parsed.json}
            evidence-auditor/{input.json,output.raw.md,output.parsed.json}
            proposal-editor/{input.json,output.raw.md,output.parsed.json}
            decision-synthesizer/{input.json,output.raw.md,output.parsed.json}
```

Failed reviews that reach a run directory write `status.json`, failed
`review.json`, and any available step error artifacts. Use `trial inspect` for a
stable summary instead of scraping file paths.

Use `--home ./.refinery` only when you intentionally want project-local
Refinery state. The default keeps run artifacts and future credentials/config
global while grouping runs by project key.

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

## Console Mode

`refinery console run` is a local development command for Coral Console
inspection. It reads the bounded Codex memory source, starts Coral when
`--coral-url` is not provided, creates a session and thread set, seeds the
default debate/critique workflow, prints the console URL and session
identifiers, and does not write run artifacts.

The default console topology is `debate-critique`. When Refinery starts the
Coral server, the command stays in the foreground so the Console remains
available until interrupted.

## Development

```bash
npm test
npm run build
npm link
refinery version --json
```

The test suite covers the Codex memory adapter, Codex-first CLI contract, Coral
worker/conductor helpers, artifact inspection, model client, intents, MCP
specialist prompt tools, and specialist contracts.

### Codex Skill

Use one Codex skill for Refinery memory work:

```text
$refinery
```

Example prompt:

```text
Use $refinery to inspect the current project Codex memories with intent update-candidates, source-limit 1, source-char-limit 2500, and summarize the proposed edits.
```

The companion skill should be installed once in the Codex global skill root:

```text
~/.codex/skills/refinery/SKILL.md
```

Do not keep repo-local alternate copies of the Refinery skill; they create
duplicate suggestions and teach agents old invocation names. `$refinery`
defaults to live `refinery review`. For deterministic rehearsal only:

```bash
refinery dev fixture memory-proposal --json
```
