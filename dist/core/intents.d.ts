export declare const reviewIntents: readonly ["general-review", "stale-audit", "forget-candidates", "update-candidates", "conflict-audit", "scope-audit", "session-recurrence", "memory-gap-audit", "skill-promotion-audit"];
export type ReviewIntent = (typeof reviewIntents)[number];
export declare const defaultReviewIntent: ReviewIntent;
export declare function parseReviewIntent(value: unknown): ReviewIntent;
export declare function describeReviewIntent(intent: ReviewIntent): string;
