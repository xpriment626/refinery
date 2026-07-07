---
name: refinery
description: Use whenever Codex is asked to inspect, audit, summarize, or propose edits from Codex memories, sessions, skills, files, or mixed source sets using Refinery, including memory proposals, session-recurrence audits, memory-gap audits, skill-promotion audits, stale/forget/conflict/scope audits, memory slices, or fresh-session tests. Supports repeatable source/target flags while keeping debate-critique as the default live workflow.
---

# Refinery

## Boundary

Invoke this skill as the single Refinery skill for source review requests. Use
Refinery to inspect Codex memories, sessions, skills, files, or globs and
propose dry-run memory edits or skill candidates. Do not apply proposals, mutate
Codex memory, write ad-hoc memory notes, edit files under
`${CODEX_HOME:-$HOME/.codex}/memories`, or write generated skills into
`${CODEX_HOME:-$HOME/.codex}/skills`.

Default to a live `refinery review` run. Use fixture mode only when the user
explicitly asks for mock, fixture, deterministic, no-Coral, or rehearsal output.
Do not add a topology flag for normal review; debate-critique is the default
Refinery memory-inspection workflow.

## Setup Check

Verify the command and local setup:

```bash
command -v refinery
refinery init --json
refinery skill install --json
refinery doctor --json
```

For packaged installs, the canonical Coral key setup is:

```bash
refinery set auth coral
```

Use this when `refinery doctor --json` reports `modelAuth.present: false` or
when a live review fails with missing model auth. Do not ask the user to run
Delve auth commands for Refinery, and do not print API keys in chat. Repo-local
`.env` files with `CORAL_API_KEY` remain supported for development sessions.

If `refinery` is not installed, install the package first:

```bash
npm i -g @itsshadowai/refinery
```

## Slice Controls

Map the user's requested source slice onto the current CLI controls:

- `--source <spec>` is repeatable. Use `codex:memories`,
  `codex:sessions?project=/abs/project`, `codex:sessions?scope=global&days=30`,
  `codex:skills`, `file:/abs/path`, or `glob:/abs/**/*.md`.
- `--target <surface>` is repeatable. Use `codex:memories` for memory
  proposals and `codex:skills` for skill candidates.
- `--memory-home <dir>` selects the Codex memory corpus. It must point to a
  directory named `memories`.
- `--project <dir>` selects the project context and the global run bucket under
  `~/.refinery/runs/by-project/<project-key>/`.
- `--intent <intent>` selects audit behavior. Use one of:
  `general-review`, `stale-audit`, `forget-candidates`, `update-candidates`,
  `conflict-audit`, `scope-audit`, `session-recurrence`, `memory-gap-audit`,
  `skill-promotion-audit`.
- `--request "<text>"` carries the user's slice description or review question.
  Use it to focus on a repo, topic, previous failure, memory family, or desired
  proposal type.
- `--source-limit <n>` selects how many source documents enter the run. Use `1`
  for a tight smoke, `3` as the normal default, and up to `10` for broader
  review.
- `--source-char-limit <n>` bounds each source chunk. Use `2500` for quick
  smokes, `6000` as the normal default, and higher values only when the slice
  needs more context.
- `--run-id <id>` should be path-safe and descriptive when comparing separate
  sessions or slices.

Do not invent unavailable selectors. If the user asks for a fine-grained slice
that the CLI cannot directly filter, encode the focus in `--request` and keep
`--source-limit`/`--source-char-limit` explicit.

Before a risky or broad live run, inspect sources without invoking Coral:

```bash
refinery sources inspect \
  --source "<source spec>" \
  --project "$PWD" \
  --json
```

## Live Review Command

Use this shape for normal memory proposal runs:

```bash
refinery review \
  --source codex:memories \
  --target codex:memories \
  --project "$PWD" \
  --memory-home "${CODEX_HOME:-$HOME/.codex}/memories" \
  --intent update-candidates \
  --request "<user slice and review request>" \
  --source-limit 3 \
  --source-char-limit 6000 \
  --run-id "<path-safe-run-id>" \
  --json
```

Use this shape for recurring-session memory work:

```bash
refinery review \
  --source "codex:sessions?project=$PWD" \
  --target codex:memories \
  --project "$PWD" \
  --intent session-recurrence \
  --source-limit 3 \
  --source-char-limit 6000 \
  --run-id "<path-safe-run-id>" \
  --json
```

Use this shape for memory-vs-session gap audits:

```bash
refinery review \
  --source "codex:sessions?scope=global&days=30" \
  --source codex:memories \
  --target codex:memories \
  --project "$PWD" \
  --intent memory-gap-audit \
  --source-limit 3 \
  --source-char-limit 6000 \
  --run-id "<path-safe-run-id>" \
  --json
```

Use this shape for skill promotion audits:

```bash
refinery review \
  --source codex:memories \
  --source codex:skills \
  --target codex:skills \
  --project "$PWD" \
  --intent skill-promotion-audit \
  --source-limit 3 \
  --source-char-limit 6000 \
  --run-id "<path-safe-run-id>" \
  --json
```

Use `--home ./.refinery` only when the user explicitly wants project-local
Refinery state. The default writes run artifacts under `~/.refinery`.

## Inspecting Runs

If the review succeeds, use stdout JSON first. If stdout is incomplete,
validation fails after a run directory was created, or you need a stable summary,
inspect the run:

```bash
refinery trial inspect --run-dir "<runDir>" --json
```

For failed live runs, inspect `status.json`, `review.json`, `coral.json`,
`server.log`, and `steps/*/messages/*/` inside `runDir` before deciding whether
the failure was startup, model output, merge, or timeout related.

## Reporting

Summarize the Refinery result in plain language:

- live or fixture mode, run id, and run directory
- source specs, target surfaces, and slice controls used
- counts for proposals, rejected candidates, claims, challenges, and unresolved
  challenges when present
- each proposed edit: action, memory type, scope, target memory id(s), body or
  replacement body, confidence, rationale, and evidence/source refs
- each skill candidate: name, trigger, evidence refs, existing skill refs,
  SKILL.md outline/draft, rationale, and confidence
- rejected candidates and unresolved questions
- any validation/runtime caveats

Phrase proposals as candidates surfaced by Refinery, not accepted memory edits.

## Fixture Mode

Only on explicit mock/fixture requests:

```bash
refinery dev fixture memory-proposal --json
```
