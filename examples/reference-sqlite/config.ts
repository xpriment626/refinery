import {
  expandHome,
  resolveRefineryPaths,
  type ResolveRefineryPathsOptions,
} from "../../src/core/instance.ts";

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

export function resolvePaths(options: ResolveRefineryPathsOptions = {}): RefineryPaths {
  // Default instance home: <caller cwd>/.refinery. This keeps packaged CLI
  // installs from writing inside the npm package directory.
  const paths = resolveRefineryPaths(options);

  return {
    home: paths.home,
    dbPath: paths.dbPath,
    rawDir: paths.rawDir,
  };
}
export { expandHome };
