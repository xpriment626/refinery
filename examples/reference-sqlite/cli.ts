#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolvePaths } from "./config.ts";
import { openDb, tableCounts, ensureProject, activeMemoryCount } from "./db.ts";
import { sha256File } from "./hash.ts";
import {
  encodeProjectPath,
  resolveClaudeProjectDir,
  discoverSessions,
  discoverLegacyMemory,
  type DiscoveredSource,
} from "./discovery.ts";
import {
  seedProposals,
  listProposals,
  getProposal,
  approveProposal,
  rejectProposal,
  defaultActor,
  type ProposalRow,
} from "./proposals.ts";

const HELP = `refinery — local memory service (ingestion-and-inspection slice)

USAGE
  refinery up                     Start the local Refinery instance (create/migrate
                                  relational store + raw source store). Single command.
  refinery import claude-code     Discover & import Claude Code history for the current
        [--path <dir>]            working directory (or --path). Imports JSONL sessions
                                  and legacy memory/*.md (as active legacy memories).
  refinery inspect sources        List imported sources with provenance.
  refinery inspect memories       List active memories with provenance.

  refinery proposals seed         Insert deterministic seed proposals (idempotent).
  refinery proposals list         List proposals with lifecycle status.
  refinery proposals show <id>    Show one proposal with the full 8-field contract.
  refinery proposals approve <id> Approve -> activate as memory (records approver).
        [--by <actor>]
  refinery proposals reject <id>  Reject -> never becomes active.
        [--by <actor>]
  refinery --help                 Show this help.

The encoded Claude project path is derived from the working directory at runtime;
it is never hardcoded. Source files are read-only and never modified.`;

function isoMtime(p: string): string {
  return fs.statSync(p).mtime.toISOString();
}

/** Copy original bytes into the content-addressed raw store. Read-only on source. */
function stashRaw(rawDir: string, sha: string, sourcePath: string): string {
  const dest = path.join(rawDir, sha);
  if (!fs.existsSync(dest)) fs.copyFileSync(sourcePath, dest);
  return dest;
}

function cmdUp(): void {
  const paths = resolvePaths();
  const db = openDb(paths);
  const counts = tableCounts(db);
  db.close();
  console.log("Refinery local service ready.");
  console.log(`  instance home : ${paths.home}`);
  console.log(`  relational db : ${paths.dbPath}`);
  console.log(`  raw store     : ${paths.rawDir}`);
  console.log(
    `  current rows  : project=${counts.project} source=${counts.source} memory=${counts.memory}`,
  );
}

