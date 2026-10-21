import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions, observeGraphics, graphicsEvidence } from './browser-gpu.mjs';
import { createServer } from 'vite';
import { createTexturedCubeGLB } from './fixtures/textured-cube.mjs';

const glbFixture = await createTexturedCubeGLB();

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), cacheDir: 'node_modules/.vite-quality-test', optimizeDeps: { include: ['three/webgpu', 'three/tsl', 'three-gpu-pathtracer', 'three-gpu-pathtracer/webgpu', '@harbor/engine/assets'] }, plugins: [{ name:'quality-test-module', resolveId(id) { if(id === '/__quality-modules.js') return id; }, load(id) { if(id === '/__quality-modules.js') return `export * as THREE from 'three/webgpu'; export { createPathTracingRenderer, PhysicalCamera } from '/src/pathtracing/index.ts'; export { createWorld } from '/src/core/index.ts'; export { createAssetManager, assertEmbeddedGLB } from '@harbor/engine/assets';`; } }], server: { hmr:false, host: '127.0.0.1', port: 5194, strictPort: true } });
server.middlewares.use('/__textured-cube.glb', (_req, res) => { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(Buffer.from(glbFixture)); });
server.middlewares.use('/__quality-test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>'); });
await server.listen();
let browser;
const errors = [];
try {
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage();
  await observeGraphics(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.text().startsWith('[quality-test]')) console.log(message.text()); if (message.type() === 'error') { console.log('[quality-error]', message.text().slice(0, 1000)); errors.push(message.text().slice(0, 2000)); } });
  await page.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort(); });
  await page.goto('http://127.0.0.1:5194/__quality-test');
  if (!process.argv.includes('--glb-only')) {
  const result = await page.evaluate(async () => {
    if (document.querySelectorAll('canvas').length) throw new Error('Test isolation failed: unexpected demo canvas');
    const { THREE, createPathTracingRenderer, PhysicalCamera, createWorld } = await import('/__quality-modules.js');
    const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after 30s')), 30000))]);
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#a8d9ed');
    const camera = new PhysicalCamera(45, 32 / 24, 0.1, 100); camera.position.set(4, 3, 5); camera.lookAt(0, 0, 0); camera.focusDistance = 6; camera.fStop = 4;
    const checker = new THREE.DataTexture(new Uint8Array([255,30,20,255, 20,180,255,255, 20,180,255,255, 255,30,20,255]), 2, 2);
    checker.colorSpace = THREE.SRGBColorSpace; checker.needsUpdate = true;
    const normal = new THREE.DataTexture(new Uint8Array([128,128,255,255, 180,128,240,255, 128,180,240,255, 128,128,255,255]), 2, 2); normal.needsUpdate = true;
    // Regression: user-created HDR textures default to nearest sampling; adapter owns a linear copy.
    const hdr = new THREE.DataTexture(new Float32Array([.3,.6,1,1, 3,2,1,1, .3,.6,1,1, .1,.1,.1,1, .2,.2,.2,1, .2,.2,.2,1, .2,.2,.2,1, .2,.2,.2,1]), 4, 2, THREE.RGBAFormat, THREE.FloatType);
    hdr.mapping = THREE.EquirectangularReflectionMapping; hdr.needsUpdate = true; scene.environment = hdr;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(8, .2, 8), new THREE.MeshStandardMaterial({ map: checker, normalMap: normal, roughness: .6 })); floor.position.y = -1; scene.add(floor);
    const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshPhysicalMaterial({ color:'#b8e7fa', transmission:.65, ior:1.5, thickness:2, roughness:.12, clearcoat:.8, iridescence:.2 })); scene.add(glass);
    const sun = new THREE.DirectionalLight('#fff4dc', 3); sun.position.set(3, 6, 4); scene.add(sun);
    console.log('[quality-test] starting'); const quality = await createPathTracingRenderer({ canvas, scene, camera, width:32, height:24, maxBounces:4, frameBudget:2048, maxSamples:4 });
    console.log('[quality-test] renderer ready'); for (let i = 0; i < 40; i++) { quality.render(); const c = await deadline(quality.measureSamples(), 'quality samples'); if (c.min >= 4) break; }
    console.log('[quality-test] textured scene converged'); const initial = quality.inspect();
    const target = new THREE.RenderTarget(32, 24, { type:THREE.FloatType });
    const quad = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ map:quality.pathTracer.target, toneMapped:false }));
    quality.renderer.setRenderTarget(target); quad.render(quality.renderer);
    const pixels = await quality.renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 24); quality.renderer.setRenderTarget(null);
    let sum = 0, max = 0, invalid = 0;
    for (let i = 0; i < pixels.length; i++) { if (!Number.isFinite(pixels[i])) invalid++; if (i % 4 !== 3) { sum += pixels[i]; max = Math.max(max, pixels[i]); } }
    quality.setCamera({ position:[4, 3, 5], target:[0, 0, 0], fov:45, focusDistance:5, fStop:8 });
    const cameraReset = quality.inspect().samples === null;
    quality.resize(24, 16); quality.render(); await deadline(quality.measureSamples(), 'quality samples');
    console.log('[quality-test] resized'); const resized = quality.inspect();
    await quality.dispose(); await quality.dispose();
    console.log('[quality-test] disposed scene'); const restored = scene.environment === hdr && hdr.minFilter === THREE.NearestFilter;
    target.dispose(); quad.material.dispose(); quad.dispose(); floor.geometry.dispose(); floor.material.dispose(); glass.geometry.dispose(); glass.material.dispose(); checker.dispose(); normal.dispose(); hdr.dispose();

    const world = createWorld({ version:1, name:'Quality bridge', entities:[{id:'ball',position:[0,0,0],visual:{shape:'sphere',size:[2,2,2],color:'#f15c31'}}] });
    const secondCanvas = document.createElement('canvas'); document.body.append(secondCanvas);
    const second = await createPathTracingRenderer({ canvas:secondCanvas, world, width:16, height:12, maxBounces:2, frameBudget:512, maxSamples:2, segments:8 });
    const ballGeometry = second.worldBridge.getObject('ball').geometry, ballBVH = ballGeometry.boundsTree;
    console.log('[quality-test] world bridge ready'); for(let i=0;i<30;i++){second.render();if((await deadline(second.measureSamples(), 'world samples')).min>=2)break;}
    console.log('[quality-test] world bridge converged'); const unchanged = second.syncWorld(), stableSamples = second.inspect().samples;
    world.get('ball').position[0] = 0.5;
    const moved = second.syncWorld(), movedSamples = second.inspect().samples;
    world.spawn({id:'box',position:[0,-2,0],visual:{shape:'box',size:[5,1,5],color:'#ffffff'}});
    const rebuilt = second.syncWorld(); second.render(); await deadline(second.measureSamples(), 'world samples'); const spawned = second.inspect();
    const spawnPreservedBVH = ballGeometry.boundsTree === ballBVH;
    world.get('ball').visual.roughness = .2; second.syncWorld();
    const materialPreservedBVH = second.worldBridge.getObject('ball').geometry === ballGeometry && ballGeometry.boundsTree === ballBVH;
    second.render(); await deadline(second.measureSamples(), 'world samples');
    const boxGeometry = second.worldBridge.getObject('box').geometry, boxBVH = boxGeometry.boundsTree;
    world.remove('ball'); second.syncWorld(); second.render(); await deadline(second.measureSamples(), 'world samples'); const removed = second.inspect();
    const removalPreservedBVH = boxGeometry.boundsTree === boxBVH;
    await second.dispose(); world.dispose();
    return { initial, mean:sum/(32*24*3), max, invalid, cameraReset, resized, restored, unchanged, stableSamples, moved, movedSamples, rebuilt, spawned, removed,
      spawnPreservedBVH, materialPreservedBVH, removalPreservedBVH };
  });
  assert.equal(result.initial.backend, 'webgpu'); assert.equal(result.initial.samples.min, 4);
  assert.equal(result.invalid, 0); assert.ok(result.mean > .01); assert.ok(result.max > 1, 'HDR readback retains radiance above one');
  assert.ok(result.initial.texturePages > 0); assert.equal(result.cameraReset, true);
  assert.equal(result.resized.width, 24); assert.equal(result.resized.height, 16); assert.equal(result.restored, true);
  assert.equal(result.unchanged, false); assert.equal(result.stableSamples.min, 2);
  assert.equal(result.moved, true); assert.equal(result.movedSamples, null); assert.equal(result.rebuilt, true);
  assert.equal(result.spawned.meshes, 2); assert.equal(result.removed.meshes, 1); assert.deepEqual(errors, []);
  assert.equal(result.spawnPreservedBVH, true); assert.equal(result.materialPreservedBVH, true); assert.equal(result.removalPreservedBVH, true);
  console.log(JSON.stringify({ test:'native-webgpu-quality', ...result, errors }, null, 2));

  const facadeBVH = await page.evaluate(async () => {
    const { THREE } = await import('/__quality-modules.js');
    const { createGame } = await import('/src/browser/index.ts');
    const deadline = (promise, label) => {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after 30s')), 30000); })]).finally(() => clearTimeout(timer));
    };
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 12; document.body.append(canvas);
    const nativeScene = new THREE.Scene(); nativeScene.background = new THREE.Color('#000000');
    let game;
    try {
      game = await createGame({ canvas, mode:'pathtrace', autoStart:false,
        scene:{ version:1, name:'BVH cache lifecycle', entities:[{ id:'anchor', visual:{ shape:'box', size:[2,2,2], emissive:'#ff0000', emissiveIntensity:2 } }] },
        camera:{ position:[0,0,4], target:[0,0,0], fov:45 },
        trace:{ scene:nativeScene, width:16, height:12, maxBounces:2, frameBudget:512, maxSamples:2, segments:8 } });
      const view = game.pathtracing, geometry = view.worldBridge.getObject('anchor').geometry, originalBVH = geometry.boundsTree;
      const converge = async () => {
        for (let i = 0; i < 24; i++) { game.step(0); if ((await deadline(view.measureSamples(), 'facade samples')).min >= 2) return; }
        throw new Error('Facade did not converge');
      };
      const capture = async () => {
        const target = new THREE.RenderTarget(16,12,{type:THREE.FloatType});
        const quad = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({map:view.pathTracer.target,toneMapped:false}));
        try {
          view.renderer.setRenderTarget(target); quad.render(view.renderer); view.renderer.setRenderTarget(null);
          const pixels = await deadline(view.renderer.readRenderTargetPixelsAsync(target,0,0,16,12), 'facade pixels');
          let sum = 0, nonFinite = 0;
          for (let i = 0; i < pixels.length; i++) { if (!Number.isFinite(pixels[i])) nonFinite++; if (i % 4 !== 3) sum += pixels[i]; }
          return { mean:sum/(16*12*3), centerRed:pixels[(6*16+8)*4], nonFinite };
        } finally { view.renderer.setRenderTarget(null); target.dispose(); quad.material.dispose(); quad.dispose(); }
      };
      game.world.spawn({ id:'temporary', position:[10,0,0], visual:{shape:'box',size:[1,1,1]} }); game.step(0);
      const spawnPreservedBVH = geometry.boundsTree === originalBVH;
      await deadline(view.measureSamples(), 'facade spawn');
      game.world.remove('temporary'); game.step(0);
      const removalPreservedBVH = geometry.boundsTree === originalBVH;
      await deadline(view.measureSamples(), 'facade removal');
      game.world.get('anchor').visual.emissiveIntensity = 3; game.step(0);
      const anchor = view.worldBridge.getObject('anchor');
      const materialPreservedBVH = anchor.geometry === geometry && geometry.boundsTree === originalBVH;
      const updatedEmission = anchor.material.emissiveIntensity;
      await converge(); const before = await capture();
      // Move the vertices beyond the old bounds. Explicit invalidation must rebuild
      // the cached BLAS and remove the emissive box from the rendered camera view.
      geometry.translate(10,0,0); game.invalidateScene(); game.step(0);
      const geometryRebuiltBVH = geometry.boundsTree !== originalBVH;
      const boundsMinimumX = geometry.boundsTree.getBoundingBox(new THREE.Box3()).min.x;
      await converge(); const after = await capture();
      return { spawnPreservedBVH, removalPreservedBVH, materialPreservedBVH, updatedEmission, geometryRebuiltBVH, boundsMinimumX, before, after };
    } finally { game?.dispose(); await game?.pathtracing?.dispose(); canvas.remove(); }
  });
  assert.equal(facadeBVH.spawnPreservedBVH, true); assert.equal(facadeBVH.removalPreservedBVH, true); assert.equal(facadeBVH.materialPreservedBVH, true);
  assert.equal(facadeBVH.updatedEmission, 3); assert.equal(facadeBVH.geometryRebuiltBVH, true); assert.ok(facadeBVH.boundsMinimumX > 8.9);
  assert.equal(facadeBVH.before.nonFinite, 0); assert.equal(facadeBVH.after.nonFinite, 0);
  assert.ok(facadeBVH.before.centerRed > 1); assert.ok(facadeBVH.before.mean > .1); assert.ok(facadeBVH.after.mean < .001);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({test:'quality-facade-bvh-cache', ...facadeBVH, errors}, null, 2));
  }

  const imported = await page.evaluate(async () => {
    const { THREE, createAssetManager, assertEmbeddedGLB, createPathTracingRenderer } = await import('/__quality-modules.js');
    const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after 30s')), 30000))]);
    const fixtureUrl = new URL('/__textured-cube.glb', location.href).href;
    const bytes = await (await fetch(fixtureUrl)).arrayBuffer(); assertEmbeddedGLB(bytes);
    const jsonLength = new DataView(bytes).getUint32(12,true);
    const fixtureJson = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,jsonLength)));
    const meshoptRequired = fixtureJson.extensionsRequired.includes('EXT_meshopt_compression');
    const assets = createAssetManager();
    const handle = await deadline(assets.acquire('gltf', fixtureUrl), 'public embedded GLB loader');
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#202020');
    const environment = new THREE.DataTexture(new Uint16Array([.4, .4, .4, 1].map(THREE.DataUtils.toHalfFloat)), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    environment.mapping = THREE.EquirectangularReflectionMapping; environment.minFilter = environment.magFilter = THREE.LinearFilter; environment.needsUpdate = true; scene.environment = environment;
    const sun = new THREE.DirectionalLight('#ffffff', 4); sun.position.set(4, 6, 5); scene.add(sun);
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 100); camera.position.set(3, 2, 4); camera.lookAt(0, 0, 0);
    let quality, cube;
    const releases = { geometry:0, material:0, texture:0 };
    handle.value.scene.traverse(object => { if(object.isMesh && object.material.map) cube = object; });
    if(!cube) throw new Error('GLTFLoader did not restore the embedded texture material');
    const image = cube.material.map.source.data;
    const dimensions = [image.width, image.height];
    cube.geometry.addEventListener('dispose', () => releases.geometry++);
    cube.material.addEventListener('dispose', () => releases.material++);
    cube.material.map.addEventListener('dispose', () => releases.texture++);
    try {
      quality = await createPathTracingRenderer({ canvas, scene, camera, width:16, height:16, maxBounces:2, frameBudget:256, maxSamples:2 });
      scene.add(handle.value.scene); quality.invalidateScene();
      console.log('[quality-test] imported embedded textured GLB');
      const converge = async () => { for(let i=0;i<24;i++){quality.render();if((await deadline(quality.measureSamples(), 'imported GLB samples')).min>=2)break;} };
      await converge();
      const before = quality.inspect();
      const target = new THREE.RenderTarget(16,16,{type:THREE.FloatType});
      const material = new THREE.MeshBasicNodeMaterial({map:quality.pathTracer.target,toneMapped:false});
      const quad = new THREE.QuadMesh(material);
      let pixels;
      try {
        quality.renderer.setRenderTarget(target); quad.render(quality.renderer); quality.renderer.setRenderTarget(null);
        pixels = await deadline(quality.renderer.readRenderTargetPixelsAsync(target,0,0,16,16), 'imported GLB readback');
      } finally { target.dispose(); material.dispose(); quad.dispose(); }
      let sum=0,max=0,nonFinite=0,redPixels=0,cyanPixels=0;
      for(let i=0;i<pixels.length;i+=4){const [r,g,b]=pixels.slice(i,i+3);for(const value of [r,g,b]){if(!Number.isFinite(value))nonFinite++;sum+=value;max=Math.max(max,value);}if(r>1.5*b&&r>.03)redPixels++;if(b>1.5*r&&b>.03)cyanPixels++;}
      handle.value.scene.position.x = .4; quality.pathTracer.updateTransforms(); quality.reset();
      const reset = quality.inspect().samples === null; await converge(); const moved = quality.inspect();
      // Stop immediately after a reset frame starts upstream's asynchronous sample read.
      // No sample has been awaited here; disposal must drain this work before destroying buffers.
      quality.reset(); quality.render();
      const stopBeforeCompletedSample = quality.inspect().samples === null;
      const pendingSampleRead = quality.measureSamples();
      await quality.dispose();
      const completedPendingRead = await pendingSampleRead;
      await new Promise(resolve => setTimeout(resolve, 100));
      const borrowedAfterViewDispose = {...releases};
      scene.remove(handle.value.scene); handle.release(); handle.release(); assets.dispose();
      return {bytes:bytes.byteLength, meshoptRequired, dimensions, textureColorSpace:cube.material.map.colorSpace, before, mean:sum/(16*16*3),max,nonFinite,redPixels,cyanPixels,reset,moved,stopBeforeCompletedSample,completedPendingRead,borrowedAfterViewDispose,releases:{...releases},remainingAssetEntries:assets.size};
    } finally {
      if(quality) await quality.dispose(); scene.remove(handle.value.scene); handle.release(); assets.dispose(); environment.dispose(); sun.dispose();
    }
  });
  assert.equal(imported.meshoptRequired,true); assert.equal(imported.dimensions.join('x'),'2x2'); assert.equal(imported.textureColorSpace,'srgb');
  assert.equal(imported.before.meshes,1); assert.equal(imported.before.triangles,12); assert.equal(imported.before.samples.min,2);
  assert.equal(imported.nonFinite,0); assert.ok(imported.mean>.01); assert.ok(imported.redPixels>0); assert.ok(imported.cyanPixels>0);
  assert.equal(imported.reset,true); assert.equal(imported.moved.samples.min,2);
  assert.equal(imported.stopBeforeCompletedSample,true);
  assert.ok(Number.isFinite(imported.completedPendingRead.avg));
  assert.deepEqual(imported.borrowedAfterViewDispose,{geometry:0,material:0,texture:0});
  assert.deepEqual(imported.releases,{geometry:1,material:1,texture:1}); assert.equal(imported.remainingAssetEntries,0); assert.deepEqual(errors,[]);
  console.log(JSON.stringify({test:'public-textured-glb-to-quality',...imported,errors},null,2));

  console.log(JSON.stringify({test:'quality-graphics-adapters', gpuMode:process.env.HARBOR_GPU_MODE||'software', graphics:await graphicsEvidence(page)}, null, 2));
} finally { try { await browser?.close(); } finally { await server.close(); } }
