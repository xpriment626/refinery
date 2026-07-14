<script lang="ts">
  import { onMount, tick } from "svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import { GatewayApi } from "./api.ts";
  import { parseCapabilityFragment } from "./capability.ts";
  import { createUiMetricStore, type UiMetricName } from "./performance-metrics.ts";
  import type { GatewayEvent, GraphInspection, GraphSnapshot, GraphVisualizationDelta, ResponsibilityPlan } from "./types.ts";

  let api: GatewayApi | null = null;
  let snapshot = $state.raw<GraphSnapshot | null>(null);
  let graphDelta = $state.raw<GraphVisualizationDelta | null>(null);
  let inspection = $state<GraphInspection | null>(null);
  let plan = $state<ResponsibilityPlan | null>(null);
  let selectedId = $state<string | null>(null);
  let query = $state("What memory is responsible for the current work?");
  let projectLabel = $state("Local project");
  let connected = $state(false);
  let loading = $state(true);
  let planning = $state(false);
  let error = $state<string | null>(null);
  let lastEvent = $state<GatewayEvent | null>(null);
  let retrieval = $state<{ candidateNodes: number; hydratedNodes: number; hydratedEdges: number } | null>(null);
  let graphCounts = $state({ nodes: 0, revisions: 0, edges: 0 });
  let graphTruncated = $state({ nodes: false, edges: false });
  let graphSyncedAt = $state<string | null>(null);
  let changeSequence = 0;
  let deltaRefreshRequested = false;
  let deltaRefreshPromise: Promise<void> | null = null;
  const uiMetrics = createUiMetricStore();
  let metricsOutput: HTMLOutputElement | null = null;
  let metricsFlushTimer: number | null = null;

  function flushMetrics(): void {
    if (!metricsOutput) return;
    metricsOutput.textContent = JSON.stringify(uiMetrics.snapshot());
  }

  function recordMetric(name: UiMetricName, milliseconds: number): void {
    uiMetrics.record(name, milliseconds);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    uiMetrics.setHeap(typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null);
    if (metricsFlushTimer !== null) window.clearTimeout(metricsFlushTimer);
    metricsFlushTimer = window.setTimeout(() => {
      metricsFlushTimer = null;
      flushMetrics();
    }, 200);
  }

  async function loadSnapshot(): Promise<void> {
    const currentApi = api;
    if (!currentApi) return;
    const loaded = await currentApi.snapshot();
    snapshot = loaded;
    graphDelta = null;
    graphCounts = loaded.counts;
    graphTruncated = loaded.truncated;
    graphSyncedAt = loaded.syncedAt;
    changeSequence = loaded.changeSequence;
  }

  function requestDeltaRefresh(): void {
    deltaRefreshRequested = true;
    if (deltaRefreshPromise) return;
    deltaRefreshPromise = (async () => {
      try {
        while (deltaRefreshRequested) {
          deltaRefreshRequested = false;
          if (graphTruncated.nodes) {
            await loadSnapshot();
            continue;
          }
          let hasMore = false;
          do {
            const currentApi = api;
            if (!currentApi) return;
            const next = await currentApi.delta(changeSequence);
            if (next.resetRequired) {
              await loadSnapshot();
              hasMore = false;
              break;
            }
            changeSequence = next.sequence;
            graphCounts = next.counts;
            graphSyncedAt = next.syncedAt;
            graphDelta = next;
            hasMore = next.hasMore;
            await tick();
          } while (hasMore);
          error = null;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        deltaRefreshPromise = null;
        if (deltaRefreshRequested) requestDeltaRefresh();
      }
    })();
  }

  async function selectNode(nodeId: string): Promise<void> {
    if (!api) return;
    const startedAt = performance.now();
    selectedId = nodeId;
    const selectionPainted = tick().then(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        recordMetric("selectionResponseMs", performance.now() - startedAt);
        resolve();
      });
    }));
    try {
      inspection = await api.inspect(nodeId);
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      recordMetric("inspectionResponseMs", performance.now() - startedAt);
      await selectionPainted;
    }
  }

  async function buildPlan(): Promise<void> {
    if (!api || !query.trim() || planning) return;
    planning = true;
    try {
      const result = await api.plan(query.trim());
      plan = result.plan;
      retrieval = result.retrieval;
      const seed = plan.seeds[0]?.nodeId;
      if (seed) await selectNode(seed);
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      planning = false;
    }
  }

  async function followEvents(signal: AbortSignal): Promise<void> {
    if (!api) return;
    let delay = 250;
    while (!signal.aborted) {
      try {
        await api.streamEvents((event) => {
          lastEvent = event;
          if (event.type === "graph-synced") requestDeltaRefresh();
        }, signal, () => {
          connected = true;
          delay = 250;
        });
        if (!signal.aborted) connected = false;
      } catch {
        if (signal.aborted) return;
        connected = false;
      }
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(4_000, delay * 2);
    }
  }

  onMount(() => {
    const controller = new AbortController();
    const longTaskObserver = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordMetric("longTaskMs", entry.duration);
    });
    try {
      longTaskObserver?.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
    } catch {
      longTaskObserver?.disconnect();
    }
    flushMetrics();
    void (async () => {
      try {
        const parsed = parseCapabilityFragment(window.location.hash);
        const capability = parsed.capability ?? window.sessionStorage.getItem("refinery.gateway.capability");
        if (parsed.capability) {
          window.sessionStorage.setItem("refinery.gateway.capability", parsed.capability);
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${parsed.sanitizedFragment}`);
        }
        if (!capability) throw new Error("Capability missing. Run `refinery ui url --json` and open the returned local URL.");
        const gatewayApi = new GatewayApi(capability);
        api = gatewayApi;
        const [health] = await Promise.all([gatewayApi.health(), loadSnapshot()]);
        projectLabel = health.project.label;
        connected = true;
        void followEvents(controller.signal);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        loading = false;
      }
    })();
    return () => {
      controller.abort();
      longTaskObserver?.disconnect();
      if (metricsFlushTimer !== null) window.clearTimeout(metricsFlushTimer);
    };
  });

  const formatter = new Intl.NumberFormat("en-US");
</script>

<svelte:head><title>{projectLabel} · Refinery</title></svelte:head>

<main class="workbench">
  <header class="masthead">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <div><strong>Refinery</strong><span>Responsibility map</span></div>
    </div>
    <div class="project-title"><span>Active assay</span><strong>{projectLabel}</strong></div>
    <div class:online={connected} class="connection"><span></span>{connected ? "Live" : "Reconnecting"}</div>
  </header>

  <aside class="control-rail" aria-label="Graph controls and status">
    <section class="assay-query">
      <p class="eyebrow">Retrieval assay</p>
      <h1>Ask what should wake.</h1>
      <form onsubmit={(event) => { event.preventDefault(); void buildPlan(); }}>
        <label for="query">Current responsibility</label>
        <textarea id="query" bind:value={query} rows="4" maxlength="20000"></textarea>
        <button type="submit" disabled={planning || !query.trim()}>{planning ? "Tracing…" : "Trace responsibility"}</button>
      </form>
    </section>

    <section class="measurements" aria-label="Graph measurements">
      <p class="eyebrow">Local index</p>
      <dl>
        <div><dt>Nodes</dt><dd>{formatter.format(graphCounts.nodes)}</dd></div>
        <div><dt>Edges</dt><dd>{formatter.format(graphCounts.edges)}</dd></div>
        <div><dt>Revisions</dt><dd>{formatter.format(graphCounts.revisions)}</dd></div>
      </dl>
      {#if graphTruncated.nodes || graphTruncated.edges}<p class="notice">Canvas is showing a bounded view.</p>{/if}
      {#if graphCounts.edges > 600}<p class="notice">Quiet view: 600 sampled context edges. A trace reveals exact responsibility paths.</p>{/if}
    </section>

    <section class="legend" aria-label="Responsibility state legend">
      <p class="eyebrow">Responsibility state</p>
      <ul>
        <li><span class="swatch awake"></span><div><strong>Awake</strong><small>Direct retrieval seed</small></div></li>
        <li><span class="swatch sleeping"></span><div><strong>Sleeping</strong><small>One hop, ready to wake</small></div></li>
        <li><span class="swatch deferred"></span><div><strong>Deferred</strong><small>Held outside this budget</small></div></li>
      </ul>
    </section>

    {#if retrieval}<p class="retrieval-note">{retrieval.candidateNodes} candidates → {retrieval.hydratedNodes} nodes / {retrieval.hydratedEdges} edges hydrated</p>{/if}
  </aside>

  <section class="graph-field" aria-busy={loading}>
    <div class="field-index top"><span>Scope / project + global</span><span>{graphSyncedAt ? new Date(graphSyncedAt).toLocaleString() : "Awaiting sync"}</span></div>
    <GraphCanvas {snapshot} delta={graphDelta} {plan} {selectedId} onSelect={(nodeId) => void selectNode(nodeId)} onMetric={recordMetric} />
    <div class="aperture-label" aria-hidden="true"><span></span>responsibility aperture</div>
    {#if loading}<div class="field-message"><strong>Opening local index</strong><span>Loading graph state from Refinery.</span></div>{/if}
    {#if !loading && !snapshot}<div class="field-message"><strong>No graph yet</strong><span>Run <code>refinery graph sync --json</code>, then return here.</span></div>{/if}
  </section>

  <aside class="evidence-drawer" aria-label="Selected graph evidence">
    <div class="drawer-heading"><p class="eyebrow">Evidence strip</p><span>{selectedId ? "Selected" : "Standby"}</span></div>
    {#if inspection}
      <article>
        <div class="kind-row"><span>{inspection.node.kind.replace("_", " ")}</span><span>{inspection.node.scope}</span></div>
        <h2>{inspection.node.label}</h2>
        <p class="revision-id">{inspection.revision.id}</p>
        <div class="evidence-copy">{inspection.revision.content}</div>
        {#if inspection.revision.contentTruncated}<p class="notice">Revision preview is capped at 50,000 characters. Use the CLI for the complete local record.</p>{/if}
        <dl class="edge-counts">
          <div><dt>Incoming</dt><dd>{inspection.incomingEdges.length}{inspection.truncated.incomingEdges ? "+" : ""}</dd></div>
          <div><dt>Outgoing</dt><dd>{inspection.outgoingEdges.length}{inspection.truncated.outgoingEdges ? "+" : ""}</dd></div>
        </dl>
      </article>
    {:else}
      <div class="drawer-empty"><span class="empty-glyph">⌁</span><strong>Select a node</strong><p>Inspect its current revision, scope, and provenance without mutating memory.</p></div>
    {/if}
    {#if plan}
      <section class="plan-units">
        <p class="eyebrow">Responsibility units</p>
        <ul>{#each plan.responsibilityUnits.slice(0, 12) as unit}<li><button type="button" disabled={!unit.nodeIds[0]} onclick={() => { const nodeId = unit.nodeIds[0]; if (nodeId) void selectNode(nodeId); }}><span class={`unit-dot ${unit.state}`}></span><div><strong>{unit.label}</strong><small>{unit.kind} · {unit.state}</small></div></button></li>{/each}</ul>
      </section>
    {/if}
  </aside>

  <footer class="event-strip">
    <span>Read-only observability</span>
    <span>{lastEvent ? `${lastEvent.type} · ${new Date(lastEvent.occurredAt).toLocaleTimeString()}` : "Waiting for graph activity"}</span>
    <span>libSQL · loopback</span>
  </footer>

  {#if error}<div class="error-banner" role="alert"><strong>Refinery needs attention</strong><span>{error}</span></div>{/if}
  <output bind:this={metricsOutput} data-testid="refinery-performance-metrics" hidden aria-hidden="true"></output>
</main>
