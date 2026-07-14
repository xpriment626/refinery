import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  getMemoryGraphNeighbors,
  inspectMemoryGraphNode,
  planMemoryGraph,
} from "../src/core/graph/service.ts";
import { LibsqlGraphStore } from "../src/core/graph/libsql-store.ts";
import { createDeterministicGraphFixture, createDeterministicGraphMutation } from "./graph-fixture.ts";

const profiles = {
  small: { nodes: 1_000, edges: 4_000 },
  target: { nodes: 25_000, edges: 100_000 },
  stress: { nodes: 50_000, edges: 200_000 },
} as const;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: Number(sorted[0]!.toFixed(3)),
    medianMs: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
    rawMs: values.map((value) => Number(value.toFixed(3))),
  };
}

function measure(operation: () => void, warmup: number, iterations: number) {
  for (let index = 0; index < warmup; index += 1) operation();
  const values: number[] = [];
  const cpuStarted = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    values.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuStarted);
  return {
    ...summarize(values),
    cpu: {
      userMs: Number((cpu.user / 1_000).toFixed(3)),
      systemMs: Number((cpu.system / 1_000).toFixed(3)),
      totalMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
      totalPerSampleMs: Number(((cpu.user + cpu.system) / 1_000 / iterations).toFixed(3)),
    },
  };
}

const profileName = option("profile") ?? "small";
if (!(profileName in profiles)) throw new Error(`Unknown profile: ${profileName}`);
const profile = profiles[profileName as keyof typeof profiles];
const warmup = Math.max(0, Number(option("warmup") ?? 3));
const iterations = Math.max(1, Number(option("iterations") ?? 15));
const outputPath = option("output");
const label = option("label") ?? "unlabelled";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `refinery-graph-benchmark-${profileName}-`));
const databasePath = path.join(temporary, "memory-graph.db");
function seedDatabase(): {
  project: string;
  rootNodeId: string;
  fixtureWriteMs: number;
  mutationWriteMs: number;
  deltaAfterSequence: number;
} {
  const fixture = createDeterministicGraphFixture(profile);
  const store = new LibsqlGraphStore(databasePath);
  const writeStarted = performance.now();
  store.write(fixture, null);
  const fixtureWriteMs = performance.now() - writeStarted;
  const deltaAfterSequence = store.diagnostics().changeSequence;
  const mutation = createDeterministicGraphMutation(fixture, { updatedNodes: 500, createdEdges: 2_000 });
  const mutationStarted = performance.now();
  store.write(mutation, fixture);
  const mutationWriteMs = performance.now() - mutationStarted;
  store.close();
  return {
    project: fixture.project,
    rootNodeId: fixture.nodes[Math.min(17, fixture.nodes.length - 1)]!.id,
    fixtureWriteMs,
    mutationWriteMs,
    deltaAfterSequence,
  };
}

const setup = seedDatabase();
global.gc?.();

const metrics = {
  inspect: measure(() => {
    inspectMemoryGraphNode({ project: setup.project, graphPath: databasePath, nodeId: setup.rootNodeId });
  }, warmup, iterations),
  neighborhood: measure(() => {
    getMemoryGraphNeighbors({
      project: setup.project,
      graphPath: databasePath,
      nodeId: setup.rootNodeId,
      depth: 2,
      maxNodes: 100,
      maxEdges: 300,
    });
  }, warmup, iterations),
  responsibilityPlan: measure(() => {
    planMemoryGraph({
      graphPath: databasePath,
      project: setup.project,
      scope: "project",
      request: "topic-17 indexed traversal gateway observability",
      limits: { maxNodes: 24, maxEdges: 48, maxHops: 2, maxChars: 12_000, maxTokens: 3_000 },
      now: new Date("2026-07-11T12:00:00.000Z"),
    });
  }, warmup, iterations),
  visualizationDelta: measure(() => {
    const store = new LibsqlGraphStore(databasePath);
    const delta = store.readVisualizationDelta({
      afterSequence: setup.deltaAfterSequence,
      maxEvents: 10,
      maxNodeChanges: 5_000,
      maxEdgeChanges: 20_000,
    });
    store.close();
    if (delta.nodes.length !== 500 || delta.edges.length !== 2_000 || delta.resetRequired) {
      throw new Error(`visualization delta fixture mismatch: ${delta.nodes.length} nodes, ${delta.edges.length} edges`);
    }
  }, warmup, iterations),
};

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; dependencies?: Record<string, string> };
const result = {
  schemaVersion: "refinery.graph-benchmark.v1",
  label,
  measuredAt: new Date().toISOString(),
  profile: { name: profileName, ...profile },
  policy: { warmup, iterations, sequential: true, clock: "performance.now" },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    refineryVersion: packageJson.version,
    libsqlVersion: packageJson.dependencies?.libsql ?? "unknown",
  },
  setup: {
    fixtureWriteMs: Number(setup.fixtureWriteMs.toFixed(3)),
    mutationWriteMs: Number(setup.mutationWriteMs.toFixed(3)),
    mutation: { updatedNodes: 500, createdEdges: 2_000 },
    databaseBytes: fs.statSync(databasePath).size,
  },
  metrics,
  memory: (global.gc?.(), process.memoryUsage()),
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
