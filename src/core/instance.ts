import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RefineryInstancePaths {
  home: string;
  dbPath: string;
  rawDir: string;
  trialsDir: string;
}

export interface ResolveRefineryPathsOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface InitRefineryInstanceOptions extends ResolveRefineryPathsOptions {
  from?: string;
  reset?: boolean;
}

export interface InitRefineryInstanceResult {
  command: "instance init";
  home: string;
  dbPath: string;
  rawDir: string;
  trialsDir: string;
  importedFrom: string | null;
  archivedExistingHome: string | null;
  copied: {
    db: boolean;
    dbSidecars: number;
    rawFiles: number;
  };
  trialsFresh: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveRefineryPaths(
  options: ResolveRefineryPathsOptions = {},
): RefineryInstancePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeInput = options.home ?? env.REFINERY_HOME ?? path.join(cwd, ".refinery");
  const home = path.resolve(expandHome(homeInput));

  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
    trialsDir: path.join(home, "trials"),
  };
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function archiveHome(home: string): string {
  const parent = path.dirname(home);
  const base = path.basename(home);
  const stem = path.join(parent, `${base}.archive-${timestampForPath()}`);
  let candidate = stem;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${stem}-${suffix}`;
  }
  fs.renameSync(home, candidate);
  return candidate;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(child);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function copyDirectoryFiles(sourceDir: string, destDir: string): number {
  if (!fs.existsSync(sourceDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirectoryFiles(source, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, dest);
      copied += 1;
    }
  }
  return copied;
}

function copyDbFiles(sourceHome: string, destPaths: RefineryInstancePaths): {
  db: boolean;
  dbSidecars: number;
} {
  const sourceDb = path.join(sourceHome, "refinery.db");
  if (!fs.existsSync(sourceDb)) return { db: false, dbSidecars: 0 };

  fs.copyFileSync(sourceDb, destPaths.dbPath);
  let dbSidecars = 0;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${sourceDb}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${destPaths.dbPath}${suffix}`);
      dbSidecars += 1;
    }
  }
  return { db: true, dbSidecars };
}

export function initializeRefineryInstance(
  options: InitRefineryInstanceOptions = {},
): InitRefineryInstanceResult {
  const paths = resolveRefineryPaths(options);
  const sourceHome = options.from ? path.resolve(expandHome(options.from)) : null;
  if (sourceHome && sourceHome === paths.home) {
    throw new Error("instance init --from must point at a different Refinery home");
  }
  if (sourceHome && !fs.existsSync(sourceHome)) {
    throw new Error(`Source Refinery home not found: ${sourceHome}`);
  }

  let archivedExistingHome: string | null = null;
  if (fs.existsSync(paths.home) && options.reset) {
    archivedExistingHome = archiveHome(paths.home);
  }

  const sourceHasDb = sourceHome ? fs.existsSync(path.join(sourceHome, "refinery.db")) : false;
  if (sourceHasDb && fs.existsSync(paths.dbPath) && !options.reset) {
    throw new Error(
      `Refinery instance already has a database at ${paths.dbPath}. Re-run with --reset to archive it first.`,
    );
  }

  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.trialsDir, { recursive: true });

  let copiedDb = false;
  let dbSidecars = 0;
  let rawFiles = 0;
  if (sourceHome) {
    const dbCopy = copyDbFiles(sourceHome, paths);
    copiedDb = dbCopy.db;
    dbSidecars = dbCopy.dbSidecars;
    rawFiles = copyDirectoryFiles(path.join(sourceHome, "raw"), paths.rawDir);
  }

  return {
    command: "instance init",
    home: paths.home,
    dbPath: paths.dbPath,
    rawDir: paths.rawDir,
    trialsDir: paths.trialsDir,
    importedFrom: sourceHome,
    archivedExistingHome,
    copied: {
      db: copiedDb,
      dbSidecars,
      rawFiles,
    },
    trialsFresh: countFiles(paths.trialsDir) === 0,
  };
}
