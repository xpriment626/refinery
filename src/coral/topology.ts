import { RefineryError } from "../core/errors.ts";
import type { ResponsibilityUnit } from "../core/graph/plan.ts";
import { refineryCoralAgentNames } from "./definitions.ts";

export const reviewTopologies = ["pipeline", "debate-critique", "sparse-blackboard"] as const;

export type ReviewTopology = (typeof reviewTopologies)[number];

export const defaultReviewTopology: ReviewTopology = "debate-critique";

export interface CoralResponsibilityAttachment {
  responsibilityUnitId: string;
  responsibilityState: ResponsibilityUnit["state"];
  wakeTargetAgent: string;
  attachedAgent: string | null;
}

export interface CoralCommunicationProjection {
  schemaVersion: "refinery.coral-runtime-projection.v1";
  topology: ReviewTopology;
  roster: "static-specialists";
  groups: string[][];
  dynamicAgentInsertion: false;
  nativeSleep: false;
  idleMechanism: "wait_for_mention";
  wakeSignal: "mention";
  durableStateOwner: "refinery-libsql";
  coordination: "agent-chain" | "claim-critique" | "app-owned-topic-blackboard";
  attachments: CoralResponsibilityAttachment[];
}

export function buildCoralCommunicationGroups(topology: ReviewTopology): string[][] {
  const [claimScout, memoryCartographer, evidenceAuditor, proposalEditor, decisionSynthesizer] = refineryCoralAgentNames;
  if (topology === "pipeline") return [
        [claimScout, memoryCartographer],
        [memoryCartographer, evidenceAuditor],
        [evidenceAuditor, proposalEditor],
        [proposalEditor, decisionSynthesizer],
      ];
  if (topology === "debate-critique") return [
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

function wakeTargetForUnit(unit: ResponsibilityUnit): string {
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

export function buildCoralCommunicationProjection(
  topology: ReviewTopology,
  units: ResponsibilityUnit[] = [],
): CoralCommunicationProjection {
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
