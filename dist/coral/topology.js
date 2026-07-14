import { RefineryError } from "../core/errors.js";
import { refineryCoralAgentNames } from "./definitions.js";
export const reviewTopologies = ["pipeline", "debate-critique", "sparse-blackboard"];
export const defaultReviewTopology = "debate-critique";
export function buildCoralCommunicationGroups(topology) {
    const [claimScout, memoryCartographer, evidenceAuditor, proposalEditor, decisionSynthesizer] = refineryCoralAgentNames;
    if (topology === "pipeline")
        return [
            [claimScout, memoryCartographer],
            [memoryCartographer, evidenceAuditor],
            [evidenceAuditor, proposalEditor],
            [proposalEditor, decisionSynthesizer],
        ];
    if (topology === "debate-critique")
        return [
            [claimScout, memoryCartographer],
            [memoryCartographer, proposalEditor],
            [claimScout, evidenceAuditor],
            [evidenceAuditor, decisionSynthesizer],
            [proposalEditor, decisionSynthesizer],
        ];
    return [
        [claimScout, memoryCartographer],
        [claimScout, evidenceAuditor],
        [claimScout, proposalEditor],
        [memoryCartographer, proposalEditor],
        [evidenceAuditor, proposalEditor],
        [proposalEditor, decisionSynthesizer],
    ];
}
function wakeTargetForUnit(unit) {
    switch (unit.kind) {
        case "memory":
            return "refinery-memory-cartographer";
        case "skill":
            return "refinery-proposal-editor";
        case "source-cluster":
        case "session":
        case "resource":
            return "refinery-claim-scout";
    }
}
export function buildCoralCommunicationProjection(topology, units = []) {
    return {
        schemaVersion: "refinery.coral-runtime-projection.v1",
        topology,
        roster: "static-specialists",
        groups: buildCoralCommunicationGroups(topology),
        dynamicAgentInsertion: false,
        nativeSleep: false,
        idleMechanism: "wait_for_mention",
        wakeSignal: "mention",
        durableStateOwner: "refinery-libsql",
        coordination: topology === "sparse-blackboard"
            ? "app-owned-topic-blackboard"
            : topology === "debate-critique" ? "claim-critique" : "agent-chain",
        attachments: units.map((unit) => {
            const wakeTargetAgent = topology === "sparse-blackboard" ? "refinery-claim-scout" : wakeTargetForUnit(unit);
            return {
                responsibilityUnitId: unit.id,
                responsibilityState: unit.state,
                wakeTargetAgent,
                attachedAgent: unit.state === "awake" ? wakeTargetAgent : null,
            };
        }),
    };
}
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