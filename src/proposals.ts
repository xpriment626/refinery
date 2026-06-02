import os from "node:os";
import type { DatabaseSync } from "node:sqlite";

export interface ProposalRow {
  id: number;
  project_id: number;
  memory_type: string;
  proposed_scope: string;
  body: string;
  confidence: number;
  rationale: string;
  source_refs: string;
  mutation_op: string;
  target_memory_id: number | null;
  status: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resulting_memory_id: number | null;
}

/**
 * Deterministic seed proposals carrying the full eight-field contract. This
 * keeps the governance slice independent of the (not-yet-built) LLM refiner.
 * Idempotent via dedupe_key. source_refs / target are resolved at seed time
 * against the already-imported Fabrick corpus so provenance is real.
 */
function findSourceId(db: DatabaseSync, like: string): number | null {
  const row = db
    .prepare(`SELECT id FROM source WHERE source_path LIKE ? LIMIT 1`)
    .get(`%${like}`) as { id: number } | undefined;
  return row?.id ?? null;
}

function findActiveMemoryId(db: DatabaseSync, like: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM memory WHERE source_path LIKE ? AND status = 'active' LIMIT 1`,
    )
    .get(`%${like}`) as { id: number } | undefined;
  return row?.id ?? null;
}

export function seedProposals(db: DatabaseSync, projectId: number): number {
  const now = new Date().toISOString();
  const ref = (id: number | null, path: string) => JSON.stringify([{ source_id: id, source_path: path }]);

  const seeds = [
    {
      dedupe_key: "seed-1-dream-pass",
      memory_type: "procedural",
      proposed_scope: "project",
      body:
        "Fabrick's Stage-0 memory loop runs a single LLM call per dream-pass that performs capture, distillation, schema assignment, and promotion together, writing to three sinks (atom store, archive backfill, working memory).",
      confidence: 0.86,
      rationale:
        "Recurs across the dream-pass design note and multiple checkpoints; concrete, durable, and self-contained.",
      source_refs: ref(findSourceId(db, "project_dream_pass.md"), "project_dream_pass.md"),
      mutation_op: "create",
      target_memory_id: null,
    },
    {
      dedupe_key: "seed-2-multi-agent-thesis",
      memory_type: "semantic",
      proposed_scope: "project",
      body:
        "Memory is the primitive and multi-agent coordination is the refiner: the memory layer accepts writes from any producer, while Coral is an additive refinement layer rather than a precondition.",
      confidence: 0.78,
      rationale:
        "Refines the existing multi-agent thesis memory to the post-reframe framing; supersedes the older statement.",
      source_refs: ref(findSourceId(db, "project_multi_agent_thesis.md"), "project_multi_agent_thesis.md"),
      mutation_op: "supersede",
      target_memory_id: findActiveMemoryId(db, "project_multi_agent_thesis.md"),
    },
    {
      dedupe_key: "seed-3-ephemeral",
      memory_type: "operational",
      proposed_scope: "project",
      body: "The dev server was restarted once on 2026-05-20 to clear a stale port binding.",
      confidence: 0.31,
      rationale:
        "Low-value, ephemeral operational detail; included so a reviewer can exercise rejection.",
      source_refs: ref(findSourceId(db, "checkpoint_2026-05-19_fleet-loop-fixed-mode-registry-shipped.md"), "checkpoint_2026-05-19_fleet-loop-fixed-mode-registry-shipped.md"),
      mutation_op: "create",
      target_memory_id: null,
    },
  ];

  const insert = db.prepare(
    `INSERT INTO proposal
       (project_id, dedupe_key, memory_type, proposed_scope, body, confidence,
        rationale, source_refs, mutation_op, target_memory_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );

  let inserted = 0;
  for (const s of seeds) {
    const res = insert.run(
      projectId,
      s.dedupe_key,
      s.memory_type,
      s.proposed_scope,
      s.body,
      s.confidence,
      s.rationale,
      s.source_refs,
      s.mutation_op,
      s.target_memory_id,
      now,
    );
    if (res.changes > 0) inserted++;
  }
  return inserted;
}

export function listProposals(db: DatabaseSync): ProposalRow[] {
  return db
    .prepare(`SELECT * FROM proposal ORDER BY id`)
    .all() as unknown as ProposalRow[];
}

export function getProposal(db: DatabaseSync, id: number): ProposalRow | undefined {
  return db.prepare(`SELECT * FROM proposal WHERE id = ?`).get(id) as
    | ProposalRow
    | undefined;
}

export interface ReviewResult {
  proposal: ProposalRow;
  resultingMemoryId: number | null;
  demotedMemoryId: number | null;
}

/**
 * Approve a proposal: the ONLY path by which durable memory becomes active.
 * - create                  -> insert one new active memory (+1 active)
 * - update/supersede/merge   -> insert new active memory; demote the target to
 *                               'superseded' if present (net 0 active)
 * - archive                  -> archive the target; no new memory (-1 active)
 * Records approver + timestamp and links the resulting memory to the proposal.
 */
export function approveProposal(
  db: DatabaseSync,
  id: number,
  approver: string,
): ReviewResult {
  const p = getProposal(db, id);
  if (!p) throw new Error(`proposal ${id} not found`);
  if (p.status !== "proposed")
    throw new Error(`proposal ${id} is '${p.status}', not 'proposed'`);

  const now = new Date().toISOString();
  let resultingMemoryId: number | null = null;
  let demotedMemoryId: number | null = null;

  db.exec("BEGIN");
  try {
    const insertMemory = db.prepare(
      `INSERT INTO memory
         (project_id, type, scope, status, body, confidence, provenance_kind,
          source_id, source_path, source_refs, proposal_id, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, 'refinery-proposal', NULL, NULL, ?, ?, ?)`,
    );
    const demote = (memId: number, status: string) =>
      db.prepare(`UPDATE memory SET status = ? WHERE id = ?`).run(status, memId);

    if (p.mutation_op === "archive") {
      if (p.target_memory_id) {
        demote(p.target_memory_id, "archived");
        demotedMemoryId = p.target_memory_id;
      }
    } else {
      const res = insertMemory.run(
        p.project_id,
        p.memory_type,
        p.proposed_scope,
        p.body,
        p.confidence,
        p.source_refs,
        p.id,
        now,
      );
      resultingMemoryId = Number(res.lastInsertRowid);
      if (
        (p.mutation_op === "supersede" ||
          p.mutation_op === "update" ||
          p.mutation_op === "merge") &&
        p.target_memory_id
      ) {
        demote(p.target_memory_id, "superseded");
        demotedMemoryId = p.target_memory_id;
      }
    }

    db.prepare(
      `UPDATE proposal
         SET status = 'approved', reviewed_by = ?, reviewed_at = ?, resulting_memory_id = ?
       WHERE id = ?`,
    ).run(approver, now, resultingMemoryId, p.id);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { proposal: getProposal(db, id)!, resultingMemoryId, demotedMemoryId };
}

export function rejectProposal(
  db: DatabaseSync,
  id: number,
  reviewer: string,
): ProposalRow {
  const p = getProposal(db, id);
  if (!p) throw new Error(`proposal ${id} not found`);
  if (p.status !== "proposed")
    throw new Error(`proposal ${id} is '${p.status}', not 'proposed'`);

  db.prepare(
    `UPDATE proposal SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
  ).run(reviewer, new Date().toISOString(), p.id);
  return getProposal(db, id)!;
}

export function defaultActor(): string {
  try {
    return os.userInfo().username || "local-operator";
  } catch {
    return "local-operator";
  }
}
