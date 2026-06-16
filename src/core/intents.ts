import { RefineryError } from "./errors.ts";

export const reviewIntents = [
  "general-review",
  "stale-audit",
  "forget-candidates",
  "update-candidates",
  "conflict-audit",
  "scope-audit",
] as const;

export type ReviewIntent = (typeof reviewIntents)[number];

export const defaultReviewIntent: ReviewIntent = "general-review";

export function parseReviewIntent(value: unknown): ReviewIntent {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : defaultReviewIntent;
  if (!reviewIntents.includes(candidate as ReviewIntent)) {
    throw new RefineryError(
      "INVALID_OPTION",
      `review --intent must be one of: ${reviewIntents.join(", ")}.`,
      { phase: "args", details: { intent: value } },
    );
  }
  return candidate as ReviewIntent;
}

export function describeReviewIntent(intent: ReviewIntent): string {
  switch (intent) {
    case "general-review":
      return "Review the memory/source packet for durable, useful memory-maintenance proposals.";
    case "stale-audit":
      return "Identify active memories that may be stale, outdated, superseded, or no longer true.";
    case "forget-candidates":
      return "Identify memories that may be low-value, redundant, obsolete, noisy, or worth archiving/quarantining.";
    case "update-candidates":
      return "Identify memories that remain useful but likely need correction, replacement text, or refreshed scope.";
    case "conflict-audit":
      return "Identify memories or source claims that contradict each other and need contradiction review.";
    case "scope-audit":
      return "Identify memories whose user/project/org scope appears too broad, too narrow, or attached to the wrong context.";
  }
}
