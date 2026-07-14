import assert from "node:assert/strict";
import test from "node:test";
import { createUiMetricStore } from "./performance-metrics.ts";

test("UI metric store retains bounded finite samples and current heap", () => {
  const metrics = createUiMetricStore(3);
  metrics.record("cameraFrameMs", 10);
  metrics.record("cameraFrameMs", 11);
  metrics.record("cameraFrameMs", Number.NaN);
  metrics.record("cameraFrameMs", 12);
  metrics.record("cameraFrameMs", 13);
  metrics.record("interactiveMs", 250);
  metrics.record("inspectionResponseMs", 8.5);
  metrics.setHeap(123_456);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.schemaVersion, "refinery.ui-performance.v1");
  assert.deepEqual(snapshot.cameraFrameMs, [11, 12, 13]);
  assert.deepEqual(snapshot.interactiveMs, [250]);
  assert.deepEqual(snapshot.inspectionResponseMs, [8.5]);
  assert.equal(snapshot.usedJsHeapBytes, 123_456);
  assert.equal(Object.isFrozen(snapshot), true);
});
