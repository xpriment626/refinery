import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliberationArtifacts, claimCardsForCritique } from "./deliberation.ts";

test("claim-centered deliberation resolves duplicate challenges through final synthesis", () => {
  const messages = [
    {
      step: "claim-scout",
      agent: "refinery-claim-scout",
      status: "succeeded" as const,
      messageId: "m-claim-scout",
      threadId: "thread-proposal",
      phase: "candidate-proposal",
      output: {
        candidates: [
          {
            claim: "Refinery should reject duplicate Codex memory proposals.",
            source_refs: [{ source_id: "source:1" }],
            why_future_useful: "Prevents redundant memory churn.",
          },
        ],
      },
    },
    {
      step: "proposal-editor",
      agent: "refinery-proposal-editor",
      status: "succeeded" as const,
      messageId: "m-schema",
      threadId: "thread-proposal",
      phase: "typed-proposal",
      output: {
        typed: [
          {
            body: "Refinery should reject duplicate Codex memory proposals.",
            source_refs: [{ source_id: "source:1" }],
            action: "create",
            target_memory_id: null,
            type_confidence: 0.86,
          },
        ],
      },
    },
    {
      step: "evidence-auditor",
      agent: "refinery-evidence-auditor",
      status: "succeeded" as const,
      messageId: "m-preflight",
      threadId: "thread-critique",
      phase: "preflight-critique",
      output: {
        findings: [
          {
            body: "Refinery should reject duplicate Codex memory proposals.",
            relation: "duplicate",
            target_memory_id: "codex-memory:1",
            confidence: 0.91,
            rationale: "An active memory already states this behavior.",
            source_refs: [{ source_id: "source:1" }],
            memory_refs: [{ memory_id: "codex-memory:1", provenance_kind: "memory-index" }],
          },
        ],
      },
    },
    {
      step: "decision-synthesizer",
      agent: "refinery-decision-synthesizer",
      status: "succeeded" as const,
      messageId: "m-synthesis",
      threadId: "thread-proposal",
      phase: "proposal-synthesis",
      output: {
        proposals: [],
        rejected: [
          {
            body: "Refinery should reject duplicate Codex memory proposals.",
            reason: "Rejected because the critique thread found an existing duplicate memory.",
          },
        ],
      },
    },
  ];

  const deliberation = buildDeliberationArtifacts({
    runId: "run-claim-test",
    topology: "debate-critique",
    messages,
  });

  assert.equal(deliberation.summary.claims, 1);
  assert.equal(deliberation.claims[0].claimId, "claim:run-claim-test:1");
  assert.equal(deliberation.claims[0].status, "rejected");
  assert.equal(deliberation.summary.challenges, 1);
  assert.equal(deliberation.challengeLedger[0].kind, "duplicate");
  assert.equal(deliberation.challengeLedger[0].status, "resolved");
  assert.match(deliberation.challengeLedger[0].resolution ?? "", /critique thread found/);
  assert.deepEqual(deliberation.trace.map((move) => move.kind), ["claim", "challenge", "challenge"]);
});

test("claimCardsForCritique emits proposed claim cards from claim scout output", () => {
  const cards = claimCardsForCritique({
    runId: "run-seed",
    claimScoutOutput: {
      candidates: [
        {
          claim: "Claim critique should be local to claim cards.",
          source_refs: [{ source_id: "source:1" }],
          why_future_useful: "Keeps debate bounded.",
        },
      ],
    },
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].claimId, "claim:run-seed:1");
  assert.equal(cards[0].status, "proposed");
  assert.equal(cards[0].body, "Claim critique should be local to claim cards.");
});
