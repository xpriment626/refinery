export const memoryMaintenanceActions = [
    "create",
    "update",
    "supersede",
    "merge",
    "archive",
    "retag",
    "quarantine",
    "promote",
    "demote",
    "ttl_update",
    "contradiction_review",
];
export const memoryProposalLifecycleStates = [
    "proposed",
    "needs_review",
    "accepted",
    "rejected",
    "deferred",
    "applied_externally",
    "superseded",
    "archived_for_audit",
];
export const refineryReviewSchemaVersion = "refinery.review.v1";
export const reviewPacketSchemaVersion = "refinery.review-packet.v1";
export const sourceSpecKinds = ["codex:memories", "codex:sessions", "codex:skills", "file", "glob"];
export const targetSurfaces = ["codex:memories", "codex:skills"];
//# sourceMappingURL=types.js.map