export type SpecialistName = "capture" | "distillation" | "schema" | "relevance" | "relationship-review";

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
