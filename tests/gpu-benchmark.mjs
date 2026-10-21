import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { browserLaunchOptions, observeGraphics, graphicsEvidence } from './browser-gpu.mjs';

// Hardware is mandatory by default; software runs must be explicitly requested
// and are labelled as functional smoke tests in the artifact.
process.env.HARBOR_GPU_MODE ||= 'hardware';
const smoke = process.argv.includes('--smoke');
const cases = smoke ? [{ width: 32, height: 24, maxBounces: 4, frameBudget: 2048 }] : [
  { width: 320, height: 180, maxBounces: 4, frameBudget: 8192 },
  { width: 320, height: 180, maxBounces: 4, frameBudget: 32768 },
  { width: 320, height: 180, maxBounces: 4, frameBudget: 57600 },
  { width: 640, height: 360, maxBounces: 8, frameBudget: 131072 },
];
const artifact = resolve(process.env.HARBOR_BENCH_RESULT || 'tests/artifacts/gpu-benchmark.json');
const report = { ok: false, gpuMode: process.env.HARBOR_GPU_MODE,
  purpose: process.env.HARBOR_GPU_MODE === 'hardware' && !smoke ? 'hardware-benchmark' : 'functional-smoke',
  timestamp: new Date().toISOString(), cases: [], errors: [] };
