import path from "node:path";
import os from "node:os";

/**
 * Resolution of the local Refinery instance data location.
 *
 * Authority boundary (pattern-language §8): the relational DB is the canonical
 * record; the raw store holds immutable source evidence. Both live under one
 * instance home directory so the whole local instance is a single relocatable
 * unit. Override with REFINERY_HOME for tests or alternate instances.
 */
export interface RefineryPaths {
  home: string;
  dbPath: string;
  rawDir: string;
}

export function resolvePaths(): RefineryPaths {
  // Default instance home: <package-root>/.refinery (gitignored).
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const home = process.env.REFINERY_HOME
    ? path.resolve(process.env.REFINERY_HOME)
    : path.join(packageRoot, ".refinery");

  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

/** Expand a leading ~ to the user home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
