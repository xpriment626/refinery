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
- Java 24 or newer for the pinned local Coral Server runtime.

## Install

```bash
npm i -g @itsshadowai/refinery
refinery setup inspect --project "$PWD" --json
refinery skill install --json
refinery setup start --project "$PWD" --json
```

`setup start` returns a short-lived loopback capability URL. Codex should open
it in the in-app browser; without browser automation, open the URL manually.
The human enters the Coral API key directly in that local page, confirms the
private local credential file, and chooses whether to provision the pinned
Coral runtime and request the graph UI after syncs. The API key does not pass
through chat, command arguments, the URL, logs, or browser storage.

After the page completes, run:

```bash
refinery setup status --project "$PWD" --json
```

The result has stable issue codes, repair actions, and granular
`readyFor.agent`, `readyFor.graph`, `readyFor.liveReview`, and `readyFor.ui`
fields. Setup never opens a browser itself. It returns a URL and leaves browser
control to Codex or the human.

`refinery init` remains available to create global Refinery state under
`~/.refinery` and install the bundled skill into
`${CODEX_HOME:-~/.codex}/skills/refinery`.

To install or refresh only the Codex skill:

```bash
refinery skill install --json
refinery skill install --force --json
```

Package-managed skill copies carry a content manifest. An unchanged older copy
is refreshed automatically. A customized copy is preserved and reported as a
conflict with an explicit `--force` repair action.

The local credential store uses mode `0700`/`0600` and owner validation on
POSIX systems. On Windows it uses the access controls inherited from the
user-profile directory and reports them as platform-managed; it does not claim
to be an OS keychain. On every platform it rejects symlinks and non-regular
files, rotates via atomic replacement, and supports revocation with
`refinery unset auth coral --json`. You can also provide `CORAL_API_KEY` in the
environment for development sessions.

## Version Checks

The CLI performs a best-effort, cached check of the public npm registry and
prints a notice on stderr when a newer Refinery version is available. It never
installs an update automatically. If the notice appears, ask the human user to
confirm before running the suggested `npm i -g @itsshadowai/refinery@<version>`
command.

Use `--no-update-check` or set `REFINERY_NO_UPDATE_CHECK=1` to suppress the
notice. Update checks are also disabled when `CI=true`. Network failures are
ignored and do not affect the requested command or JSON on stdout.

## Commands

