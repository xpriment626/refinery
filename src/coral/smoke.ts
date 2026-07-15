import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  allMessages,
  buildCoralSessionRequest,
  classifyAgentReadiness,
  closeSession,
  createSession,
  evaluatePingPong,
  getExtended,
  getLocalAgent,
  inspectCoralRuntimeCapabilities,
  pollPingPong,
  puppetCreateThread,
  puppetSendMessage,
  waitForAgentsReady,
  type ExtendedState,
  type CoralMessage,
  type SessionIdentifier,
  type CoralRuntimeCapabilities,
} from "./client.ts";
import {
  refineryCoralAgentNames,
  refineryCoralAuthKey,
  refineryCoralConfigPath,
  refineryCoralModelDefaults,
  refineryCoralPort,
} from "./definitions.ts";
import { resolveRefineryPaths } from "../core/paths.ts";
import { coralRuntimeLauncherPath } from "./runtime.ts";
import { cleanupRuntimeCoralConfigPath, resolveRuntimeCoralConfigPath } from "./review-conductor.ts";

interface SmokeArgs {
  apiUrl: string;
  authKey: string;
  configPath: string;
  namespace: string;
  runId: string;
  outputDir: string;
  startServer: boolean;
  coralRuntimeLauncher: string;
  timeoutMs: number;
}