function cmdImportClaudeCode(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { path: { type: "string" } },
    allowPositionals: false,
  });

  const rootAbs = path.resolve(values.path ?? process.cwd());
  const encoded = encodeProjectPath(rootAbs);
  const claudeDir = resolveClaudeProjectDir(rootAbs);

  console.log(`Working directory : ${rootAbs}`);
  console.log(`Derived encoding  : ${encoded}`);
  console.log(`Claude history    : ${claudeDir}`);

  if (!fs.existsSync(claudeDir)) {
    console.error(
      `\nERROR: no Claude Code history found at the derived path.\n` +
        `Run from a directory that has Claude Code sessions, or pass --path.`,
    );
    process.exit(1);
  }

  const sessions = discoverSessions(claudeDir);
  const memories = discoverLegacyMemory(claudeDir);
  console.log(`Discovered        : ${sessions.length} sessions, ${memories.length} legacy memory files`);

  const paths = resolvePaths();
  const db = openDb(paths);
  const projectId = ensureProject(db, rootAbs, encoded);

  const insertSource = db.prepare(
    `INSERT INTO source
       (project_id, kind, source_path, session_id, sha256, byte_size, source_mtime, raw_blob, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, source_path) DO NOTHING`,
  );
  const selectSourceId = db.prepare(
    `SELECT id FROM source WHERE project_id = ? AND source_path = ?`,
  );
  const insertMemory = db.prepare(
    `INSERT INTO memory
       (project_id, type, scope, status, body, confidence, provenance_kind, source_id, source_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO NOTHING`,
  );

  let newSources = 0;
  let newMemories = 0;

  const importSource = (d: DiscoveredSource): number => {
    const sha = sha256File(d.sourcePath);
    const size = fs.statSync(d.sourcePath).size;
    stashRaw(paths.rawDir, sha, d.sourcePath);
    const res = insertSource.run(
      projectId,
      d.kind,
      d.sourcePath,
      d.sessionId,
      sha,
      size,
      isoMtime(d.sourcePath),
      path.join(paths.rawDir, sha),
      new Date().toISOString(),
    );
    if (res.changes > 0) newSources++;
    const row = selectSourceId.get(projectId, d.sourcePath) as { id: number };
    return row.id;
  };

  db.exec("BEGIN");
  try {
    for (const s of sessions) importSource(s);
    for (const m of memories) {
      const sourceId = importSource(m);
      const body = fs.readFileSync(m.sourcePath, "utf8");
      const res = insertMemory.run(
        projectId,
        "legacy",
        "project",
        "active",
        body,
        null,
        "claude-memory-legacy",
        sourceId,
        m.sourcePath,
        new Date().toISOString(),
      );
      if (res.changes > 0) newMemories++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const counts = tableCounts(db);
  db.close();

  console.log(`\nImported (new this run): ${newSources} sources, ${newMemories} active memories`);
  console.log(
    `In store now           : source=${counts.source} (sessions+memories), memory=${counts.memory} active`,
  );
}

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const fmt = (vals: string[]) =>
    vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(fmt(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(cols.map((c) => String(r[c] ?? ""))));
}

function cmdInspect(sub: string): void {
  const paths = resolvePaths();
  const db = openDb(paths);

  if (sub === "sources") {
    const rows = db
      .prepare(
        `SELECT kind, session_id, source_path, substr(sha256,1,12) AS sha,
                byte_size, source_mtime, imported_at
         FROM source ORDER BY kind, source_path`,
      )
      .all() as Record<string, string>[];
    console.log(`Sources (${rows.length}):\n`);
    printTable(
      rows.map((r) => ({
        kind: r.kind,
        session_id: r.session_id ?? "",
        source: path.basename(String(r.source_path)),
        sha256: String(r.sha) + "…",
        bytes: String(r.byte_size),
        source_mtime: String(r.source_mtime),
        imported_at: String(r.imported_at),
      })),
    );
  } else if (sub === "memories") {
    const rows = db
      .prepare(
        `SELECT id, type, scope, status, provenance_kind, source_path, proposal_id,
                source_refs, length(body) AS len, created_at
         FROM memory ORDER BY id`,
      )
      .all() as Record<string, string>[];
    const active = rows.filter((r) => String(r.status) === "active").length;
    console.log(`Memories (${rows.length} total, ${active} active):\n`);
    printTable(
      rows.map((r) => {
        let provLink = r.source_path ? path.basename(String(r.source_path)) : "";
        if (r.proposal_id) {
          let refHint = "";
          try {
            const refs = JSON.parse(String(r.source_refs ?? "[]")) as {
              source_path?: string;
            }[];
            if (refs[0]?.source_path) refHint = ` via ${path.basename(refs[0].source_path)}`;
          } catch {
            /* ignore */
          }
          provLink = `proposal#${r.proposal_id}${refHint}`;
        }
        return {
          id: String(r.id),
          type: r.type,
          scope: r.scope,
          status: r.status,
          provenance: r.provenance_kind,
          provenance_link: provLink,
          body_chars: String(r.len),
          created_at: String(r.created_at),
        };
      }),
    );
  } else {
    console.error(`Unknown inspect target: ${sub}. Use 'sources' or 'memories'.`);
    db.close();
    process.exit(1);
  }
  db.close();
}

function fmtProposalSummary(p: ProposalRow): Record<string, string> {
  const target = p.target_memory_id == null ? "" : `mem#${p.target_memory_id}`;
  const result = p.resulting_memory_id == null ? "" : `mem#${p.resulting_memory_id}`;
  return {
    id: String(p.id),
    status: p.status,
    op: p.mutation_op,
    type: p.memory_type,
    scope: p.proposed_scope,
    conf: p.confidence.toFixed(2),
    target: target,
    result: result,
    body: p.body.length > 60 ? p.body.slice(0, 57) + "…" : p.body,
  };
}

function cmdProposals(rest: string[]): void {
  const sub = rest[0] ?? "";
  const { values, positionals } = parseArgs({
    args: rest.slice(1),
    options: { by: { type: "string" } },
    allowPositionals: true,
  });
  const paths = resolvePaths();
  const db = openDb(paths);

  const requireId = (): number => {
    const id = Number(positionals[0]);
    if (!Number.isInteger(id)) {
      console.error(`Expected a numeric proposal id. Got: ${positionals[0]}`);
      db.close();
      process.exit(1);
    }
    return id;
  };

  if (sub === "seed") {
    const proj = db.prepare(`SELECT id FROM project ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!proj) {
      console.error("No project found. Run `import claude-code` first.");
      db.close();
      process.exit(1);
    }
    const inserted = seedProposals(db, proj.id);
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM proposal`).get() as { c: number }).c;
    console.log(`Seeded ${inserted} new proposal(s). ${total} proposal(s) in store.`);
  } else if (sub === "list") {
    const rows = listProposals(db);
    console.log(`Proposals (${rows.length}):\n`);
    printTable(rows.map(fmtProposalSummary));
  } else if (sub === "show") {
    const p = getProposal(db, requireId());
    if (!p) {
      console.error(`proposal not found`);
      db.close();
      process.exit(1);
    }
    let refs = p.source_refs;
    try {
      refs = JSON.stringify(JSON.parse(p.source_refs));
    } catch {
      /* leave raw */
    }
    console.log(`Proposal #${p.id}  [${p.status}]`);
    console.log(`  (1) memory type        : ${p.memory_type}`);
    console.log(`  (2) proposed scope      : ${p.proposed_scope}`);
    console.log(`  (3) atomic body         : ${p.body}`);
    console.log(`  (4) confidence          : ${p.confidence}`);
    console.log(`  (5) rationale           : ${p.rationale}`);
    console.log(`  (6) source refs         : ${refs}`);
    console.log(`  (7) mutation operation  : ${p.mutation_op}`);
    console.log(
      `  (8) existing-mem target : ${p.target_memory_id == null ? "(n/a — create)" : `memory#${p.target_memory_id}`}`,
    );
    console.log(`  ---`);
    console.log(`  created_at              : ${p.created_at}`);
    console.log(`  reviewed_by / at        : ${p.reviewed_by ?? "—"} / ${p.reviewed_at ?? "—"}`);
    console.log(`  resulting memory        : ${p.resulting_memory_id == null ? "—" : `memory#${p.resulting_memory_id}`}`);
  } else if (sub === "approve") {
    const id = requireId();
    const actor = values.by ?? defaultActor();
    const before = activeMemoryCount(db);
    try {
      const r = approveProposal(db, id, actor);
      const after = activeMemoryCount(db);
      console.log(`Approved proposal #${id} by ${actor} (${r.proposal.mutation_op}).`);
      if (r.resultingMemoryId != null)
        console.log(`  -> activated memory#${r.resultingMemoryId} (provenance: proposal#${id})`);
      if (r.demotedMemoryId != null)
        console.log(`  -> demoted memory#${r.demotedMemoryId}`);
      console.log(`  active-memory count: ${before} -> ${after} (delta ${after - before >= 0 ? "+" : ""}${after - before})`);
    } catch (e) {
      console.error(`Refused: ${(e as Error).message}. No memory activated.`);
      console.error(`  active-memory count unchanged: ${activeMemoryCount(db)}`);
      db.close();
      process.exit(1);
    }
  } else if (sub === "reject") {
    const id = requireId();
    const actor = values.by ?? defaultActor();
    const before = activeMemoryCount(db);
    try {
      const p = rejectProposal(db, id, actor);
      const after = activeMemoryCount(db);
      console.log(`Rejected proposal #${id} by ${actor}. Status now '${p.status}'.`);
      console.log(`  active-memory count: ${before} -> ${after} (unchanged: ${before === after})`);
    } catch (e) {
      console.error(`Refused: ${(e as Error).message}.`);
      db.close();
      process.exit(1);
    }
  } else {
    console.error(`Unknown proposals subcommand: '${sub}'. Use seed|list|show|approve|reject.`);
    db.close();
    process.exit(1);
  }
  db.close();
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "up":
      cmdUp();
      break;
    case "import":
      if (rest[0] === "claude-code") cmdImportClaudeCode(rest.slice(1));
      else {
        console.error("Unknown import source. Use: refinery import claude-code");
        process.exit(1);
      }
      break;
    case "inspect":
      cmdInspect(rest[0] ?? "");
      break;
    case "proposals":
      cmdProposals(rest);
      break;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
