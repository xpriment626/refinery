import { RefineryError } from "../core/errors.js";
export const reviewTopologies = ["pipeline", "debate-critique"];
export const defaultReviewTopology = "debate-critique";
export function parseReviewTopology(value) {
    if (value === undefined || value === null || value === "")
        return defaultReviewTopology;
    if (typeof value !== "string" || !reviewTopologies.includes(value)) {
        throw new RefineryError("INVALID_OPTION", `review --topology must be one of: ${reviewTopologies.join(", ")}.`, { phase: "args", details: { topology: value } });
    }
    return value;
}
export function isReviewTopology(value) {
    return typeof value === "string" && reviewTopologies.includes(value);
}
//# sourceMappingURL=topology.js.map