import { defaultModelBaseUrl, defaultModelName } from "../env.ts";
import type { LocalSpecialist, SpecialistName } from "../core/specialists/types.ts";
import { orderedSpecialists } from "../core/specialists/harness.ts";
import path from "node:path";

export const refineryCoralAgentVersion = "0.1.0";
export const refineryCoralAuthKey = "refinery-dev";
export const refineryCoralPort = 5555;
export const refineryCoralConfigPath = "coral/refinery-config.toml";
export const refineryCoralAgentGlob = "coral/agents/*";

export const refineryCoralModelDefaults = {
  modelName: defaultModelName,
  baseUrl: defaultModelBaseUrl,
  reasoningEffort: "low",
} as const;

export interface RefineryCoralAgentDefinition {
  specialistName: SpecialistName;
  agentName: string;
  folderName: string;
  version: typeof refineryCoralAgentVersion;
  specialist: LocalSpecialist;
}

function agentNameForSpecialist(name: SpecialistName): string {
  return `refinery-${name}`;
}

export const refineryCoralAgents: RefineryCoralAgentDefinition[] = orderedSpecialists.map((specialist) => ({
  specialistName: specialist.name,
  agentName: agentNameForSpecialist(specialist.name),
  folderName: specialist.name,
  version: refineryCoralAgentVersion,
  specialist,
}));

export const refineryCoralAgentNames = refineryCoralAgents.map((agent) => agent.agentName);

export function refineryCoralAgentGlobForRepo(repoRoot = process.cwd()): string {
  return path.join(repoRoot, refineryCoralAgentGlob);
}

export function getCoralAgentBySpecialistName(name: SpecialistName): RefineryCoralAgentDefinition {
  const agent = refineryCoralAgents.find((candidate) => candidate.specialistName === name);
  if (!agent) throw new Error(`Unknown Refinery specialist: ${name}`);
  return agent;
}

export function getCoralAgentByAgentName(name: string): RefineryCoralAgentDefinition {
  const agent = refineryCoralAgents.find((candidate) => candidate.agentName === name);
  if (!agent) throw new Error(`Unknown Refinery Coral agent: ${name}`);
  return agent;
}

export function isRefineryCoralAgentName(name: string): boolean {
  return refineryCoralAgents.some((agent) => agent.agentName === name);
}

export function getSpecialistNameArg(args: string[]): SpecialistName {
  const index = args.indexOf("--specialist");
  const raw = index >= 0 ? args[index + 1] : args[0];
  if (!raw) {
    throw new Error(`Usage: refinery coral worker --specialist ${orderedSpecialists.map((s) => s.name).join("|")}`);
  }
  if (!orderedSpecialists.some((specialist) => specialist.name === raw)) {
    throw new Error(`Unknown specialist "${raw}". Expected one of ${orderedSpecialists.map((s) => s.name).join(", ")}`);
  }
  return raw as SpecialistName;
}
