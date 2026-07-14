import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface RefineryPaths {
  home: string;
  configDir: string;
  credentialsDir: string;
  runsRootDir: string;
  projectKey: string;
  runsDir: string;
  cataloguesDir: string;
  sessionCataloguePath: string;
  graphsDir: string;
  graphIndexPath: string;
  legacyGraphIndexPath: string;
  gatewayDir: string;
  gatewayStatePath: string;
  gatewayLogPath: string;
  uiConfigPath: string;
}

export interface ResolveRefineryPathsOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolvePathInput(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

export function projectKeyForPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const escapedSep = path.sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = resolved.replace(new RegExp(`${escapedSep}+`, "g"), path.sep);
  const slug = normalized
    .replace(/^[A-Za-z]:/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

export function resolveRefineryPaths(options: ResolveRefineryPathsOptions = {}): RefineryPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeInput = options.home ?? env.REFINERY_HOME ?? "~/.refinery";
  const home = resolvePathInput(homeInput, cwd);
  const runsRootDir = path.join(home, "runs");
  const projectKey = projectKeyForPath(cwd);
  const graphsDir = path.join(home, "graphs", "by-project", projectKey);
  const gatewayDir = path.join(home, "gateway");
  return {
    home,
    configDir: path.join(home, "config"),
    credentialsDir: path.join(home, "credentials"),
    runsRootDir,
    projectKey,
    runsDir: path.join(runsRootDir, "by-project", projectKey),
    cataloguesDir: path.join(home, "catalogues"),
    sessionCataloguePath: path.join(home, "catalogues", "codex-sessions.db"),
    graphsDir,
    graphIndexPath: path.join(graphsDir, "memory-graph.db"),
    legacyGraphIndexPath: path.join(graphsDir, "memory-graph.json"),
    gatewayDir,
    gatewayStatePath: path.join(gatewayDir, "state.json"),
    gatewayLogPath: path.join(gatewayDir, "gateway.jsonl"),
    uiConfigPath: path.join(home, "config", "ui.json"),
  };
}
