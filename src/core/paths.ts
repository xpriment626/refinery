import os from "node:os";
import path from "node:path";

export interface RefineryPaths {
  home: string;
  trialsDir: string;
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

export function resolveRefineryPaths(options: ResolveRefineryPathsOptions = {}): RefineryPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeInput = options.home ?? env.REFINERY_HOME ?? path.join(cwd, ".refinery");
  const home = path.resolve(expandHome(homeInput));
  return {
    home,
    trialsDir: path.join(home, "trials"),
  };
}
