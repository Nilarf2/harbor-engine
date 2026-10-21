import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Scene, Texture } from 'three/webgpu';
import { StaticRefinementController, type StaticDenoiser } from '../src/pathtracing/static-refinement.js';
import type { PathTracingView } from '../src/pathtracing/native-view.js';

const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };
function fixture() {
  let revision = 1, min = 0, avg = 100; const raw = new Texture();
  const view = { get revision() { return revision; }, outputTexture: raw, preparedScene: new Scene(), camera: new PerspectiveCamera(),
    pathTracer: { maxSamples: 0 }, reset() { revision++; },
    async measureSamples() { return { min, avg, max: 300, samplesPerSecond: 1 }; },
  } as unknown as PathTracingView;
  return { view, raw, change() { revision++; }, counts(value: number, mean = 100) { min = value; avg = mean; } };
}

test('static refinement waits for all pixels, uses prepared guides, and invalidates results on every view revision', async () => {
  const f = fixture(), filtered = new Texture(); let runs = 0;
  const denoiser: StaticDenoiser = { reset() {}, dispose() {}, async denoise(frame) {
    runs++; assert.equal(frame.scene, f.view.preparedScene); assert.equal(frame.camera, f.view.camera); return filtered;
  } };
  const controller = new StaticRefinementController(f.view, denoiser);
  controller.start(); f.counts(63, 300); controller.tick(); await flush();
  assert.equal(runs, 0); assert.equal(controller.inspect().state, 'sampling'); assert.equal(controller.outputTexture, f.raw);
  f.counts(64); controller.tick(); await flush(); assert.equal(runs, 1); assert.equal(controller.outputTexture, filtered);
  for (const cause of ['camera', 'materials', 'lights', 'environment', 'skinning', 'resize']) {
    f.change(); assert.equal(controller.outputTexture, f.raw, cause); f.counts(0); controller.tick(); await flush();
    assert.equal(controller.inspect().state, 'sampling', cause);
    f.counts(64); controller.tick(); await flush(); assert.equal(controller.outputTexture, filtered, cause);
  }
  controller.cancel(); assert.equal(f.view.pathTracer.maxSamples, 0); assert.equal(controller.outputTexture, f.raw);
  await controller.dispose();
});

test('inference rejection preserves raw output and an explicit retry can complete at 256 minimum samples', async () => {
  const f = fixture(), filtered = new Texture(); let fail = true; const errors: string[] = [];
  const controller = new StaticRefinementController(f.view, {
    reset() {}, dispose() {}, async denoise() { if (fail) throw new Error('inference rejected'); return filtered; },
  }, error => errors.push(error.message));
  controller.start(); f.counts(64); controller.tick(); await flush();
  assert.equal(controller.inspect().state, 'error'); assert.equal(controller.outputTexture, f.raw); assert.deepEqual(errors, ['inference rejected']);
  fail = false; controller.start({ samples: 256 }); f.counts(255, 500); controller.tick(); await flush(); assert.equal(controller.inspect().state, 'sampling');
  f.counts(256); controller.tick(); await flush(); assert.equal(controller.outputTexture, filtered); await controller.dispose();
});

test('cancelled and stale asynchronous denoising never replace the current image', async () => {
  const f = fixture(); let finish!: (texture: Texture) => void; let aborted = false;
  const controller = new StaticRefinementController(f.view, { reset() {}, dispose() {}, denoise(frame) {
    frame.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(resolve => { finish = resolve; });
  } });
  controller.start(); f.counts(64); controller.tick(); await flush(); assert.equal(controller.inspect().state, 'denoising');
  controller.cancel(); assert.equal(aborted, true); finish(new Texture()); await flush();
  assert.equal(controller.outputTexture, f.raw); assert.equal(controller.inspect().state, 'idle'); await controller.dispose();
});
