import test from 'node:test';
import assert from 'node:assert/strict';
import { completeFramePlan } from '../src/pathtracing/frame-plan.js';

test('complete-frame plans cover every pixel with upstream-compatible tiles within the dispatch budget', () => {
  for (const [width, height, budget] of [[1280, 720, 250000], [1920, 1080, 8192], [32, 24, 17], [127, 73, 31], [1, 19, 1], [29, 1, 3], [16, 12, 512]]) {
    const plan = completeFramePlan(width, height, budget);
    const upstreamTiles = Math.max(1, Math.ceil(width * height / plan.backendBudget));
    const columns = Math.ceil(Math.sqrt(upstreamTiles)), rows = Math.ceil(upstreamTiles / columns);
    assert.equal(plan.columns, columns); assert.equal(plan.rows, rows);
    assert.equal(plan.dispatches, columns * rows); assert.ok(plan.maxTilePixels <= budget);
    const coverage = new Uint8Array(width * height);
    for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
      for (let py = y * plan.tileHeight; py < Math.min((y + 1) * plan.tileHeight, height); py++) {
        for (let px = x * plan.tileWidth; px < Math.min((x + 1) * plan.tileWidth, width); px++) coverage[py * width + px]++;
      }
    }
    assert.ok(coverage.every(count => count === 1), `${width}x${height}/${budget}`);
  }
});

test('invalid or unbounded tile work fails before rendering', () => {
  assert.throws(() => completeFramePlan(0, 1, 1), /positive/);
  assert.throws(() => completeFramePlan(2, 2, NaN), /positive/);
  assert.throws(() => completeFramePlan(Number.MAX_SAFE_INTEGER, 2, 1), /safe integer range/);
  assert.throws(() => completeFramePlan(1_000_000, 1, 1), /too many/);
});
