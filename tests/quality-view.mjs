import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { browserLaunchOptions, observeGraphics, graphicsEvidence } from './browser-gpu.mjs';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), cacheDir: 'node_modules/.vite-quality-view',
  optimizeDeps: { include: ['three/webgpu', 'three/tsl', 'three-gpu-pathtracer', 'three-gpu-pathtracer/webgpu', 'oidn-web'] },
  plugins: [{ name: 'quality-view-modules', resolveId(id) { if (id === '/__quality-view.js') return id; }, load(id) {
    if (id === '/__quality-view.js') return `export * as THREE from 'three/webgpu'; export * from '/src/pathtracing/index.ts';`;
  } }], server: { host: '127.0.0.1', port: 5195, strictPort: true, hmr: false } });
server.middlewares.use('/__test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><link rel="icon" href="data:,"><body></body>'); });
await server.listen();
let browser;
const errors = [];
try {
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage(); await observeGraphics(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.text().startsWith('[quality-view]')) console.log(message.text()); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort(); });
  await page.goto('http://127.0.0.1:5195/__test');
  const result = await page.evaluate(async () => {
    const { THREE, createQualityDevice, createPathTracingView, createPathTracingOutputNode, createOIDNStaticDenoiser, StaticRefinementController, OIDN_LARGE_WEIGHTS } = await import('/__quality-view.js');
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const device = await createQualityDevice();
    const renderer = new THREE.WebGPURenderer({ canvas, device, antialias: false }); await renderer.init();
    renderer.setPixelRatio(1); renderer.setSize(32, 24, false); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    const storage = () => ({ count: renderer.info.memory.storageAttributes, bytes: renderer.info.memory.storageAttributesSize });
    const storageBaseline = storage(), storageChecks = [];
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#112233');
    const camera = new THREE.PerspectiveCamera(50, 32 / 24, .1, 100); camera.position.set(0, 0, 5);
    const top = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, .2), new THREE.MeshStandardMaterial({ color: '#ff0000', emissive: '#ff0000', emissiveIntensity: 2, roughness: 1 })); top.position.y = .95;
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, .2), new THREE.MeshStandardMaterial({ color: '#0000ff', emissive: '#0000ff', emissiveIntensity: 2, roughness: 1 })); bottom.position.y = -.95;
    scene.add(top, bottom);
    const originalSourceIndex = [...top.geometry.index.array]; const sentinel = {}; top.geometry.boundsTree = sentinel;
    let sourceDisposals = 0; top.geometry.addEventListener('dispose', () => sourceDisposals++); top.material.addEventListener('dispose', () => sourceDisposals++);
    const deadline = (promise, label, ms = 120000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), ms); })]).finally(() => clearTimeout(timer)); };
    let view, denoiser, refinement, guideTarget;
    const renderOriginal = renderer.render.bind(renderer);
    renderer.render = (...args) => { const target = renderer.getRenderTarget(); if (target?.textures?.some(texture => texture.name === 'normal')) guideTarget = target; return renderOriginal(...args); };
    const draw = async texture => {
      const target = new THREE.RenderTarget(32, 24, { type: THREE.FloatType });
      const output = createPathTracingOutputNode(texture);
      const material = new THREE.MeshBasicNodeMaterial({ colorNode: output.colorNode.rgb, toneMapped: false });
      const quad = new THREE.QuadMesh(material);
      try {
        const tone = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
        renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(null); renderer.toneMapping = tone;
        const values = await deadline(renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 24), 'HDR read');
        let nonfinite = 0, mean = 0, maximum = 0;
        for (let i = 0; i < values.length; i++) { if (!Number.isFinite(values[i])) nonfinite++; if (i % 4 !== 3) { mean += values[i]; maximum = Math.max(maximum, values[i]); } }
        const pixel = y => Array.from(values.slice((y * 32 + 16) * 4, (y * 32 + 16) * 4 + 3));
        return { mean: mean / (32 * 24 * 3), nonfinite, maximum, top: pixel(6), bottom: pixel(18) };
      } finally { renderer.setRenderTarget(null); target.dispose(); material.dispose(); quad.dispose(); }
    };
    try {
      console.log('[quality-view] creating native borrowed view');
      view = await createPathTracingView({ renderer, scene, camera, width: 32, height: 24, maxBounces: 2, frameBudget: 8192 });
      const initial = view.inspect();
      if (!view.outputTexture || view.outputTexture.width !== 32 || view.outputTexture.height !== 24) throw new Error('Raw HDR dimensions were not allocated');
      denoiser = createOIDNStaticDenoiser({ renderer, weightsUrl: '/oidn/' + OIDN_LARGE_WEIGHTS.file, maxTileSize: 32 });
      refinement = new StaticRefinementController(view, denoiser);
      refinement.start({ samples: 64 });
      console.log('[quality-view] accumulating 64 minimum samples');
      const started = performance.now();
      while (refinement.inspect().state !== 'complete' && refinement.inspect().state !== 'error') {
        view.render(); refinement.tick();
        await new Promise(resolve => setTimeout(resolve, 2));
        if (performance.now() - started > 180000) throw new Error('Static OIDN complete timeout: ' + JSON.stringify(refinement.inspect()));
      }
      if (refinement.inspect().state === 'error') throw new Error(refinement.inspect().error);
      console.log('[quality-view] OIDN completed');
      const raw = await draw(view.outputTexture), filtered = await draw(refinement.outputTexture), runtime = denoiser.inspect();
      const baselineTarget = new THREE.RenderTarget(32, 24, { type: THREE.FloatType });
      const baselineTone = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(baselineTarget); renderer.render(scene, camera); renderer.setRenderTarget(null); renderer.toneMapping = baselineTone;
      const baselineValues = await renderer.readRenderTargetPixelsAsync(baselineTarget, 0, 0, 32, 24);
      const baselinePixel = y => Array.from(baselineValues.slice((y * 32 + 16) * 4, (y * 32 + 16) * 4 + 3));
      const baseline = { top: baselinePixel(6), bottom: baselinePixel(18) }; baselineTarget.dispose();
      const settled = refinement.inspect();
      if (!guideTarget) throw new Error('Clean guide target was not rendered');
      const guideColor = await renderer.readRenderTargetPixelsAsync(guideTarget, 0, 0, 32, 24, 0, 0);
      const guideNormal = await renderer.readRenderTargetPixelsAsync(guideTarget, 0, 0, 32, 24, 1, 0);
      const decodeGuide = values => { const pixel = y => Array.from(values.slice((y * 32 + 16) * 4, (y * 32 + 16) * 4 + 3), value => values instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(value) : value); return { top: pixel(6), bottom: pixel(18) }; };
      const guides = { albedo: decodeGuide(guideColor), normal: decodeGuide(guideNormal) };
      const preservedPolicy = renderer.toneMapping === THREE.ACESFilmicToneMapping && renderer.toneMappingExposure === 1.1;
      top.position.x += .1; view.syncScene({ transforms: true }); const staleImmediatelyRaw = refinement.outputTexture === view.outputTexture;
      refinement.tick(); await new Promise(resolve => setTimeout(resolve, 0)); const resetState = refinement.inspect().state;
      await refinement.dispose(); refinement = undefined; denoiser = undefined;
      // Dispose while a real sample mapAsync is pending, then reuse the renderer.
      view.render(); const pending = view.measureSamples(); await view.dispose(); await pending; view = undefined;
      storageChecks.push({ phase: 'first-view-disposed', ...storage() });
      const live = [];
      const moving = await createPathTracingView({ renderer, scene, camera, width: 32, height: 24, maxBounces: 2, frameBudget: 128 });
      try {
        for (let frame = 0; frame < 3; frame++) {
          top.position.x = frame * .05; camera.position.x = frame * .02; scene.background = new THREE.Color().setRGB(.05 + frame * .01, .1, .15);
          moving.syncScene({ transforms: true, camera: true, environment: true }); moving.render();
          live.push({ samples: await moving.measureSamples(), image: await draw(moving.outputTexture), plan: moving.inspect() });
        }
        const activeStorage = storage();
        for (let topology = 0; topology < 3; topology++) {
          const addition = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), bottom.material); addition.position.x = 1 + topology * .1; scene.add(addition);
          moving.syncScene({ topology: true }); moving.render(); await moving.measureSamples(); await device.queue.onSubmittedWorkDone();
          const currentStorage = storage();
          if (currentStorage.count !== activeStorage.count) throw new Error('Topology refresh leaked compute storage: ' + JSON.stringify({ activeStorage, currentStorage }));
          storageChecks.push({ phase: 'topology-' + topology, ...currentStorage });
          scene.remove(addition); moving.syncScene({ topology: true }); moving.render(); await moving.measureSamples(); addition.geometry.dispose();
        }
      } finally { await moving.dispose(); }
      storageChecks.push({ phase: 'moving-view-disposed', ...storage() });
      const cycles = [];
      for (let i = 0; i < 3; i++) {
        const borrowed = await createPathTracingView({ renderer, scene, camera, width: 16, height: 12, maxBounces: 1, frameBudget: 512 });
        borrowed.render(); await borrowed.measureSamples(); await borrowed.dispose();
        renderer.render(scene, camera); await device.queue.onSubmittedWorkDone(); cycles.push(true);
        storageChecks.push({ phase: 'view-cycle-' + i, ...storage() });
      }
      return { initial, settled, raw, filtered, baseline, guides, live, runtime, preservedPolicy, staleImmediatelyRaw, resetState, cycles, sourceDisposals, storageBaseline, storageChecks,
        sourceBVHPreserved: top.geometry.boundsTree === sentinel, sourceIndexPreserved: JSON.stringify([...top.geometry.index.array]) === JSON.stringify(originalSourceIndex), deviceFeatures: [...device.features] };
    } finally {
      await refinement?.dispose(); await denoiser?.dispose(); await view?.dispose();
      top.geometry.dispose(); top.material.dispose(); bottom.geometry.dispose(); bottom.material.dispose();
      await renderer.dispose(); device.destroy(); canvas.remove();
    }
  });
  console.log(JSON.stringify({ test: 'borrowed-native-quality-static-OIDN-observation', ...result }, null, 2));
  assert.equal(result.settled.state, 'complete'); assert.ok(result.settled.samples.min >= 64);
  assert.equal(result.runtime.runtime.precision, 'fp32'); assert.equal(result.runtime.runtime.modelFamily, 'oidn-unet-large');
  assert.equal(result.raw.nonfinite, 0); assert.equal(result.filtered.nonfinite, 0); assert.ok(result.raw.maximum > 1); assert.ok(result.filtered.maximum > 1);
  assert.equal(result.raw.top[0] > result.raw.top[2], result.baseline.top[0] > result.baseline.top[2]); assert.equal(result.raw.bottom[2] > result.raw.bottom[0], result.baseline.bottom[2] > result.baseline.bottom[0]);
  assert.equal(result.filtered.top[0] > result.filtered.top[2], result.baseline.top[0] > result.baseline.top[2]); assert.equal(result.filtered.bottom[2] > result.filtered.bottom[0], result.baseline.bottom[2] > result.baseline.bottom[0]);
  assert.ok(result.guides.albedo.top[0] > result.guides.albedo.top[2]); assert.ok(result.guides.albedo.bottom[2] > result.guides.albedo.bottom[0]);
  for (const normal of [result.guides.normal.top, result.guides.normal.bottom]) { assert.ok(Math.abs(normal[0] - .5) < .02); assert.ok(Math.abs(normal[1] - .5) < .02); assert.ok(normal[2] > .98); }
  for (const frame of result.live) { assert.ok(frame.samples.min >= 1); assert.equal(frame.image.nonfinite, 0); assert.ok(frame.image.mean > .01); assert.ok(frame.plan.tiles.columns * frame.plan.tiles.rows > 1); }
  assert.equal(result.preservedPolicy, true); assert.equal(result.staleImmediatelyRaw, true); assert.equal(result.resetState, 'sampling');
  assert.equal(result.sourceBVHPreserved, true); assert.equal(result.sourceIndexPreserved, true); assert.equal(result.sourceDisposals, 0);
  assert.equal(result.cycles.length, 3); assert.deepEqual(errors, []);
  for (const check of result.storageChecks.filter(check => !check.phase.startsWith('topology-'))) { assert.equal(check.count, result.storageBaseline.count); assert.equal(check.bytes, result.storageBaseline.bytes); }
  console.log(JSON.stringify({ test: 'borrowed-native-quality-static-OIDN', ...result, graphics: await graphicsEvidence(page), errors }, null, 2));
} finally { try { await browser?.close(); } finally { await server.close(); } }
