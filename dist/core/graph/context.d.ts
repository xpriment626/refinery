import type { ReviewPacket } from "../types.ts";
import type { ResponsibilityPlan } from "./plan.ts";
import type { MemoryGraphIndex } from "./sync.ts";
export declare function attachResponsibilityContext(args: {
    packet: ReviewPacket;
    index: MemoryGraphIndex;
    plan: ResponsibilityPlan;
}): ReviewPacket;
