import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Map a project working directory to its Claude Code project-history directory.
 *
 * Claude Code encodes the absolute working-directory path into the project
 * folder name by replacing path separators and dots with '-'. We DERIVE this
 * from the working directory at runtime — the encoded path is never hardcoded,
 * so the import works from any Fabrick-like working directory.
 */
export function encodeProjectPath(rootAbs: string): string {
  return rootAbs.replace(/[/.]/g, "-");
}

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function resolveClaudeProjectDir(rootAbs: string): string {
  return path.join(claudeProjectsRoot(), encodeProjectPath(rootAbs));
}

export interface DiscoveredSource {
  kind: "claude-code-session" | "claude-memory-legacy";
  sourcePath: string;
  sessionId: string | null;
}

/** Top-level *.jsonl session transcripts (UUID subdirs are tool-result sidecars). */
export function discoverSessions(claudeProjectDir: string): DiscoveredSource[] {
  if (!fs.existsSync(claudeProjectDir)) return [];
  return fs
    .readdirSync(claudeProjectDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => ({
      kind: "claude-code-session" as const,
      sourcePath: path.join(claudeProjectDir, e.name),
      sessionId: path.basename(e.name, ".jsonl"),
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

/** Legacy memory/*.md files imported as active legacy memories. */
export function discoverLegacyMemory(claudeProjectDir: string): DiscoveredSource[] {
  const memDir = path.join(claudeProjectDir, "memory");
  if (!fs.existsSync(memDir)) return [];
  return fs
    .readdirSync(memDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => ({
      kind: "claude-memory-legacy" as const,
      sourcePath: path.join(memDir, e.name),
      sessionId: null,
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}
