<script lang="ts">
  import { onMount } from "svelte";
  import Graph from "graphology";
  import Sigma from "sigma";
  import FA2Layout from "graphology-layout-forceatlas2/worker";
  import { sampleContextEdgeIds } from "./graph-presentation.ts";
  import type { UiMetricName } from "./performance-metrics.ts";
  import { positionForTerritoryNode, summarizeTerritories } from "./territory-map.ts";
  import type { GraphSnapshot, GraphVisualizationDelta, ResponsibilityPlan, VisualEdge, VisualNode } from "./types.ts";

  interface Props {
    snapshot: GraphSnapshot | null;
    delta: GraphVisualizationDelta | null;
    plan: ResponsibilityPlan | null;
    selectedId: string | null;
    onSelect: (nodeId: string) => void;
    onMetric: (name: UiMetricName, milliseconds: number) => void;
  }

  let { snapshot, delta, plan, selectedId, onSelect, onMetric }: Props = $props();
  let container: HTMLDivElement;
  const graph = new Graph();
  let renderer: Sigma | null = null;
  let layout: FA2Layout | null = null;
  let layoutTimer: number | null = null;
  let deltaFrame: number | null = null;
  let lastSnapshot: GraphSnapshot | null = null;
  let lastDeltaSequence = 0;
  let previousSelectedId: string | null = null;
  let presentedPlanNodeIds = new Set<string>();
  let presentedPlanEdgeIds = new Set<string>();
  let contextEdgeIds = new Set<string>();
  let pendingDeltas: GraphVisualizationDelta[] = [];
  let renderStartedAt = 0;
  let firstGraphRender = true;
  let cameraActiveUntil = 0;
  let lastCameraFrameAt: number | null = null;
  let hoverStartedAt: number | null = null;
  let overviewMode = $state(false);

  const CONTEXT_EDGE_LIMIT = 600;
  const palette = {
    memory: "#1d3857",
    session: "#5d8a72",
    skill: "#765886",
    source_document: "#65717d",
    evidence: "#9a744d",
    project: "#2e465a",
    awake: "#315cff",
    sleeping: "#e58c45",
    deferred: "#7f8a92",
    edge: "rgba(78, 94, 106, 0.20)",
    activeEdge: "#315cff",
  } as const;

  const territorySummary = $derived(summarizeTerritories(snapshot?.nodes ?? []));
  const largestTerritory = $derived(Math.max(1, ...territorySummary.map((territory) => territory.count)));

  function baseNodeAttributes(node: VisualNode): Record<string, unknown> {
    const baseColor = palette[node.kind];
    return {
      label: node.label,
      color: baseColor,
      baseColor,
      size: 4,
      zIndex: 1,
      highlighted: false,
      kind: node.kind,
    };
  }

  function mergeNodeAttributesIfChanged(nodeId: string, attributes: Record<string, unknown>): void {
    const current = graph.getNodeAttributes(nodeId);
    if (Object.entries(attributes).every(([key, value]) => Object.is(current[key], value))) return;
    graph.mergeNodeAttributes(nodeId, attributes);
  }

  function mergeEdgeAttributesIfChanged(edgeId: string, attributes: Record<string, unknown>): void {
    const current = graph.getEdgeAttributes(edgeId);
    if (Object.entries(attributes).every(([key, value]) => Object.is(current[key], value))) return;
    graph.mergeEdgeAttributes(edgeId, attributes);
  }

  function upsertNode(node: VisualNode): boolean {
    if (graph.hasNode(node.id)) {
      mergeNodeAttributesIfChanged(node.id, baseNodeAttributes(node));
      return false;
    }
    graph.addNode(node.id, { ...positionForTerritoryNode(node.id, node.kind), ...baseNodeAttributes(node) });
    return true;
  }

  function upsertEdge(edge: VisualEdge): boolean {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return false;
    const attributes = {
      color: palette.edge,
      size: 0.35 + edge.confidence * 0.35,
      type: "line",
      hidden: !contextEdgeIds.has(edge.id),
    };
    if (graph.hasEdge(edge.id)) {
      if (graph.source(edge.id) !== edge.source || graph.target(edge.id) !== edge.target) {
        graph.dropEdge(edge.id);
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, attributes);
        return true;
      }
      mergeEdgeAttributesIfChanged(edge.id, attributes);
      return false;
    }
    graph.addEdgeWithKey(edge.id, edge.source, edge.target, attributes);
    return true;
  }

  function resetNodePresentation(nodeId: string): void {
    if (!graph.hasNode(nodeId)) return;
    mergeNodeAttributesIfChanged(nodeId, {
      color: graph.getNodeAttribute(nodeId, "baseColor"),
      size: 4,
      zIndex: 1,
      highlighted: false,
    });
  }

  function applyPresentation(): void {
    for (const edge of plan?.traversedEdges ?? []) upsertEdge(edge);
    for (const nodeId of presentedPlanNodeIds) resetNodePresentation(nodeId);
    if (previousSelectedId) resetNodePresentation(previousSelectedId);
    for (const edgeId of contextEdgeIds) {
      if (graph.hasEdge(edgeId)) mergeEdgeAttributesIfChanged(edgeId, { color: palette.edge, size: 0.5, hidden: Boolean(plan) });
    }
    for (const edgeId of presentedPlanEdgeIds) {
      if (graph.hasEdge(edgeId)) mergeEdgeAttributesIfChanged(edgeId, { color: palette.edge, size: 0.5, hidden: Boolean(plan) || !contextEdgeIds.has(edgeId) });
    }

    const nextPlanNodeIds = new Set<string>();
    const nextPlanEdgeIds = new Set<string>();
    for (const selected of plan?.selectedNodes ?? []) {
      if (!graph.hasNode(selected.nodeId)) continue;
      const state = selected.seed ? "awake" : selected.depth === 1 ? "sleeping" : "deferred";
      nextPlanNodeIds.add(selected.nodeId);
      mergeNodeAttributesIfChanged(selected.nodeId, {
        color: palette[state],
        size: state === "awake" ? 8 : state === "sleeping" ? 6 : 4.5,
        zIndex: state === "awake" ? 3 : state === "sleeping" ? 2 : 1,
      });
    }
    for (const edge of plan?.traversedEdges ?? []) {
      if (!graph.hasEdge(edge.id)) continue;
      nextPlanEdgeIds.add(edge.id);
      mergeEdgeAttributesIfChanged(edge.id, { color: palette.activeEdge, size: 1.35, hidden: false });
    }
    for (const edgeId of presentedPlanEdgeIds) {
      if (!nextPlanEdgeIds.has(edgeId) && !contextEdgeIds.has(edgeId) && graph.hasEdge(edgeId)) graph.dropEdge(edgeId);
    }
    if (selectedId && graph.hasNode(selectedId)) {
      mergeNodeAttributesIfChanged(selectedId, { size: 10, zIndex: 4, highlighted: true });
    }
    presentedPlanNodeIds = nextPlanNodeIds;
    presentedPlanEdgeIds = nextPlanEdgeIds;
    previousSelectedId = selectedId;
  }

  function syncSnapshot(current: GraphSnapshot): void {
    const nextContextEdgeIds = sampleContextEdgeIds(current.edges, CONTEXT_EDGE_LIMIT);
    const nextEdges = new Set(nextContextEdgeIds);
    const nextNodes = new Set(current.nodes.map((node) => node.id));
    graph.forEachEdge((edge) => { if (!nextEdges.has(edge)) graph.dropEdge(edge); });
    graph.forEachNode((node) => { if (!nextNodes.has(node)) graph.dropNode(node); });
    for (const node of current.nodes) upsertNode(node);
    contextEdgeIds = nextContextEdgeIds;
    for (const edge of current.edges) if (contextEdgeIds.has(edge.id)) upsertEdge(edge);
    applyPresentation();
    renderer?.refresh();
    lastSnapshot = current;
    lastDeltaSequence = current.changeSequence;
  }

  function applyDeltaBatch(batch: GraphVisualizationDelta[]): void {
    const startedAt = performance.now();
    let topologyChanged = false;
    for (const current of batch) {
      for (const edgeId of current.removedEdgeIds) {
        contextEdgeIds.delete(edgeId);
        if (graph.hasEdge(edgeId)) {
          graph.dropEdge(edgeId);
          topologyChanged = true;
        }
      }
      for (const nodeId of current.removedNodeIds) {
        if (graph.hasNode(nodeId)) {
          graph.dropNode(nodeId);
          topologyChanged = true;
        }
      }
      for (const node of current.nodes) topologyChanged = upsertNode(node) || topologyChanged;
      for (const edge of current.edges) {
        const alreadyMaterialized = graph.hasEdge(edge.id);
        const active = presentedPlanEdgeIds.has(edge.id);
        if (!alreadyMaterialized && !active && contextEdgeIds.size < CONTEXT_EDGE_LIMIT) contextEdgeIds.add(edge.id);
        if (alreadyMaterialized || active || contextEdgeIds.has(edge.id)) topologyChanged = upsertEdge(edge) || topologyChanged;
      }
      lastDeltaSequence = current.sequence;
    }
    applyPresentation();
    // Graphology events already schedule Sigma's partial node/edge refreshes.
    // A full refresh here re-indexes every visible node for each small delta.
    renderer?.scheduleRender();
    void topologyChanged;
    onMetric("deltaApplyMs", performance.now() - startedAt);
  }

  function queueDelta(current: GraphVisualizationDelta): void {
    if (current.sequence <= lastDeltaSequence) return;
    pendingDeltas.push(current);
    if (deltaFrame !== null) return;
    deltaFrame = window.requestAnimationFrame(() => {
      const batch = pendingDeltas;
      pendingDeltas = [];
      deltaFrame = null;
      applyDeltaBatch(batch);
    });
  }

  function restartLayout(): void {
    layout?.kill();
    if (layoutTimer !== null) window.clearTimeout(layoutTimer);
    if (graph.order < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    layout = new FA2Layout(graph, {
      settings: {
        barnesHutOptimize: graph.order > 1_000,
        gravity: 0.08,
        scalingRatio: graph.order > 5_000 ? 18 : 10,
        slowDown: 8,
        strongGravityMode: false,
      },
    });
    layout.start();
    layoutTimer = window.setTimeout(() => layout?.stop(), graph.order > 10_000 ? 2_500 : 1_500);
  }

  function responsibilityStateForKind(kind: VisualNode["kind"]): "awake" | "sleeping" | "deferred" | null {
    let state: "awake" | "sleeping" | "deferred" | null = null;
    for (const selected of plan?.selectedNodes ?? []) {
      if (selected.kind !== kind) continue;
      if (selected.seed) return "awake";
      if (selected.depth === 1) state = "sleeping";
      else if (!state) state = "deferred";
    }
    return state;
  }

  function territoryStyle(territory: (typeof territorySummary)[number]): string {
    const weight = 0.72 + territory.count / largestTerritory * 0.38;
    return `--territory-x:${territory.xPercent}%;--territory-y:${territory.yPercent}%;--territory-color:${territory.color};--territory-scale:${weight}`;
  }

  function setOverviewMode(next: boolean): void {
    if (!renderer || next === overviewMode) return;
    overviewMode = next;
    renderer.setSettings({
      nodeReducer: next ? () => ({ hidden: true }) : null,
      edgeReducer: next ? () => ({ hidden: true }) : null,
    });
  }

  function setCameraMode(mode: "territories" | "exact"): void {
    if (!renderer) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.getCamera().animate(
      { ratio: mode === "territories" ? 2.2 : 1 },
      { duration: reducedMotion ? 0 : 220 },
    );
  }

  onMount(() => {
    renderer = new Sigma(graph, container, {
      allowInvalidContainer: false,
      defaultEdgeColor: palette.edge,
      labelColor: { color: "#1b2430" },
      labelDensity: 0.08,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 7,
      minCameraRatio: 0.02,
      maxCameraRatio: 8,
      renderEdgeLabels: false,
      zIndex: true,
    });
    renderer.on("beforeRender", () => { renderStartedAt = performance.now(); });
    renderer.on("afterRender", () => {
      const now = performance.now();
      onMetric("renderDurationMs", now - renderStartedAt);
      if (firstGraphRender && graph.order > 0) {
        firstGraphRender = false;
        onMetric("interactiveMs", now);
      }
      if (now <= cameraActiveUntil) {
        if (lastCameraFrameAt !== null) {
          const frameInterval = now - lastCameraFrameAt;
          // A new wheel/gesture burst can begin while the prior 300 ms activity
          // window is still open. Do not misclassify the idle gap as a frame;
          // actual main-thread stalls remain visible through Long Tasks.
          if (frameInterval <= 50) onMetric("cameraFrameMs", frameInterval);
        }
        lastCameraFrameAt = now;
      }
      if (hoverStartedAt !== null) {
        onMetric("hoverResponseMs", now - hoverStartedAt);
        hoverStartedAt = null;
      }
    });
    renderer.getCamera().on("updated", () => {
      const now = performance.now();
      if (now > cameraActiveUntil) lastCameraFrameAt = null;
      cameraActiveUntil = now + 300;
      setOverviewMode(renderer!.getCamera().getState().ratio >= 1.8);
    });
    renderer.on("clickNode", ({ node }) => {
      onSelect(node);
    });
    renderer.on("enterNode", () => {
      hoverStartedAt = performance.now();
      container.style.cursor = "pointer";
    });
    renderer.on("leaveNode", () => { container.style.cursor = "grab"; });
    if (snapshot) {
      syncSnapshot(snapshot);
      restartLayout();
    }
    return () => {
      if (layoutTimer !== null) window.clearTimeout(layoutTimer);
      if (deltaFrame !== null) window.cancelAnimationFrame(deltaFrame);
      layout?.kill();
      renderer?.kill();
      graph.clear();
    };
  });

  $effect(() => {
    const current = snapshot;
    if (!renderer || !current || current === lastSnapshot) return;
    syncSnapshot(current);
    restartLayout();
  });

  $effect(() => {
    const current = delta;
    if (!renderer || !current) return;
    queueDelta(current);
  });

  $effect(() => {
    if (!renderer) return;
    selectedId;
    plan;
    applyPresentation();
    renderer.scheduleRender();
  });
</script>

<div class:overview-hidden={overviewMode} class="graph-stage" bind:this={container} aria-label="Interactive memory responsibility graph"></div>
<div class:visible={overviewMode} class="territory-overlay" aria-hidden={!overviewMode} aria-label="Graph territory overview">
  {#each territorySummary as territory}
    {#if territory.count > 0}
      {@const state = responsibilityStateForKind(territory.kind)}
      <div class="territory" class:awake={state === "awake"} class:sleeping={state === "sleeping"} style={territoryStyle(territory)}>
        <span>{territory.label}</span>
        <strong>{territory.count.toLocaleString()}</strong>
      </div>
    {/if}
  {/each}
  <p>Territory overview <span>Zoom in for exact nodes and paths</span></p>
</div>
<div class="view-controls" aria-label="Graph view">
  <button class:active={overviewMode} type="button" onclick={() => setCameraMode("territories")}>Territories</button>
  <button class:active={!overviewMode} type="button" onclick={() => setCameraMode("exact")}>Exact graph</button>
</div>
