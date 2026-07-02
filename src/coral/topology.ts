import { RefineryError } from "../core/errors.ts";

export const reviewTopologies = ["pipeline", "debate-critique"] as const;

export type ReviewTopology = (typeof reviewTopologies)[number];

export const defaultReviewTopology: ReviewTopology = "debate-critique";

export function parseReviewTopology(value: unknown): ReviewTopology {
  if (value === undefined || value === null || value === "") return defaultReviewTopology;
  if (typeof value !== "string" || !reviewTopologies.includes(value as ReviewTopology)) {
    throw new RefineryError(
      "INVALID_OPTION",
      `review --topology must be one of: ${reviewTopologies.join(", ")}.`,
      { phase: "args", details: { topology: value } },
    );
  }
  return value as ReviewTopology;
}

export function isReviewTopology(value: unknown): value is ReviewTopology {
  return typeof value === "string" && reviewTopologies.includes(value as ReviewTopology);
}
