import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listCodexActiveMemories, listCodexMemorySourceDocuments, resolveCodexMemoryHome, } from "../sources/codex-memories.js";
import { RefineryError } from "./errors.js";
import { readSourceCorpusIsolated } from "./source-reader.js";
import { reviewPacketSchemaVersion, sourceSpecKinds, targetSurfaces, } from "./types.js";
const DEFAULT_SOURCE_LIMIT = 3;
const DEFAULT_SOURCE_CHAR_LIMIT = 6000;
const DEFAULT_DOCUMENT_CHAR_LIMIT = 8000;
const DEFAULT_ACTIVE_MEMORY_LIMIT = 50;
const LOADABLE_FILE_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
function hashId(prefix, parts) {
    const hash = crypto.createHash("sha256");
    for (const part of parts)
        hash.update(part).update("\0");
    return `${prefix}:${hash.digest("hex").slice(0, 16)}`;
}
function compactText(text, max) {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max)
        return compact;
    return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
function parseParams(rawParams) {
    if (!rawParams)
        return {};
    const params = new URLSearchParams(rawParams);
    return Object.fromEntries(Array.from(params.entries()).filter(([key]) => key.trim()));
}
export function parseSourceSpec(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new RefineryError("INVALID_SOURCE_SPEC", "--source must not be empty.", { phase: "args" });
    }
    const queryIndex = trimmed.indexOf("?");
    const head = queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
    const params = parseParams(queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : undefined);
    if (head === "codex:memories" || head === "codex:sessions" || head === "codex:skills") {
        return { raw: trimmed, kind: head, value: null, params };
    }
    if (head.startsWith("file:")) {
        return { raw: trimmed, kind: "file", value: head.slice("file:".length), params };
    }
    if (head.startsWith("glob:")) {
        return { raw: trimmed, kind: "glob", value: head.slice("glob:".length), params };
    }
    throw new RefineryError("INVALID_SOURCE_SPEC", `Unsupported source spec: ${raw}. Use one of ${sourceSpecKinds.join(", ")}.`, { phase: "args", details: { source: raw } });
}
export function parseSourceSpecs(values, fallback = ["codex:memories"]) {
    const rawValues = Array.isArray(values)
        ? values.filter((value) => typeof value === "string")
        : typeof values === "string"
            ? [values]
            : fallback;
    return rawValues.map(parseSourceSpec);
}
export function parseTargetSurface(raw) {
    const trimmed = raw.trim();
    if (targetSurfaces.includes(trimmed))
        return trimmed;
    throw new RefineryError("INVALID_TARGET", `Unsupported target surface: ${raw}. Use one of ${targetSurfaces.join(", ")}.`, { phase: "args", details: { target: raw } });
}
export function parseTargetSurfaces(values, fallback = ["codex:memories"]) {
    const rawValues = Array.isArray(values)
        ? values.filter((value) => typeof value === "string")
        : typeof values === "string"
            ? [values]
            : fallback;
    const parsed = rawValues.map(parseTargetSurface);
    return Array.from(new Set(parsed));
}
function sourceSetFor(spec, index, role, metadata = {}) {
    return {
        id: hashId("source-set", [String(index), spec.raw]),
        spec,
        label: spec.raw,
        role,
        metadata,
    };
}
function sourceDocument(args) {
    const text = compactText(args.text, args.maxChars);
    return {
        id: hashId("source-doc", [args.sourceSet, args.uri, args.text]),
        sourceSet: args.sourceSet,
        role: args.role,
        uri: args.uri,
        text,
        metadata: {
            ...(args.metadata ?? {}),
            sourceTextChars: args.text.length,
            selectedTextChars: text.length,
            truncated: text.length < args.text.replace(/\s+/g, " ").trim().length,
        },
    };
}
function sourceRefs(doc) {
    return [{
            source_id: doc.id,
            source_set: doc.sourceSet,
            source_uri: doc.uri,
            role: doc.role,
        }];
}
export function toSourceChunks(documents, charLimit) {
    let remaining = charLimit;
    return documents
        .map((doc) => {
        const text = compactText(doc.text, Math.max(0, remaining));
        remaining -= text.length;
        return {
            id: doc.id,
            sourceSet: doc.sourceSet,
            role: doc.role,
            uri: doc.uri,
            text,
            refs: sourceRefs(doc),
            metadata: doc.metadata,
        };
    })
        .filter((chunk) => chunk.text.length > 0);
}
export function activeMemoryHints(memories, limit) {
    return memories.slice(0, limit).map((memory) => ({
        id: memory.id,
        type: memory.type,
        scope: memory.scope,
        body: compactText(memory.body, 360),
        provenance: memory.provenance ?? null,
    }));
}
function limitItems(items, limit) {
    return items.slice(0, Math.max(1, limit));
}
async function loadCodexMemories(spec, index, context) {
    const memoryHome = resolveCodexMemoryHome(spec.params.home ?? context.memoryHome);
    const root = spec.params.root ? path.resolve(spec.params.root) : null;
    const withinRoot = (candidate) => {
        if (!root || typeof candidate !== "string")
            return false;
        const relative = path.relative(root, path.resolve(candidate));
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    };
    const sourceSet = sourceSetFor(spec, index, "codex-memories", root
        ? { rootPathHash: hashId("path", [root]), filteredRecords: true }
        : { memoryHome });
    if (root) {
        const matchingMemories = listCodexActiveMemories({ memoryHome })
            .filter((memory) => memory.scope === "project" && withinRoot(memory.provenance?.projectPath));
        const activeMemories = limitItems(matchingMemories, context.limits.activeMemoryLimit);
        const selected = limitItems(matchingMemories, context.limits.sourceLimit);
        return {
            sourceSet,
            activeMemories,
            warnings: [],
            documents: selected.map((memory) => sourceDocument({
                sourceSet: sourceSet.id,
                role: "codex-memory-record",
                uri: `codex-memory-record://${encodeURIComponent(memory.id)}`,
                text: memory.body,
                metadata: {
                    memoryId: memory.id,
                    memoryType: memory.type,
                    scope: memory.scope,
                    ...(memory.provenance ?? {}),
                },
                maxChars: context.limits.documentCharLimit,
            })),
        };
    }
    const sources = listCodexMemorySourceDocuments({
        memoryHome,
        limit: context.limits.sourceLimit,
        maxChars: context.limits.documentCharLimit,
    });
    const activeMemories = listCodexActiveMemories({ memoryHome, limit: context.limits.activeMemoryLimit });
    return {
        sourceSet,
        activeMemories,
        warnings: [],
        documents: sources.map((source) => sourceDocument({
            sourceSet: sourceSet.id,
            role: source.role,
            uri: pathToFileURL(source.absPath).href,
            text: source.text,
            metadata: {
                ...(source.metadata ?? {}),
                refs: source.refs ?? [],
            },
            maxChars: context.limits.documentCharLimit,
        })),
    };
}
function walkFiles(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...walkFiles(abs));
        else if (entry.isFile())
            out.push(abs);
    }
    return out.sort();
}
function findSkillFiles(roots) {
    const files = roots.flatMap((root) => walkFiles(root).filter((file) => path.basename(file) === "SKILL.md"));
    return files
        .filter((file) => !file.includes(`${path.sep}plugins${path.sep}cache${path.sep}`))
        .sort((left, right) => {
        const leftDot = left.split(path.sep).some((part) => part.startsWith("."));
        const rightDot = right.split(path.sep).some((part) => part.startsWith("."));
        if (leftDot !== rightDot)
            return leftDot ? 1 : -1;
        return left.localeCompare(right);
    });
}
function defaultSkillRoots() {
    return resolveCodexSkillRoots();
}
async function loadCodexSkills(spec, index, context) {
    const roots = spec.params.home ? spec.params.home.split(",").map((root) => path.resolve(root)) : defaultSkillRoots();
    const sourceSet = sourceSetFor(spec, index, "codex-skills", {
        roots,
        pluginCacheIncluded: false,
    });
    const files = limitItems(findSkillFiles(roots), context.limits.sourceLimit);
    return {
        sourceSet,
        activeMemories: [],
        warnings: [],
        documents: files.map((file) => sourceDocument({
            sourceSet: sourceSet.id,
            role: "codex-skill",
            uri: pathToFileURL(file).href,
            text: fs.readFileSync(file, "utf8"),
            metadata: {
                path: file,
                skillName: path.basename(path.dirname(file)),
            },
            maxChars: context.limits.documentCharLimit,
        })),
    };
}
function resolveFileSpecPath(spec) {
    if (!spec.value) {
        throw new RefineryError("INVALID_SOURCE_SPEC", "file/glob source specs require a path.", { phase: "args" });
    }
    return path.resolve(spec.value);
}
function loadTextFile(filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new RefineryError("SOURCE_NOT_FOUND", `Source file not found: ${filePath}`, {
            phase: "source",
            details: { filePath },
        });
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!LOADABLE_FILE_EXTENSIONS.has(ext)) {
        throw new RefineryError("SOURCE_UNSUPPORTED_FILE", `Source file extension is not supported: ${filePath}`, {
            phase: "source",
            details: { filePath, supported: Array.from(LOADABLE_FILE_EXTENSIONS) },
        });
    }
    return fs.readFileSync(filePath, "utf8");
}
async function loadFileSource(spec, index, context) {
    const filePath = resolveFileSpecPath(spec);
    const sourceSet = sourceSetFor(spec, index, "file", { path: filePath });
    return {
        sourceSet,
        activeMemories: [],
        warnings: [],
        documents: [sourceDocument({
                sourceSet: sourceSet.id,
                role: `file-${path.extname(filePath).replace(".", "") || "text"}`,
                uri: pathToFileURL(filePath).href,
                text: loadTextFile(filePath),
                metadata: {
                    path: filePath,
                    size: fs.statSync(filePath).size,
                },
                maxChars: context.limits.documentCharLimit,
            })],
    };
}
function globRoot(pattern) {
    const wildcard = pattern.search(/[*?[\]]/);
    if (wildcard < 0)
        return path.dirname(pattern);
    const prefix = pattern.slice(0, wildcard);
    const slash = prefix.lastIndexOf(path.sep);
    return slash > 0 ? prefix.slice(0, slash) : path.parse(pattern).root;
}
function escapeRegex(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globToRegex(pattern) {
    const normalized = pattern.split(path.sep).join("/");
    let out = "^";
    for (let i = 0; i < normalized.length; i += 1) {
        const char = normalized[i];
        const next = normalized[i + 1];
        if (char === "*" && next === "*") {
            out += ".*";
            i += 1;
        }
        else if (char === "*") {
            out += "[^/]*";
        }
        else if (char === "?") {
            out += "[^/]";
        }
        else {
            out += escapeRegex(char);
        }
    }
    out += "$";
    return new RegExp(out);
}
async function loadGlobSource(spec, index, context) {
    const pattern = resolveFileSpecPath(spec);
    const root = globRoot(pattern);
    const sourceSet = sourceSetFor(spec, index, "glob", { pattern, root });
    if (!fs.existsSync(root)) {
        return { sourceSet, documents: [], activeMemories: [], warnings: [`Glob root not found: ${root}`] };
    }
    const matcher = globToRegex(pattern);
    const files = walkFiles(root)
        .filter((file) => LOADABLE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()))
        .filter((file) => matcher.test(file.split(path.sep).join("/")));
    return {
        sourceSet,
        activeMemories: [],
        warnings: [],
        documents: limitItems(files, context.limits.sourceLimit).map((file) => sourceDocument({
            sourceSet: sourceSet.id,
            role: `file-${path.extname(file).replace(".", "") || "text"}`,
            uri: pathToFileURL(file).href,
            text: loadTextFile(file),
            metadata: {
                path: file,
                size: fs.statSync(file).size,
            },
            maxChars: context.limits.documentCharLimit,
        })),
    };
}
async function loadSourceSet(spec, index, context) {
    switch (spec.kind) {
        case "codex:memories":
            return loadCodexMemories(spec, index, context);
        case "codex:sessions":
            throw new RefineryError("SESSION_CATALOGUE_COORDINATOR_REQUIRED", "Codex sessions must be loaded through the incremental catalogue coordinator.", { phase: "source-reader" });
        case "codex:skills":
            return loadCodexSkills(spec, index, context);
        case "file":
            return loadFileSource(spec, index, context);
        case "glob":
            return loadGlobSource(spec, index, context);
    }
}
function uniqueActiveMemories(memories) {
    const byId = new Map();
    for (const memory of memories)
        if (!byId.has(memory.id))
            byId.set(memory.id, memory);
    return Array.from(byId.values());
}
export async function buildReviewPacket(options) {
    const limits = {
        sourceLimit: Math.max(1, Math.min(options.sourceLimit ?? DEFAULT_SOURCE_LIMIT, 50)),
        sourceCharLimit: Math.max(500, Math.min(options.sourceCharLimit ?? DEFAULT_SOURCE_CHAR_LIMIT, 60_000)),
        documentCharLimit: Math.max(500, Math.min(options.documentCharLimit ?? DEFAULT_DOCUMENT_CHAR_LIMIT, 24_000)),
        activeMemoryLimit: Math.max(1, Math.min(options.activeMemoryLimit ?? DEFAULT_ACTIVE_MEMORY_LIMIT, 200)),
    };
    const isolated = await readSourceCorpusIsolated({
        sourceSpecs: options.sourceSpecs,
        project: options.project,
        scope: options.scope,
        home: options.home,
        memoryHome: options.memoryHome,
        limits,
        now: options.now,
    });
    const corpus = isolated.corpus;
    const { sourceSets, documents, activeMemories } = corpus;
    const derivedViews = {
        source_chunks: toSourceChunks(documents, limits.sourceCharLimit),
        active_memory_hints: activeMemoryHints(activeMemories, limits.activeMemoryLimit),
    };
    return {
        schemaVersion: reviewPacketSchemaVersion,
        type: "refinery-review-packet",
        sourceSets,
        documents,
        targets: options.targets,
        objective: {
            intent: options.intent,
            request: options.request,
            project: options.project,
            scope: options.scope,
        },
        limits,
        derivedViews,
        counts: {
            sourceSets: sourceSets.length,
            documents: documents.length,
            activeMemoryHints: derivedViews.active_memory_hints.length,
            sourceChunks: derivedViews.source_chunks.length,
        },
        warnings: corpus.warnings,
        sourceIsolation: {
            processSeparated: isolated.isolation.processSeparated,
            permissionModel: isolated.isolation.permissionModel,
        },
    };
}
export async function loadSourceCorpus(options) {
    const context = {
        project: options.project,
        scope: options.scope,
        memoryHome: options.memoryHome,
        limits: options.limits,
        now: options.now ?? new Date(),
    };
    const loaded = await Promise.all(options.sourceSpecs.map((spec, index) => loadSourceSet(spec, options.sourceIndexes?.[index] ?? index, context)));
    return {
        sourceSets: loaded.map((set) => set.sourceSet),
        documents: loaded.flatMap((set) => set.documents),
        activeMemories: uniqueActiveMemories(loaded.flatMap((set) => set.activeMemories)),
        warnings: loaded.flatMap((set) => set.warnings),
    };
}
export async function inspectSources(options) {
    const packet = await buildReviewPacket({
        ...options,
        targets: ["codex:memories"],
        intent: "source-inspect",
        request: null,
    });
    return {
        ok: true,
        command: "sources inspect",
        sources: packet.sourceSets.map((sourceSet) => {
            const documents = packet.documents.filter((doc) => doc.sourceSet === sourceSet.id);
            return {
                id: sourceSet.id,
                spec: sourceSet.spec,
                label: sourceSet.label,
                role: sourceSet.role,
                counts: {
                    documents: documents.length,
                    activeMemories: sourceSet.spec.kind === "codex:memories" ? packet.counts.activeMemoryHints : 0,
                },
                sampleDocuments: documents.slice(0, 5).map((doc) => ({
                    id: doc.id,
                    role: doc.role,
                    uri: doc.uri,
                    textChars: doc.text.length,
                    metadata: doc.metadata,
                })),
                metadata: sourceSet.metadata,
            };
        }),
        counts: {
            sourceSets: packet.counts.sourceSets,
            documents: packet.counts.documents,
            activeMemories: packet.counts.activeMemoryHints,
        },
        warnings: packet.warnings,
    };
}
import { resolveCodexSkillRoots } from "./codex-paths.js";
//# sourceMappingURL=packets.js.map