interface SmokeArtifact {
  schemaVersion: "refinery.coral-smoke.v1";
  status: "running" | "passed" | "failed";
  startedAt: string;
  completedAt?: string;
  runId: string;
  apiUrl: string;
  authKeyPresent: boolean;
  configPath: string;
  outputDir: string;
  startServer: boolean;
  session: SessionIdentifier | null;
  threadId: string | null;
  sequence: string[];
  registry: Array<{ agentName: string; ok: boolean; error?: string }>;
  runtimeCapabilities: CoralRuntimeCapabilities | null;
  readinessSnapshots: Array<{ at: string; agents: Array<{ name: string; readiness: string; status: unknown }> }>;
  finalSnapshot: ExtendedState | null;
  messages: unknown[];
  evaluation: unknown;
  errors: string[];
  serverLogExcerpt: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function parseArgs(argv: string[]): SmokeArgs {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const runId = read("--run-id") ?? `coral-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return {
    apiUrl: read("--api-url") ?? `http://localhost:${refineryCoralPort}`,
    authKey: read("--auth-key") ?? refineryCoralAuthKey,
    configPath: read("--config") ?? refineryCoralConfigPath,
    namespace: read("--namespace") ?? `refinery-${runId}`,
    runId,
    outputDir: read("--output-dir") ?? path.join(resolveRefineryPaths({ cwd: repoRoot }).runsDir, runId),
    startServer: has("--start-server"),
    coralRuntimeLauncher: read("--coral-runtime-launcher") ?? coralRuntimeLauncherPath({ cwd: repoRoot }),
    timeoutMs: Number.parseInt(read("--timeout-ms") ?? "180000", 10),
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendLogLines(store: string[], prefix: string, chunk: Buffer): void {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    store.push(`[${prefix}] ${line}`);
  }
  while (store.length > 500) store.shift();
}

async function isServerReady(apiUrl: string, authKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/registry`, {
      headers: { Authorization: `Bearer ${authKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(apiUrl: string, authKey: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReady(apiUrl, authKey)) return true;
    await sleep(1_000);
  }
  return false;
}

function startCoralServer(args: SmokeArgs, logs: string[]): ChildProcessWithoutNullStreams {
  const configAbs = path.resolve(repoRoot, args.configPath);
  if (!fs.existsSync(args.coralRuntimeLauncher)) {
    throw new Error("Pinned Coral runtime is not provisioned. Run refinery setup provision coral --confirm --json.");
  }
  const child = spawn(process.execPath, [args.coralRuntimeLauncher, "server", "start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CONFIG_FILE_PATH: configAbs,
      REFINERY_NODE_BIN: process.execPath,
      PATH: process.env.PATH,
    },
  });
  child.stdout.on("data", (chunk: Buffer) => appendLogLines(logs, "coral:stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendLogLines(logs, "coral:stderr", chunk));
  child.on("exit", (code, signal) => logs.push(`[coral:exit] code=${code ?? "null"} signal=${signal ?? "null"}`));
  return child;
}

async function stopStartedServer(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function recordReadinessSnapshot(artifact: SmokeArtifact, snapshot: ExtendedState): void {
  artifact.readinessSnapshots.push({
    at: new Date().toISOString(),
    agents: snapshot.agents
      .filter((agent) => refineryCoralAgentNames.includes(agent.name))
      .map((agent) => ({
        name: agent.name,
        readiness: classifyAgentReadiness(agent),
        status: agent.status ?? null,
      })),
  });
  if (artifact.readinessSnapshots.length > 80) artifact.readinessSnapshots.shift();
}

async function runSmoke(args: SmokeArgs): Promise<SmokeArtifact> {
  const outputDir = path.resolve(repoRoot, args.outputDir);
  const logs: string[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;
  let session: SessionIdentifier | null = null;
  let generatedConfigPath: string | null = null;
  const runtimeConfigPath = args.startServer && args.configPath === refineryCoralConfigPath
    ? resolveRuntimeCoralConfigPath(refineryCoralConfigPath, { port: refineryCoralPort, authKey: args.authKey })
    : args.configPath;
  if (runtimeConfigPath !== args.configPath) generatedConfigPath = runtimeConfigPath;
  const artifact: SmokeArtifact = {
    schemaVersion: "refinery.coral-smoke.v1",
    status: "running",
    startedAt: new Date().toISOString(),
    runId: args.runId,
    apiUrl: args.apiUrl,
    authKeyPresent: Boolean(args.authKey),
    configPath: path.resolve(repoRoot, runtimeConfigPath),
    outputDir,
    startServer: args.startServer,
    session: null,
    threadId: null,
    sequence: [
      "refinery-memory-cartographer",
      "refinery-proposal-editor",
      "refinery-decision-synthesizer",
      "refinery-evidence-auditor",
      "refinery-claim-scout",
    ],
    registry: [],
    runtimeCapabilities: null,
    readinessSnapshots: [],
    finalSnapshot: null,
    messages: [],
    evaluation: null,
    errors: [],
    serverLogExcerpt: logs,
  };

  const artifactPath = path.join(outputDir, "coral-smoke.json");
  const serverLogPath = path.join(outputDir, "server.log");
  writeJson(artifactPath, artifact);

  try {
    if (args.startServer && !(await isServerReady(args.apiUrl, args.authKey))) {
      child = startCoralServer({ ...args, configPath: runtimeConfigPath }, logs);
    }
    const serverReady = await waitForServer(args.apiUrl, args.authKey, 60_000);
    if (!serverReady) throw new Error(`Coral server was not reachable at ${args.apiUrl} with the configured auth key.`);
    artifact.runtimeCapabilities = await inspectCoralRuntimeCapabilities(args.apiUrl);

    for (const agentName of refineryCoralAgentNames) {
      try {
        await getLocalAgent({ apiUrl: args.apiUrl, authKey: args.authKey }, agentName);
        artifact.registry.push({ agentName, ok: true });
      } catch (error) {
        artifact.registry.push({ agentName, ok: false, error: (error as Error).message });
        throw new Error(`Coral registry missing ${agentName}: ${(error as Error).message}`);
      }
    }

    session = await createSession(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      buildCoralSessionRequest({
        namespace: args.namespace,
        runId: args.runId,
        modelName: process.env.MODEL_NAME ?? process.env.REFINERY_MODEL_NAME ?? refineryCoralModelDefaults.modelName,
        modelBaseUrl: process.env.MODEL_BASE_URL ?? process.env.REFINERY_MODEL_BASE_URL ?? refineryCoralModelDefaults.baseUrl,
        reasoningEffort: process.env.REASONING_EFFORT ?? refineryCoralModelDefaults.reasoningEffort,
        maxTurns: process.env.REFINERY_CORAL_MAX_TURNS ?? "1",
      }),
    );
    artifact.session = session;
    writeJson(artifactPath, artifact);

    const ready = await waitForAgentsReady(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      session,
      refineryCoralAgentNames,
      (snapshot) => recordReadinessSnapshot(artifact, snapshot),
      { timeoutMs: 90_000, intervalMs: 1_500 },
    );
    if (!ready.ok) {
      throw new Error(`Agents did not reach readiness. stopped=${ready.stopped.join(",") || "none"}`);
    }

    const thread = await puppetCreateThread(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      session,
      "refinery-claim-scout",
      {
        threadName: `Refinery ping-pong ${args.runId}`,
        participantNames: refineryCoralAgentNames,
      },
    );
    artifact.threadId = thread.thread.id;

    await puppetSendMessage(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      session,
      "refinery-claim-scout",
      {
        threadId: thread.thread.id,
        content: JSON.stringify({
          type: "refinery-ping",
          runId: args.runId,
          sequence: artifact.sequence,
          index: 0,
          agent: "refinery-claim-scout",
          nextAgent: artifact.sequence[0],
        }),
        mentions: [artifact.sequence[0]],
      },
    );

    const result = await pollPingPong(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      session,
      thread.thread.id,
      args.runId,
      artifact.sequence,
      (snapshot) => recordReadinessSnapshot(artifact, snapshot),
      { timeoutMs: args.timeoutMs, intervalMs: 1_500 },
    );
    artifact.finalSnapshot = result.snapshot;
    artifact.messages = result.snapshot ? allMessages(result.snapshot).filter((message) => message.threadId === thread.thread.id) : [];
    artifact.evaluation = result.evaluation;
    if (!result.evaluation.ok) {
      throw new Error(
        `Ping-pong incomplete. missingResponses=${result.evaluation.missingResponses.join(",") || "none"} missingMentions=${
          result.evaluation.missingMentions.join(",") || "none"
        }`,
      );
    }

    artifact.status = "passed";
    return artifact;
  } catch (error) {
    artifact.status = "failed";
    artifact.errors.push((error as Error).message);
    if (session) {
      try {
          artifact.finalSnapshot = await getExtended({ apiUrl: args.apiUrl, authKey: args.authKey }, session);
        if (artifact.threadId) {
          const messages: CoralMessage[] = allMessages(artifact.finalSnapshot).filter((message) => message.threadId === artifact.threadId);
          artifact.messages = messages;
          artifact.evaluation = evaluatePingPong(messages, artifact.threadId, args.runId, artifact.sequence);
        }
      } catch (snapshotError) {
        artifact.errors.push(`final snapshot failed: ${(snapshotError as Error).message}`);
      }
    }
    return artifact;
  } finally {
    artifact.completedAt = new Date().toISOString();
    artifact.serverLogExcerpt = logs.slice(-200);
    if (session) await closeSession({ apiUrl: args.apiUrl, authKey: args.authKey }, session);
    await stopStartedServer(child);
    if (generatedConfigPath) cleanupRuntimeCoralConfigPath(generatedConfigPath);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(serverLogPath, `${logs.join("\n")}\n`);
    writeJson(artifactPath, artifact);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifact = await runSmoke(args);
  console.log(`coral smoke ${artifact.status}: ${path.join(artifact.outputDir, "coral-smoke.json")}`);
  if (artifact.session) console.log(`session=${artifact.session.namespace}/${artifact.session.sessionId}`);
  if (artifact.threadId) console.log(`thread=${artifact.threadId}`);
  if (artifact.status !== "passed") {
    for (const error of artifact.errors) console.error(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exit(1);
});
