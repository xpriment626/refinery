import type { LocalSpecialist, SpecialistName } from "../core/specialists/types.ts";
export declare const refineryCoralAgentVersion = "0.1.0";
export declare const refineryCoralAuthKey = "refinery-dev";
export declare const refineryCoralPort = 5555;
export declare const refineryCoralConfigPath = "coral/refinery-config.toml";
export declare const refineryCoralAgentGlob = "coral/agents/*";
export declare const refineryCoralModelDefaults: {
    readonly modelName: "gpt-5.4-nano";
    readonly baseUrl: "https://llm.coralcloud.ai/openai/v1";
    readonly reasoningEffort: "low";
};
export interface RefineryCoralAgentDefinition {
    specialistName: SpecialistName;
    agentName: string;
    folderName: string;
    version: typeof refineryCoralAgentVersion;
    specialist: LocalSpecialist;
}
export declare const refineryCoralAgents: RefineryCoralAgentDefinition[];
export declare const refineryCoralAgentNames: string[];
export declare function refineryCoralAgentGlobForRepo(repoRoot?: string): string;
export declare function getCoralAgentBySpecialistName(name: SpecialistName): RefineryCoralAgentDefinition;
export declare function getCoralAgentByAgentName(name: string): RefineryCoralAgentDefinition;
export declare function isRefineryCoralAgentName(name: string): boolean;
export declare function getSpecialistNameArg(args: string[]): SpecialistName;