let browser, server;
try {
  const launch = browserLaunchOptions();
  server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(),
    cacheDir: 'node_modules/.vite-gpu-benchmark', optimizeDeps: { include: ['three/webgpu', 'three/tsl', 'three-gpu-pathtracer', 'three-gpu-pathtracer/webgpu'] },
    plugins: [{ name: 'benchmark-modules', resolveId(id) { if (id === '/__gpu-modules.js') return id; },
      load(id) { if (id === '/__gpu-modules.js') return "export { RenderTarget, FloatType, QuadMesh, MeshBasicNodeMaterial } from 'three/webgpu';"; } }],
    server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'warn' });
  server.middlewares.use('/__gpu-benchmark', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>');
  });
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch(launch);
  report.browser = browser.version();
  const diagnostics = await browser.newBrowserCDPSession();
  try {
    const { gpu } = await diagnostics.send('SystemInfo.getInfo');
    // Omit command lines and profile paths from the portable report.
    report.browserGPU = { devices: gpu.devices, glRenderer: gpu.auxAttributes.glRenderer,
      webgpu: gpu.featureStatus.webgpu };
  } finally { await diagnostics.detach(); }
  const page = await browser.newPage();
  const evaluate = async (callback, argument) => {
    let timer;
    try { return await Promise.race([page.evaluate(callback, argument), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Benchmark evaluation exceeded 120s')), 120000);
    })]); } finally { clearTimeout(timer); }
  };
  await observeGraphics(page);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return (url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/__gpu-benchmark`);
  for (const configuration of cases) {
    // Validate the actual application adapter before submitting measured work.
    await evaluate(async configuration => {
      const { createWorld } = await import('/src/core/index.ts');
      const { createPathTracingRenderer } = await import('/src/pathtracing/index.ts');
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const world = createWorld({ version: 1, name: 'GPU benchmark', entities: [
        { id: 'floor', position: [0, -1, 0], visual: { shape: 'box', size: [10, .2, 10], color: '#b0b0b0', roughness: .7 } },
        { id: 'glass', position: [-1.1, 0, 0], visual: { shape: 'sphere', size: [2, 2, 2], color: '#b8e7fa', transmission: .8, roughness: .1, ior: 1.5 } },
        { id: 'metal', position: [1.1, 0, 0], visual: { shape: 'sphere', size: [2, 2, 2], color: '#eea154', metalness: 1, roughness: .2 } },
      ] });
      const start = performance.now();
      try {
        const view = await createPathTracingRenderer({ canvas, world, ...configuration });
        view.setCamera({ position: [4, 3, 6], target: [0, 0, 0], fov: 45 });
        window.__HARBOR_BENCH__ = { view, world, canvas, initializationMs: performance.now() - start };
      } catch (error) { world.dispose(); canvas.remove(); throw error; }
    }, configuration);
    report.graphics = await graphicsEvidence(page);
    const result = await evaluate(async ({ smoke }) => {
      const { view, world, canvas, initializationMs } = window.__HARBOR_BENCH__;
      const device = view.renderer.backend.device;
      const deadline = (promise, label) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded 30s`)), 30000); })]).finally(() => clearTimeout(timer));
      };
      try {
        // Exclude pipeline compilation and first-use allocation from dispatch timing.
        let warmed = false;
        for (let i = 0; i < 64; i++) {
          view.render(); await deadline(device.queue.onSubmittedWorkDone(), 'warmup');
          if ((await deadline(view.measureSamples(), 'warmup samples')).avg >= 1) { warmed = true; break; }
        }
        if (!warmed) throw new Error('Warmup did not complete a sample');
        view.reset();
        const durations = [], start = performance.now();
        do {
          const dispatchStart = performance.now();
          view.render(); await deadline(device.queue.onSubmittedWorkDone(), 'dispatch');
          durations.push(performance.now() - dispatchStart);
        } while (durations.length < (smoke ? 4 : 10000) && performance.now() - start < (smoke ? 1000 : 10000));
        const elapsedMs = performance.now() - start;
        const samples = await deadline(view.measureSamples(), 'sample readback');
        const inspection = view.inspect();
        const { RenderTarget, FloatType, QuadMesh, MeshBasicNodeMaterial } = await import('/__gpu-modules.js');
        const target = new RenderTarget(inspection.width, inspection.height, { type: FloatType });
        const quad = new QuadMesh(new MeshBasicNodeMaterial({ map: view.pathTracer.target, toneMapped: false }));
        let nonFinite = 0, sum = 0;
        try {
          view.renderer.setRenderTarget(target); quad.render(view.renderer); view.renderer.setRenderTarget(null);
          const pixels = await deadline(view.renderer.readRenderTargetPixelsAsync(target, 0, 0, inspection.width, inspection.height), 'radiance readback');
          for (let i = 0; i < pixels.length; i++) {
            if (!Number.isFinite(pixels[i])) nonFinite++;
            if (i % 4 !== 3) sum += pixels[i];
          }
        } finally { view.renderer.setRenderTarget(null); target.dispose(); quad.material.dispose(); quad.dispose(); }
        view.setCamera({ position: [4.2, 3, 6], target: [0, 0, 0], fov: 45 });
        const cameraReset = view.inspect().samples === null;
        let afterMotion;
        for (let i = 0; i < 64; i++) {
          view.render(); await deadline(device.queue.onSubmittedWorkDone(), 'camera motion');
          afterMotion = await deadline(view.measureSamples(), 'motion readback');
          if (afterMotion.avg > 0) break;
        }
        const sorted = [...durations].sort((a, b) => a - b);
        return { initializationMs, elapsedMs, dispatches: durations.length,
          dispatchMs: { mean: durations.reduce((a, b) => a + b, 0) / durations.length,
            median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] },
          samples, averageSamplesPerSecond: samples.avg * 1000 / elapsedMs,
          inspection, nonFinite, meanLinearRGB: sum / (inspection.width * inspection.height * 3), cameraReset, afterMotion };
      } finally { await view.dispose(); world.dispose(); canvas.remove(); delete window.__HARBOR_BENCH__; }
    }, { smoke });
    report.cases.push({ ...configuration, ...result });
    assert.equal(result.nonFinite, 0);
    assert.ok(result.meanLinearRGB > .001, 'Rendered radiance must be non-black');
    assert.ok(result.samples.avg > 0, 'The benchmark must complete measurable paths');
    assert.equal(result.cameraReset, true);
    assert.ok(result.afterMotion.avg > 0);
    console.log(JSON.stringify({ ...configuration, dispatches: result.dispatches, dispatchMs: result.dispatchMs, samples: result.samples }));
  }
  // GPU/console errors may arrive asynchronously after disposal.
  await page.waitForTimeout(100);
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  if (error.evidence) report.graphics = error.evidence;
  report.failure = error.stack || String(error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  try { await browser?.close(); } finally { await server?.close(); }
  await mkdir(resolve(artifact, '..'), { recursive: true });
  await writeFile(artifact, JSON.stringify(report, null, 2) + '\n');
  console.log(`GPU report: ${artifact}`);
}
