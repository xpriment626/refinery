export const memoryMaintenanceActions = [
  "create",
  "update",
  "supersede",
  "merge",
  "archive",
  "retag",
  "quarantine",
  "promote",
  "demote",
  "ttl_update",
  "contradiction_review",
] as const;

export const memoryProposalLifecycleStates = [
  "proposed",
  "needs_review",
  "accepted",
  "rejected",
  "deferred",
  "applied_externally",
  "superseded",
  "archived_for_audit",
] as const;

export const refineryReviewSchemaVersion = "refinery.review.v1";

export type MemoryMaintenanceAction = (typeof memoryMaintenanceActions)[number];
export type MemoryProposalLifecycle = (typeof memoryProposalLifecycleStates)[number];

export interface SourceEvidence {
  id: string;
  kind: string;
  path?: string | null;
  text: string;
  refs?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface ActiveMemory {
  id: string;
  type: string;
  scope: string;
  status: string;
  body: string;
  confidence?: number | null;
  provenance?: Record<string, unknown>;
}

export interface AdapterScopeInput {
  scope: string;
  limit?: number;
}

export interface AdapterSearchInput extends AdapterScopeInput {
  query: string;
}

export interface AdapterReadInput {
  scope: string;
  id: string;
}

export interface MemoryProposal {
  schemaVersion: typeof refineryReviewSchemaVersion;
  id: string;
  action: MemoryMaintenanceAction;
  lifecycle: MemoryProposalLifecycle;
  memoryType: string;
  scope: string;
  body: string;
  confidence: number;
  rationale: string;
  sourceRefs: unknown[];
  targetMemoryId: string | null;
}

export interface ApplyProposalInput {
  proposal: MemoryProposal;
  approvedBy: string;
  dryRun?: boolean;
}

export interface MemoryStoreAdapter {
  name: string;
  listSourceEvidence(input: AdapterScopeInput): Promise<SourceEvidence[]>;
  searchSourceEvidence(input: AdapterSearchInput): Promise<SourceEvidence[]>;
  getSourceEvidence(input: AdapterReadInput): Promise<SourceEvidence | null>;
  listActiveMemories(input: AdapterScopeInput): Promise<ActiveMemory[]>;
  searchActiveMemories(input: AdapterSearchInput): Promise<ActiveMemory[]>;
  getActiveMemory(input: AdapterReadInput): Promise<ActiveMemory | null>;
  applyProposal?(input: ApplyProposalInput): Promise<unknown>;
}

export interface AdapterValidationResult {
  valid: boolean;
  name: string | null;
  capabilities: {
    listSourceEvidence: boolean;
    searchSourceEvidence: boolean;
    getSourceEvidence: boolean;
    listActiveMemories: boolean;
    searchActiveMemories: boolean;
    getActiveMemory: boolean;
    applyProposal: boolean;
  };
  errors: string[];
}

export interface AdapterProbeResult {
  probed: boolean;
  valid: boolean;
  sourceCount: number;
  activeMemoryCount: number;
  errors: string[];
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

export function validateMemoryStoreAdapter(adapter: unknown): AdapterValidationResult {
  const candidate = adapter as Partial<MemoryStoreAdapter> | null;
  const errors: string[] = [];
  const capabilities = {
    listSourceEvidence: Boolean(candidate && isFunction(candidate.listSourceEvidence)),
    searchSourceEvidence: Boolean(candidate && isFunction(candidate.searchSourceEvidence)),
    getSourceEvidence: Boolean(candidate && isFunction(candidate.getSourceEvidence)),
    listActiveMemories: Boolean(candidate && isFunction(candidate.listActiveMemories)),
    searchActiveMemories: Boolean(candidate && isFunction(candidate.searchActiveMemories)),
    getActiveMemory: Boolean(candidate && isFunction(candidate.getActiveMemory)),
    applyProposal: Boolean(candidate && isFunction(candidate.applyProposal)),
  };

  if (!candidate || typeof candidate !== "object") {
    errors.push("adapter must be an object");
  }
  if (!candidate || typeof candidate.name !== "string" || !candidate.name.trim()) {
    errors.push("adapter.name must be a non-empty string");
  }
  if (!capabilities.listSourceEvidence) {
    errors.push("adapter.listSourceEvidence(input) is required");
  }
  if (!capabilities.searchSourceEvidence) {
    errors.push("adapter.searchSourceEvidence(input) is required");
  }
  if (!capabilities.getSourceEvidence) {
    errors.push("adapter.getSourceEvidence(input) is required");
  }
  if (!capabilities.listActiveMemories) {
    errors.push("adapter.listActiveMemories(input) is required");
  }
  if (!capabilities.searchActiveMemories) {
    errors.push("adapter.searchActiveMemories(input) is required");
  }
  if (!capabilities.getActiveMemory) {
    errors.push("adapter.getActiveMemory(input) is required");
  }

  return {
    valid: errors.length === 0,
    name: typeof candidate?.name === "string" ? candidate.name : null,
    capabilities,
    errors,
  };
}

function expectString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
  }
}

export async function probeMemoryStoreAdapter(
  adapter: MemoryStoreAdapter,
  input: AdapterScopeInput,
): Promise<AdapterProbeResult> {
  const errors: string[] = [];
  const [sources, activeMemories] = await Promise.all([
    adapter.listSourceEvidence({ scope: input.scope, limit: input.limit ?? 3 }),
    adapter.listActiveMemories({ scope: input.scope, limit: input.limit ?? 3 }),
  ]);

  if (!Array.isArray(sources)) {
    errors.push("listSourceEvidence(input) must return an array");
  } else {
    sources.forEach((source, index) => {
      expectString((source as Partial<SourceEvidence>).id, `sources[${index}].id`, errors);
      expectString((source as Partial<SourceEvidence>).text, `sources[${index}].text`, errors);
    });
  }

  if (!Array.isArray(activeMemories)) {
    errors.push("listActiveMemories(input) must return an array");
  } else {
    activeMemories.forEach((memory, index) => {
      const candidate = memory as Partial<ActiveMemory>;
      expectString(candidate.id, `activeMemories[${index}].id`, errors);
      expectString(candidate.body, `activeMemories[${index}].body`, errors);
      expectString(candidate.type, `activeMemories[${index}].type`, errors);
      expectString(candidate.scope, `activeMemories[${index}].scope`, errors);
      expectString(candidate.status, `activeMemories[${index}].status`, errors);
    });
  }

  return {
    probed: true,
    valid: errors.length === 0,
    sourceCount: Array.isArray(sources) ? sources.length : 0,
    activeMemoryCount: Array.isArray(activeMemories) ? activeMemories.length : 0,
    errors,
  };
}
