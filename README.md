# refinery

Refinery is a Codex-first source review CLI. It builds a bounded, run-scoped
`ReviewPacket` from Codex memories, Codex sessions, Codex skills, files, globs,
or mixed source sets, then runs a dry-run Coral-coordinated specialist review.
The output is a set of proposal artifacts for a coding agent or host app to
inspect before applying changes elsewhere.

Refinery does not approve proposals, apply edits, or own durable memory truth.
Built-in target surfaces are `codex:memories` and `codex:skills`. Refinery can
recommend memory proposals and skill candidates, but it does not write either
surface.

## Requirements

- Node.js 22 or newer.
- Codex memories enabled under `~/.codex/memories`, or an explicitly provided
  directory named `memories`.
- A Coral API key for live specialist model calls.

## Install

```bash
npm i -g @itsshadowai/refinery
refinery init --json
refinery set auth coral
refinery doctor --json
```

`refinery init` creates global Refinery state under `~/.refinery` and installs
the bundled `$refinery` Codex skill into
`${CODEX_HOME:-~/.codex}/skills/refinery`. It preserves an existing installed
skill unless `--force` is passed.

To install or refresh only the Codex skill:

```bash
refinery skill install --json
refinery skill install --force --json
```

`refinery set auth coral` stores the Coral API key under `~/.refinery` with file
mode `0600` and does not print the secret. You can also provide
`CORAL_API_KEY` in the environment for ephemeral sessions.

## Commands

```bash
# Verify the CLI, memory source, installed skill, and Coral auth status.
refinery doctor --json

# Verify the installed CLI version.
refinery version --json

# Install or refresh the companion Codex skill.
refinery skill install --json

# Inspect source loading without invoking Coral.
refinery sources inspect \
  --source "codex:sessions?project=$PWD" \
  --source codex:memories \
  --json

# Run a dry-run memory review over Codex memories.
refinery review \
  --source codex:memories \
  --target codex:memories \
  --project "$PWD" \
  --intent stale-audit \
  --request "Find memories that may be stale after recent project changes." \
  --json

# Find recurring session topics worth memory.
refinery review \
  --source "codex:sessions?project=$PWD" \
  --target codex:memories \
  --intent session-recurrence \
  --json

# Audit memories and workflows that should become custom skills.
refinery review \
  --source codex:memories \
  --source codex:skills \
  --target codex:skills \
  --intent skill-promotion-audit \
  --json

# Compare recent global sessions against current memories.
refinery review \
  --source "codex:sessions?scope=global&days=30" \
  --source codex:memories \
  --target codex:memories \
  --intent memory-gap-audit \
  --json

# Inspect an existing run without invoking Coral.
refinery trial inspect --run-dir ~/.refinery/runs/by-project/<project-key>/<run-id> --json
```

The CLI emits structured JSON. Failures use `ok: false` with `error.code`,
`error.message`, and `error.phase` when known. Secrets are not emitted.

## Sources And Targets

`refinery review` accepts repeatable `--source` and `--target` flags. If omitted,
the defaults are `--source codex:memories --target codex:memories`.

Supported source specs:

```text
codex:memories
codex:sessions?project=/path/to/project
codex:sessions?scope=global&days=30
codex:skills
file:/path/to/file.md
glob:/path/to/**/*.md
```

Supported targets:

```text
codex:memories
codex:skills
```

The Codex memory reader is bounded. It accepts only a directory named
`memories`, normally `~/.codex/memories`, and does not crawl all of `~/.codex`.

Indexed memory files:

- `MEMORY.md`
- `memory_summary.md`
- `rollout_summaries/*.md`
- `extensions/ad_hoc/**/*.md`

The Codex session reader scans `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
It keeps session id, cwd, timestamps, user prompts, assistant finals/summaries,
and compact tool/action summaries. It deliberately ignores base instructions and
does not dump full transcripts into prompts.

The Codex skill reader scans `~/.codex/skills/**/SKILL.md` and
`~/.agents/skills/**/SKILL.md`. It does not scan plugin-cache skills by default.

Each review writes the canonical packet to `input.json`. The prompt-facing
`source_chunks` and `active_memory_hints` fields are derived from that packet
and are not the canonical input contract.

## Review

`refinery review` is dry-run only. It starts or targets Coral, creates bounded
proposal and critique threads, runs the five Refinery specialists, writes a run
directory, and returns proposed memory-maintenance actions or skill candidates.

The default workflow is debate/critique:

- Claim Scout extracts candidate memory claims.
- Memory Cartographer maps nearby active memories.
- Evidence Auditor checks support and provenance.
- Proposal Editor turns surviving claims into typed proposal packets.
- Decision Synthesizer resolves challenges into final proposals, rejected
  candidates, and unresolved questions.

Supported review intents:

```text
general-review
stale-audit
forget-candidates
update-candidates
conflict-audit
scope-audit
session-recurrence
memory-gap-audit
skill-promotion-audit
```

Proposal actions:

```text
create, update, supersede, merge, archive, retag, quarantine,
promote, demote, ttl_update, contradiction_review
```

New proposals default to `lifecycle: "proposed"`. Applying or rejecting them is
owned by the caller.

When a run targets `codex:skills`, `review.json` and `skillCandidates.json` may
include:

```text
skillCandidates.candidates[].name
skillCandidates.candidates[].trigger
skillCandidates.candidates[].evidenceRefs
skillCandidates.candidates[].existingSkillRefs
skillCandidates.candidates[].skillMdOutline
skillCandidates.candidates[].skillMdDraft
skillCandidates.candidates[].rationale
skillCandidates.candidates[].confidence
skillCandidates.rejected[]
skillCandidates.unresolved[]
```

## Run Artifacts

Runtime state is global by default:

```text
~/.refinery/
  config/
  credentials/
    coral-api-key
  runs/
    by-project/
      <project-key>/
        <run-id>/
          input.json
          source-counts.json
          manifest.json
          metadata.json
          proposals.json
          rejected.json
          skillCandidates.json
          claims.json
          challenge-ledger.json
          deliberation.json
          review.json
          coral.json
          transcript.json
          steps/
```

Failed reviews that reach a run directory write `status.json`, failed
`review.json`, and any available step error artifacts. Use `trial inspect` for a
stable summary instead of scraping file paths.

Use `--home ./.refinery` only when you intentionally want project-local
Refinery state. The default keeps run artifacts and credentials/config global
while grouping runs by project key.

## Coral Runtime

The default runtime is Coral. Refinery ships executable Coral agent manifests
under `coral/agents/*` and a packaged Coral config under
`coral/refinery-config.toml`. The default model route is Coral's
OpenAI-compatible endpoint with `gpt-5.4-nano`.

To attach to an existing Coral server:

```bash
refinery review \
  --coral-url http://localhost:5555 \
  --coral-no-start \
  --json
```

Caller-owned Coral sessions and threads are not torn down by Refinery.

## Codex Skill

Use one Codex skill for Refinery source review work:

```text
$refinery
```

Example prompt:

```text
Use $refinery to inspect current project Codex sessions plus memories with intent memory-gap-audit, source-limit 2, source-char-limit 6000, and summarize the proposed edits.
```

The companion skill should be installed once in the Codex global skill root:

```text
~/.codex/skills/refinery/SKILL.md
```

Use `refinery skill install --force --json` to refresh the installed skill from
the package. `$refinery` defaults to live `refinery review` and uses fixture mode
only when the user explicitly asks for mock, fixture, deterministic, no-Coral,
or rehearsal output.