```bash
# Verify the CLI, memory source, installed skill, and Coral auth status.
refinery doctor --json

# Inspect or start the agent-first setup contract.
refinery setup inspect --project "$PWD" --json
refinery setup start --project "$PWD" --json
refinery setup status --project "$PWD" --json

# Verify the installed CLI version.
refinery version --json

# Install or refresh the companion Codex skill.
refinery skill install --json

# Inspect source loading without invoking Coral.
refinery sources inspect \
  --source "codex:sessions?project=$PWD" \
  --source codex:memories \
  --json

# Build the project-local derived memory graph without invoking Coral.
refinery graph sync \
  --source codex:memories \
  --source "codex:sessions?project=$PWD" \
  --project "$PWD" \
  --json

# Inspect graph health and a bounded retrieval plan.
refinery graph status --project "$PWD" --json
refinery graph plan \
  --project "$PWD" \
  --request "Find memory affected by the recent CLI release changes." \
  --max-nodes 12 \
  --max-edges 24 \
  --max-hops 2 \
  --json

# Start or inspect the project-local observability gateway.
refinery gateway start --project "$PWD" --json
refinery gateway status --project "$PWD" --json

# Get a capability URL for Codex's in-app browser without opening it.
refinery ui url --project "$PWD" --json

# Browser opening after a successful graph sync is explicit opt-in.
refinery ui config --browser-open on --project "$PWD" --json

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

The CLI emits structured JSON. Successful commands exit `0`. Argument, source,
graph, runtime, and validation failures exit nonzero and use `ok: false` with
`error.code`, `error.message`, `error.phase`, and actionable `error.details`
when available. `graph status` exits `0` with `exists: false` when no index has
been built. Secrets are not emitted.

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

Selected files are read in a separate minimum-authority Node.js process. Its
permission allowlist contains only the selected read roots; filesystem writes,
child processes, workers, and native add-ons are denied. Refinery validates and
bounds the typed result before indexing it. This isolates trusted built-in
readers from the writable graph process; it is not a sandbox for executing
untrusted source code.

Each review writes the canonical packet to `input.json`. The prompt-facing
`source_chunks` and `active_memory_hints` fields are derived from that packet
and are not the canonical input contract.

## Memory Responsibility Graph

`refinery graph sync` builds a derived graph from the selected source specs.
Codex files remain canonical; deleting the graph and running `graph sync`
reconstructs it. The default location is:

```text
~/.refinery/graphs/by-project/<project-key>/memory-graph.db
```

The graph is a private embedded libSQL database. Refinery alone mutates it,
using versioned migrations, transactions, integrity checks, and restrictive
filesystem permissions. A legacy `memory-graph.json` is imported once when
present. Codex source files remain read-only and canonical, so deleting the
derived database and running `graph sync` reconstructs it.

Graph schema `refinery.memory-graph.v1` separates stable node identity from
content revision identity. A revision is keyed by the node, normalized content
hash, and indexer version `refinery.memory-graph-indexer.v1`. Derived edges name
their source revision and carry confidence plus derivation/evidence provenance.
Syncing unchanged sources creates no revisions; changed or deleted sources
replace their revision-owned edges and cannot remain retrievable.

Supported node kinds are `memory`, `source_document`, `session`, `skill`,
`project`, and `evidence`. The edge vocabulary is:

```text
DERIVED_FROM, OBSERVED_IN_SESSION, APPLIES_TO_PROJECT, SUPPORTS,
CONTRADICTS, SUPERSEDES, DUPLICATES, SAME_TOPIC_AS, REQUIRES_SKILL
```

The Codex adapter emits only relationships supported by exact provenance,
project metadata, thread identifiers, line references, or explicit skill
references. Other edge kinds are available to future source adapters but are
not inferred from semantic similarity alone. Project plans admit current-project
and global memory records, exclude memories owned by other projects, and use
line-level evidence instead of placing mixed-project corpus documents into model
context.

Graph inspection commands do not invoke Coral:

```bash
refinery graph status --project "$PWD" --json
refinery graph inspect <node-id> --project "$PWD" --json
refinery graph neighbors <node-id> --depth 1 --project "$PWD" --json
refinery graph plan --request "..." --project "$PWD" --json
```

`graph plan` emits `refinery.responsibility-plan.v1`. It records deterministic
seeds, selected nodes/revisions, traversed edges, responsibility units, awake
seed units, sleeping one-hop units, exclusions, warnings, and exhausted
budgets. Traversal controls include `--max-nodes`, `--max-edges`, `--max-hops`,
`--max-chars`, `--max-tokens`, repeatable `--edge-kind`, `--min-confidence`,
`--max-age-days`, and repeatable explicit `--seed` identifiers.

`refinery review` and `refinery console run` sync and plan graph context by
default, then pass the bounded responsibility context to the existing five
specialists. Use `--no-graph` only for explicit legacy compatibility. Graph
errors stop the review; Refinery does not silently broaden retrieval. In
`0.3.0`, `--topology sparse-blackboard` creates one Coral topic thread per
awake responsibility unit and uses deterministic mention-wakes for downstream
specialists. The agent roster remains static; native dynamic insertion is a
future Coral capability seam.

## Local Observability Gateway

Refinery includes a supervised, project-scoped local gateway and a bundled
Svelte/Sigma graph explorer. The UI visualizes graph health, bounded retrieval
plans, revisions and provenance, sync activity, and responsibility territories.
It is observability-only: it cannot edit source files, approve proposals, or
run agent coordination.

```bash
refinery gateway start --project "$PWD" --json
refinery gateway status --project "$PWD" --json
refinery ui url --project "$PWD" --json
refinery gateway stop --project "$PWD" --json
```

`ui url` starts the gateway if necessary and returns a local capability URL.
An agent can open that URL in Codex's in-app browser; a human can paste it into
another browser. Treat the URL as a local secret while it is live. The
capability is carried in the URL fragment, removed from the visible URL after
the UI stores it for the tab session, and never written to normal gateway
status output.

The gateway binds only to `127.0.0.1`, validates `Host` and `Origin`, requires
the ephemeral bearer capability for API/event access, uses restrictive browser
headers, and returns bounded redacted data rather than arbitrary filesystem
paths. Lifecycle state is crash-safe and private; stale state is recovered
without signalling an unverified process.

One gateway process runs per Refinery home and serves one project at a time.
Starting it for another project fails with an actionable conflict instead of
silently retargeting the live process; stop the current gateway first.

Automatic browser opening is off by default. Inspect or change the
Refinery-home setting explicitly:

```bash
refinery ui config --project "$PWD" --json
refinery ui config --browser-open on --project "$PWD" --json
refinery ui config --browser-open off --project "$PWD" --json
```

When enabled, a successful graph sync may request the system browser. Failure
to open a browser never makes the sync fail, and `ui url --json` remains the
agent-friendly fallback.

## Setup Gateway Security Boundary

The setup gateway is separate from the persistent observability gateway. It is
the only browser surface that accepts a credential, and it exists only for the
bounded onboarding window.

- It binds to `127.0.0.1` on an OS-selected port and expires within 15 minutes.
- A 256-bit URL-fragment capability is exchanged once for a different session
  token held only in page memory. Neither token appears in status output.
- Every request validates `Host`; state-changing requests also validate the
  exact `Origin`, content type, method, and a 16 KiB body limit.
- The page uses a deny-by-default CSP, no third-party assets, no CORS, no
  browser persistence, and no request-body logging.
- Coral authorization uses authenticated registry and model-catalogue `GET`
  requests. It does not perform a generation or spend inference tokens.
- Completion or expiry shuts down the setup listener. Stale state is
  quarantined without signalling an unverified process.

The main residual local risk is a malicious process already running as the
same OS user, which can generally read that user's files and inspect local
processes. Refinery narrows exposure with private user-profile state, strict
POSIX modes where supported, one-time capabilities, loopback binding, short
lifetimes, origin checks, and by never granting the observability gateway
mutation authority.

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

For large corpora, the sparse topology is explicit and hypothesis-led:

```bash
refinery review \
  --source "codex:sessions?root=/path/to/Lab" \
  --source "codex:memories?root=/path/to/Lab" \
  --target codex:memories \
  --topology sparse-blackboard \
  --hypothesis "Topic routing should preserve supported conclusions with fewer model calls." \
  --json
