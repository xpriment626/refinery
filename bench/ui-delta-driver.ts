import path from "node:path";
import { performance } from "node:perf_hooks";
import { LibsqlGraphStore } from "../src/core/graph/libsql-store.ts";
import { resolveRefineryPaths } from "../src/core/paths.ts";
import { notifyGatewayGraphSync } from "../src/gateway/lifecycle.ts";
import { createDeterministicGraphFixture, createDeterministicGraphMutation } from "./graph-fixture.ts";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(option(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const project = path.resolve(requiredOption("project"));
const home = path.resolve(requiredOption("home"));
const nodes = positiveInteger("nodes", 25_000);
const edges = positiveInteger("edges", 100_000);
const iterations = positiveInteger("iterations", 30);
const delayMs = positiveInteger("delay-ms", 350);
const base = createDeterministicGraphFixture({ nodes, edges, project });
const mutation = createDeterministicGraphMutation(base, { updatedNodes: 500, createdEdges: 2_000 });
const paths = resolveRefineryPaths({ home, cwd: project });
const store = new LibsqlGraphStore(paths.graphIndexPath, { legacyJsonPath: paths.legacyGraphIndexPath });
let current = store.read();
if (!current || current.nodes.length !== nodes || ![edges, edges + 2_000].includes(current.edges.length)) {
  store.close();
  throw new Error(`Expected an existing ${nodes}-node graph with ${edges} or ${edges + 2_000} edges`);
}

const writeMs: number[] = [];
let notifications = 0;
try {
  for (let index = 0; index < iterations; index += 1) {
    const next = current.edges.length === edges ? mutation : base;
    const startedAt = performance.now();
    store.write(next, current);
    writeMs.push(performance.now() - startedAt);
    current = next;
    if (await notifyGatewayGraphSync({
      home,
      project,
      payload: { syncedAt: next.syncedAt, changed: { nodes: 500, edges: 2_000 } },
    })) notifications += 1;
    await sleep(delayMs);
  }
} finally {
  store.close();
}

process.stdout.write(`${JSON.stringify({
  ok: notifications === iterations,
  schemaVersion: "refinery.ui-delta-driver.v1",
  iterations,
  notifications,
  mutation: { updatedNodes: 500, changedEdges: 2_000 },
  writeMs: writeMs.map((value) => Number(value.toFixed(3))),
}, null, 2)}\n`);
