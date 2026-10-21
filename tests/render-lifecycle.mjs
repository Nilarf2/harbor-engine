import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { browserLaunchOptions, observeGraphics, graphicsEvidence } from './browser-gpu.mjs';

// A fresh, isolated browser visits only a temporary page on this loopback server.
// Software rendering checks ownership and correctness, not player GPU performance.
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(root, 'tests/artifacts');
await mkdir(artifacts, { recursive: true });
const server = await createServer({ root, appType: 'custom', server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false }, logLevel: 'silent' });
let browser;
const errors = [], blockedRequests = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 2 });
  await observeGraphics(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== port) { blockedRequests.push(url.href); return route.abort(); }
    if (url.pathname === '/demo/main.ts' || url.pathname === '/@vite/client') { errors.push(`Unexpected application module: ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>' });
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  assert.deepEqual(await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, demo: '__HARBOR__' in window })), { canvases: 0, demo: false });
  const result = await page.evaluate(async () => {
    const { createWorld } = await import('/src/core/index.ts');
    const { createBrowserRenderer } = await import('/src/render/index.ts');
    const { createGame } = await import('/src/browser/index.ts');
    const { createRapierPlugin } = await import('/src/physics/index.ts');
    const canvas = () => {
      const value = document.createElement('canvas');
      value.width = 160; value.height = 120; value.style.width = '160px'; value.style.height = '120px';
      document.body.append(value); return value;
    };
    const scene = { version: 1, name: 'Lifecycle probe', entities: [
      { id: 'ordinary', visual: { shape: 'box', size: [1, 1, 1], color: '#c0b090' } },
      { id: 'batch', position: [2, 0, 0], visual: { shape: 'box', size: [1, 1, 1], color: '#c0b090', batch: true } },
    ] };
    const cycles = [];
    let RendererConstructor;
    for (const backend of ['webgl', 'auto']) {
      const world = createWorld({ ...scene, entities: scene.entities.map(entity => ({ ...entity,
        body: { type: 'fixed', shape: 'box', size: [1, 1, 1] },
      })) });
      world.install(await createRapierPlugin());
      const listenerCount = () => [...world.events.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
      const physicsListeners = listenerCount();
      const view = await createBrowserRenderer({ canvas: canvas(), world, backend, quality: 'low' });
      RendererConstructor = view.renderer.constructor;
      view.camera.position.set(5, 4, 9); view.camera.lookAt(0, 0, 0); view.render();
      const sample = () => ({ ...view.inspect(), renderObjects: view.renderer._objects._renderObjects.size });
      const baseline = sample(), samples = [];
      const ordinary = view.getObject('ordinary'), batch = view.getObject('batch');
      let batchDisposals = 0;
      batch.addEventListener('dispose', () => batchDisposals++);
      world.command({ type: 'physics:teleport', id: 'ordinary', position: [1, 1, 0] });
      view.render();
      const ordinaryTeleport = { ordinaryPreserved: view.getObject('ordinary') === ordinary,
        batchPreserved: view.getObject('batch') === batch, position: ordinary.position.toArray(),
        batchDisposals, stats: sample() };
      // Cross a static batch cell boundary. Its uploaded transform and culling bounds
      // must follow the physics command even though ordinary transforms need no rebuild.
      world.command({ type: 'physics:teleport', id: 'batch', position: [-1, .5, 0] });
      view.render();
      const movedBatch = view.getObject('batch');
      const batchTeleport = { batchRebuilt: movedBatch !== batch, batchDisposals,
        position: Array.from(movedBatch.instanceMatrix.array.slice(12, 15)),
        bounds: [movedBatch.boundingBox.min.toArray(), movedBatch.boundingBox.max.toArray()],
        entityId: view.getEntityId(movedBatch, 0), stats: sample() };
      for (let i = 0; i < 20; i++) {
        world.spawn({ id: `temporary-${i}`, position: [-2, 0, 0], visual: { shape: 'box', size: [1, 1, 1], color: '#c0b090', batch: i % 2 === 0 } });
        view.render();
        world.remove(`temporary-${i}`); view.render(); samples.push(sample());
      }
      view.dispose(); view.dispose();
      const listenersAfter = listenerCount() - physicsListeners;
      world.dispose(); cycles.push({ backend, baseline, samples, listenersAfter, ordinaryTeleport, batchTeleport });
    }
    const originalInit = RendererConstructor.prototype.init, originalDispose = RendererConstructor.prototype.dispose;
    let initialized = 0, disposed = 0;
    RendererConstructor.prototype.init = function (...args) { initialized++; return originalInit.apply(this, args); };
    RendererConstructor.prototype.dispose = function (...args) { disposed++; return originalDispose.apply(this, args); };
    let upfront, rollback;
    try {
      const world = createWorld(scene), target = canvas();
      let message;
      try { await createBrowserRenderer({ canvas: target, world, quality: 'bogus' }); } catch (error) { message = error.message; }
      upfront = { message, initialized, disposed, unusedCanvas: !!target.getContext('2d') };
      Object.defineProperty(world.get('ordinary').visual, 'size', { get() { throw new Error('injected resource failure'); } });
      const failedCanvas = canvas();
      try { await createBrowserRenderer({ canvas: failedCanvas, world, quality: 'low', backend: 'webgl' }); } catch (error) { message = error.message; }
      rollback = { message, initialized, disposed, listeners: world.events.listeners.size, contextReleased: failedCanvas.getContext('webgl2').isContextLost() };
      world.dispose();
    } finally {
      RendererConstructor.prototype.init = originalInit; RendererConstructor.prototype.dispose = originalDispose;
    }
    const bareCanvas = () => {
      const value = document.createElement('canvas'); value.width = 64; value.height = 32;
      document.body.append(value); return value;
    };
    const invalidCanvas = bareCanvas();
    let validationMessage;
    try { await createGame({ canvas: invalidCanvas, scene: { version: 1, name: '', entities: [] }, autoStart: false }); }
    catch (error) { validationMessage = error.message; }
    const validationCleanup = { message: validationMessage, widthStyle: invalidCanvas.style.width, heightStyle: invalidCanvas.style.height,
      width: invalidCanvas.width, height: invalidCanvas.height, unusedCanvas: !!invalidCanvas.getContext('2d') };
    invalidCanvas.remove();
    const facadeCycles = [];
    for (let i = 0; i < 3; i++) {
      // A new canvas is required after Three deliberately releases its WebGL context.
      const target = bareCanvas();
      const game = await createGame({ canvas: target, scene, backend: 'webgl', quality: 'medium', autoStart: false });
      const dimensions = () => [target.clientWidth, target.clientHeight, target.width, target.height];
      const initial = dimensions();
      await new Promise(resolve => setTimeout(resolve, 150));
      const settled = dimensions(); game.start();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      game.pause(); game.step(1);
      const beforeDispose = { dimensions: dimensions(), tick: game.world.tick, running: game.running };
      game.dispose(); game.dispose();
      facadeCycles.push({ initial, settled, beforeDispose, listenersAfter: game.world.events.listeners.size,
        stylesAfter: [target.style.width, target.style.height], runningAfter: game.running });
      target.remove();
    }
    // A display:none canvas must retain stylesheet dimensions when it is revealed.
    const responsiveStyle = document.createElement('style');
    responsiveStyle.textContent = '#hidden-responsive { width:100vw; height:100dvh; display:none; }';
    document.head.append(responsiveStyle);
    const responsiveCanvas = document.createElement('canvas'); responsiveCanvas.id = 'hidden-responsive';
    document.body.append(responsiveCanvas);
    const responsiveGame = await createGame({ canvas: responsiveCanvas, scene, backend: 'webgl', quality: 'low', autoStart: false });
    const hiddenResponsive = { styles: [responsiveCanvas.style.width, responsiveCanvas.style.height] };
    responsiveCanvas.style.display = 'block'; responsiveGame.resize(); responsiveGame.step(0);
    await new Promise(resolve => setTimeout(resolve, 150));
    hiddenResponsive.visible = [responsiveCanvas.clientWidth, responsiveCanvas.clientHeight, responsiveCanvas.width, responsiveCanvas.height];
    responsiveGame.dispose(); responsiveCanvas.remove(); responsiveStyle.remove();
    return { cycles, upfront, rollback, devicePixelRatio, validationCleanup, facadeCycles, hiddenResponsive };
  });
  for (const cycle of result.cycles) {
    assert.equal(cycle.listenersAfter, 0);
    assert.equal(cycle.ordinaryTeleport.ordinaryPreserved, true, `${cycle.backend}: ordinary teleport rebuilt its mesh`);
    assert.equal(cycle.ordinaryTeleport.batchPreserved, true, `${cycle.backend}: ordinary teleport rebuilt static batches`);
    assert.deepEqual(cycle.ordinaryTeleport.position, [1, 1, 0]);
    assert.equal(cycle.ordinaryTeleport.batchDisposals, 0);
    assert.equal(cycle.batchTeleport.batchRebuilt, true);
    assert.equal(cycle.batchTeleport.batchDisposals, 1);
    assert.deepEqual(cycle.batchTeleport.position, [-1, .5, 0]);
    assert.deepEqual(cycle.batchTeleport.bounds, [[-1.5, 0, -.5], [-.5, 1, .5]]);
    assert.equal(cycle.batchTeleport.entityId, 'batch');
    for (const state of [cycle.ordinaryTeleport, cycle.batchTeleport]) {
      for (const key of ['geometries', 'textures', 'cachedGeometries', 'cachedMaterials', 'objects', 'batches', 'renderObjects']) {
        assert.equal(state.stats[key], cycle.baseline[key], `${cycle.backend}: ${key} changed after teleport`);
      }
    }
    for (const sample of cycle.samples) {
      for (const key of ['geometries', 'textures', 'cachedGeometries', 'cachedMaterials', 'objects', 'batches', 'renderObjects']) {
        assert.equal(sample[key], cycle.baseline[key], `${cycle.backend}: ${key} grew across spawn/remove`);
      }
    }
  }
  assert.equal(result.upfront.initialized, 0); assert.equal(result.upfront.disposed, 0); assert.equal(result.upfront.unusedCanvas, true);
  assert.match(result.upfront.message, /Unknown quality/);
  assert.equal(result.rollback.initialized, 1); assert.equal(result.rollback.disposed, 1); assert.equal(result.rollback.listeners, 0);
  assert.equal(result.rollback.contextReleased, true); assert.match(result.rollback.message, /injected resource failure/);
  assert.equal(result.devicePixelRatio, 2);
  assert.match(result.validationCleanup.message, /scene.name/);
  assert.deepEqual(result.validationCleanup, { message: result.validationCleanup.message, widthStyle: '', heightStyle: '', width: 64, height: 32, unusedCanvas: true });
  for (const cycle of result.facadeCycles) {
    assert.deepEqual(cycle.initial, [64, 32, 96, 48]);
    assert.deepEqual(cycle.settled, cycle.initial); assert.deepEqual(cycle.beforeDispose.dimensions, cycle.initial);
    assert.ok(cycle.beforeDispose.tick >= 1); assert.equal(cycle.beforeDispose.running, false);
    assert.deepEqual(cycle.stylesAfter, ['', '']); assert.equal(cycle.listenersAfter, 0); assert.equal(cycle.runningAfter, false);
  }
  assert.deepEqual(result.hiddenResponsive.styles, ['', '']);
  assert.deepEqual(result.hiddenResponsive.visible, [320, 240, 320, 240]);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await writeFile(resolve(artifacts, 'render-lifecycle-result.json'), JSON.stringify({ ok: true, browser: browser.version(), gpuMode: process.env.HARBOR_GPU_MODE || 'software', graphics: await graphicsEvidence(page), checks: 95, ...result }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: 95, cycles: result.cycles.map(c => ({ backend: c.backend, baseline: c.baseline, final: c.samples.at(-1) })), upfront: result.upfront, rollback: result.rollback, facadeCycles: result.facadeCycles, validationCleanup: result.validationCleanup, hiddenResponsive: result.hiddenResponsive }));
} catch (error) {
  await writeFile(resolve(artifacts, 'render-lifecycle-result.json'), JSON.stringify({ ok: false, failure: String(error), browser: browser?.version(), gpuMode: process.env.HARBOR_GPU_MODE || 'software', graphics: error.evidence, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  try { await browser?.close(); } finally { await server.close(); }
}