```

Claim Scout wakes first for each awake responsibility unit. An app-owned
blackboard then wakes Memory Cartographer only for overlap, Evidence Auditor
only for weak, conflicting, or high-impact claims, Proposal Editor only for
survivors, and Decision Synthesizer only for typed candidates or disagreement.
Unneeded specialists remain at `wait_for_mention`. The run records the named
hypothesis and model-call/token outcome in `paid-run.json`.

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
  runtime/
    coral/
      1.2.0-SNAPSHOT-RC-3/
  setup/
    by-project/
      <project-key>/
        receipt.json
  runs/
    by-project/
      <project-key>/
        <run-id>/
          input.json
          source-counts.json
          responsibility-plan.json
          graph-context.json
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
          blackboard.json
          paid-run.json
          transcript.json
          steps/
  graphs/
    by-project/
      <project-key>/
        memory-graph.db
  gateway/
    state.json
    gateway.jsonl
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

Refinery pins `coralos-dev@1.2.0-SNAPSHOT-RC-3` and its npm registry integrity.
Provisioning is an explicit, disclosed setup action of about 102 MB:

```bash
refinery setup provision coral --confirm --json
```

Ordinary review never invokes `npx`, follows a mutable dist-tag, or downloads a
runtime. It launches only the integrity-checked local runtime above, or an
explicit `--coral-jar` supplied by the user. Node is discovered from the
running executable and Java from `PATH` (or `REFINERY_JAVA_BIN`); no
machine-specific NVM or Homebrew path is a product contract.

When Refinery owns the Coral process, it selects an available loopback port and
an ephemeral 256-bit server auth key for that run. Neither `5555` nor the
development config key is a managed-runtime contract. The private generated
config is removed after teardown, and injected provider credentials plus agent
proxy capabilities are redacted before server logs enter run artifacts.

Coral Server 1.4+ can instead own the provider credential and inject a
session-scoped `MAIN` proxy into each specialist. Refinery does not download a
server JAR implicitly; select the reviewed local JAR explicitly:

```bash
refinery review \
  --source codex:memories \
  --target codex:memories \
  --coral-llm-proxy \
  --model gpt-5.4-nano \
  --model-provider "Coral Cloud, OpenAI" \
  --coral-jar /path/to/coral-server-1.4.0.jar \
  --json
