export declare const reviewTopologies: readonly ["pipeline", "debate-critique"];
export type ReviewTopology = (typeof reviewTopologies)[number];
export declare const defaultReviewTopology: ReviewTopology;
export declare function parseReviewTopology(value: unknown): ReviewTopology;
export declare function isReviewTopology(value: unknown): value is ReviewTopology;
