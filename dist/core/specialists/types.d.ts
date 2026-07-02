export type SpecialistName = "claim-scout" | "memory-cartographer" | "evidence-auditor" | "proposal-editor" | "decision-synthesizer";
export interface ToolBoundary {
    allowedTools: string[];
    forbiddenTools: string[];
}
export interface LocalSpecialist {
    name: SpecialistName;
    kind: "local-specialist";
    purpose: string;
    prompt: string;
    inputContract: string[];
    outputContract: string[];
    toolBoundary: ToolBoundary;
}
export type ModelCaller = (args: {
    model: import("../../env.ts").ModelConfig;
    system: string;
    user: string;
    specialist: LocalSpecialist;
}) => Promise<string>;
