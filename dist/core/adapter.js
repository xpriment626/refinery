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
];
export const memoryProposalLifecycleStates = [
    "proposed",
    "needs_review",
    "accepted",
    "rejected",
    "deferred",
    "applied_externally",
    "superseded",
    "archived_for_audit",
];
export const refineryReviewSchemaVersion = "refinery.review.v1";
function isFunction(value) {
    return typeof value === "function";
}
export function validateMemoryStoreAdapter(adapter) {
    const candidate = adapter;
    const errors = [];
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
function expectString(value, path, errors) {
    if (typeof value !== "string" || !value.trim()) {
        errors.push(`${path} must be a non-empty string`);
    }
}
export async function probeMemoryStoreAdapter(adapter, input) {
    const errors = [];
    const [sources, activeMemories] = await Promise.all([
        adapter.listSourceEvidence({ scope: input.scope, limit: input.limit ?? 3 }),
        adapter.listActiveMemories({ scope: input.scope, limit: input.limit ?? 3 }),
    ]);
    if (!Array.isArray(sources)) {
        errors.push("listSourceEvidence(input) must return an array");
    }
    else {
        sources.forEach((source, index) => {
            expectString(source.id, `sources[${index}].id`, errors);
            expectString(source.text, `sources[${index}].text`, errors);
        });
    }
    if (!Array.isArray(activeMemories)) {
        errors.push("listActiveMemories(input) must return an array");
    }
    else {
        activeMemories.forEach((memory, index) => {
            const candidate = memory;
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
//# sourceMappingURL=adapter.js.map