```

The server-proxy route requires Coral Server's `GraphAgentRequest.proxies`
capability. The worker sends no bearer credential of its own, and Refinery
redacts the ephemeral agent proxy URL from logs and run artifacts. Generated
runtime configs contain environment placeholders, use mode `0600`, and are
removed when the managed server is torn down.

DeepSeek V4 Pro uses the same session proxy mechanism with a self-hosted
provider. Provide `DEEPSEEK_API_KEY` through the environment or the ignored
local `.env`, then select it explicitly:

```bash
refinery review \
  --source codex:memories \
  --target codex:memories \
  --coral-llm-proxy \
  --model deepseek-v4-pro \
  --model-provider DeepSeek \
  --reasoning-effort max \
  --coral-jar /path/to/coral-server-1.4.0.jar \
  --json
```

A Coral Cloud API key does not substitute for the DeepSeek provider key.
Provider selection and missing-auth failures are emitted as structured JSON;
Refinery never copies a provider key into an agent manifest or run artifact.

The runtime projects each review topology into explicit communication groups.
`pipeline` links each adjacent specialist in order. `debate-critique` links the
claim and cartography path, the independent claim/audit path, and both paths
into the decision synthesizer. `sparse-blackboard` creates independent topic
threads for awake responsibility units, processes them sequentially so one
specialist cannot strand concurrent mentions, and opens a synthesis thread
only when a deterministic routing condition needs one. The app-owned
blackboard is the durable routing ledger.

The roster remains static in `0.3.0`: sleeping/deferred responsibility units
are not attached to prompts, and unneeded specialists wait for a mention.
Coral Server provides `wait_for_mention` soft sleep; dynamic agent insertion
and native sleep/wake remain capability-gated future seams.

Responsibility plans, graph-context metadata, runtime projections, and Coral
thread metadata are control inputs, not admissible evidence for a new memory.
Final proposals must derive from Proposal Editor's typed candidates and cite a
selected source chunk; Decision Synthesizer cannot resurrect a rejected claim
or cite the runtime's own attachment fields as proof.

To attach to an existing Coral server:

```bash
refinery review \
  --coral-url http://localhost:5555 \
  --coral-auth-key "$CORAL_SERVER_AUTH_KEY" \
  --coral-no-start \
  --json
```

The URL and key are examples supplied by the owner of that server; attached
ports and auth are never inferred. Caller-owned Coral sessions and threads are
not torn down by Refinery.

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

Use `refinery skill install --json` to install or upgrade an unchanged managed
copy. Use `--force` only after reviewing a reported customized-copy conflict.
`$refinery` defaults to live `refinery review` and uses fixture mode only when
the user explicitly asks for mock, fixture, deterministic, no-Coral, or
rehearsal output.
