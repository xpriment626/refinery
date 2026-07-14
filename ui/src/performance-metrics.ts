export const uiMetricNames = [
  "interactiveMs",
  "renderDurationMs",
  "cameraFrameMs",
  "hoverResponseMs",
  "selectionResponseMs",
  "inspectionResponseMs",
  "deltaApplyMs",
  "longTaskMs",
] as const;

export type UiMetricName = (typeof uiMetricNames)[number];

export interface UiPerformanceSnapshot extends Record<UiMetricName, number[]> {
  schemaVersion: "refinery.ui-performance.v1";
  usedJsHeapBytes: number | null;
}

export interface UiMetricStore {
  record(name: UiMetricName, milliseconds: number): void;
  setHeap(bytes: number | null): void;
  snapshot(): Readonly<UiPerformanceSnapshot>;
}

export function createUiMetricStore(maxSamples = 120): UiMetricStore {
  const limit = Math.max(1, Math.min(1_000, Math.floor(maxSamples)));
  const samples = Object.fromEntries(uiMetricNames.map((name) => [name, [] as number[]])) as Record<UiMetricName, number[]>;
  let usedJsHeapBytes: number | null = null;
  return {
    record(name, milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
      const values = samples[name];
      values.push(Number(milliseconds.toFixed(3)));
      if (values.length > limit) values.splice(0, values.length - limit);
    },
    setHeap(bytes) {
      usedJsHeapBytes = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: "refinery.ui-performance.v1" as const,
        ...Object.fromEntries(uiMetricNames.map((name) => [name, Object.freeze([...samples[name]])])),
        usedJsHeapBytes,
      }) as Readonly<UiPerformanceSnapshot>;
    },
  };
}
