import {
  ACESFilmicToneMapping, Color, DataTexture, DataUtils, DirectionalLight,
  EquirectangularReflectionMapping, HalfFloatType, LinearFilter, Mesh,
  NearestFilter, PerspectiveCamera, RGBAFormat, Scene, WebGPURenderer,
  type Texture,
} from 'three/webgpu';
import { PhysicalCamera } from 'three-gpu-pathtracer';
import { WebGPUPathTracer, type SampleCounts } from 'three-gpu-pathtracer/webgpu';
import type { World } from '../core/index.js';
import { createWorldSceneBridge, type WorldSceneBridge } from './from-world.js';
export { createWorldSceneBridge } from './from-world.js';
export type { WorldSceneBridge, WorldSceneChange } from './from-world.js';
export { PhysicalCamera } from 'three-gpu-pathtracer';
export { WebGPUPathTracer, OIDNDenoiser, FSRUpscaler } from 'three-gpu-pathtracer/webgpu';

export interface PathTracingCamera {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  fov?: number;
  /** World units. Requires PhysicalCamera; the default camera is physical. */
  focusDistance?: number;
  /** Positive f-stop, or Infinity for a pinhole camera. */
  fStop?: number;
}
export interface PathTracingOptions {
  canvas: HTMLCanvasElement;
  /** Full Three scene: standard/physical materials, textures, lights and HDR environment. Caller-owned. */
  scene?: Scene;
  camera?: PerspectiveCamera;
  world?: World;
  width?: number;
  height?: number;
  maxBounces?: number;
  /** Upstream wavefront path slots per render call; higher is faster convergence, longer frames. */
  frameBudget?: number;
  /** Zero accumulates indefinitely. A nonzero settle point enables an attached OIDN denoiser. */
  maxSamples?: number;
  segments?: number;
  onError?: (error: Error) => void;
}
export interface PathTracingInspection {
  backend: 'webgpu';
  implementation: 'three-gpu-pathtracer';
  width: number;
  height: number;
  maxBounces: number;
  frameBudget: number;
  maxSamples: number;
  meshes: number;
  triangles: number;
  texturePages: number;
  textureWidth: number;
  textureHeight: number;
  samples: SampleCounts | null;
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number; maxTextureDimension2D: number };
  error?: string;
}
export interface PathTracingRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The complete upstream API, including material/environment/light updates, OIDN and FSR. */
  readonly pathTracer: WebGPUPathTracer;
  readonly worldBridge?: WorldSceneBridge;
  render(): void;
  resize(width: number, height: number): void;
  setCamera(camera: PathTracingCamera): void;
  /** Returns true only when the world changed; unchanged snapshots keep accumulating. */
  syncWorld(): boolean;
  /** Rebuild after scene graph or geometry edits; this can block on large CPU BVH builds. */
  invalidateScene(): void;
  reset(): void;
  inspect(): PathTracingInspection;
  /** Explicit GPU readback; inspect() itself does not stall to measure samples. */
  measureSamples(): Promise<SampleCounts>;
  /** Stops immediately; await to finish owned GPU-device cleanup. Safe to call repeatedly. */
  dispose(): Promise<void>;
}

function integer(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffffffff) throw new RangeError(`${name} must be an integer in [${minimum}, 4294967295]`);
  return value;
}
function vector(value: number[], name: string): void {
  if (value.length !== 3 || ![0, 1, 2].every(i => Number.isFinite(value[i]))) throw new TypeError(`${name} must contain three finite coordinates`);
}
function defaultEnvironment(): DataTexture {
  const data: number[] = [];
  for (let y = 0; y < 8; y++) {
    const t = y / 7;
    for (let x = 0; x < 16; x++) data.push(0.28 * (1 - t) + 0.08 * t, 0.48 * (1 - t) + 0.08 * t, 0.8 * (1 - t) + 0.08 * t, 1);
  }
  const texture = new DataTexture(new Uint16Array(data.map(DataUtils.toHalfFloat)), 16, 8, RGBAFormat, HalfFloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = texture.magFilter = LinearFilter; texture.needsUpdate = true;
  return texture;
}

/** Native WebGPU path tracing using the mature upstream wavefront implementation. No WebGL fallback. */
export async function createPathTracingRenderer(options: PathTracingOptions): Promise<PathTracingRenderer> {
  if (!options.canvas?.ownerDocument || !globalThis.navigator?.gpu) throw new Error('Quality path tracing requires WebGPU in a secure browser context');
  integer(options.maxBounces ?? 15, 'maxBounces'); integer(options.frameBudget ?? 250000, 'frameBudget'); integer(options.maxSamples ?? 0, 'maxSamples', 0);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available for quality path tracing');
  // Request the player's actual limits rather than silently retaining WebGPU minimums.
  const requiredLimits: Record<string, number> = {};
  for (const key of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxTextureDimension2D', 'maxTextureArrayLayers'] as const) requiredLimits[key] = adapter.limits[key];
  const device = await adapter.requestDevice({ requiredLimits, requiredFeatures: Array.from(adapter.features).filter(name => !name.startsWith('chromium-')) as GPUFeatureName[] });
  const renderer = new WebGPURenderer({ canvas: options.canvas, device, antialias: false });
  let disposed = false, error: Error | undefined, pathTracer: WebGPUPathTracer | undefined;
  let bridge: WorldSceneBridge | undefined, environment: DataTexture | undefined;
  const scene = options.scene ?? new Scene();
  const camera = options.camera ?? new PhysicalCamera(50, 1, 0.05, 10000);
  let width = 0, height = 0, samples: SampleCounts | null = null, revision = 0;
  function clearSamples(): void { samples = null; revision++; }
  let ownedSun: DirectionalLight | undefined, disposal: Promise<void> | undefined;
  let normalizedEnvironment: { original: Texture; copy: Texture } | undefined;
  const report = (value: unknown): void => {
    if (disposed || error) return;
    error = value instanceof Error ? value : new Error(typeof value === 'object' && value && 'message' in value ? String(value.message) : String(value));
    if (options.onError) options.onError(error); else console.error('[Harbor quality]', error);
  };
  renderer.onError = report;
  renderer.onDeviceLost = info => report(new Error(`WebGPU device lost: ${info.message}`));
  function assertOpen(): void { if (disposed) throw new Error('Path tracing renderer disposed'); if (error) throw error; }
  function normalizeEnvironment(): void {
    if (normalizedEnvironment && scene.environment !== normalizedEnvironment.copy) {
      normalizedEnvironment.copy.dispose(); normalizedEnvironment = undefined;
    }
    const value = scene.environment;
    // Upstream WGSL explicitly samples the HDR map. Three omits sampler bindings for
    // nearest-only textures; a private linear-filtered copy avoids that shader failure.
    if (value && !normalizedEnvironment && (value.minFilter === NearestFilter || value.magFilter === NearestFilter)) {
      const copy = value.clone(); copy.minFilter = copy.magFilter = LinearFilter; copy.needsUpdate = true;
      normalizedEnvironment = { original: value, copy }; scene.environment = copy;
    }
  }
  function invalidateScene(): void {
    assertOpen(); bridge?.sync();
    // Upstream reuses geometry.boundsTree. Explicit invalidation also means vertex
    // or topology edits, so discard those CPU caches before its synchronous rebuild.
    scene.traverse(object => {
      if (object instanceof Mesh) {
        delete (object.geometry as typeof object.geometry & { boundsTree?: unknown }).boundsTree;
        if ('isSkinnedMesh' in object && object.isSkinnedMesh) delete (object as Mesh & { boundsTree?: unknown }).boundsTree;
      }
    });
    refreshScene();
  }
  function refreshScene(): void {
    // Bridge lifecycle/material changes do not edit existing geometry. Retain its
    // BLAS caches while upstream rebuilds the scene bindings and top-level BVH.
    normalizeEnvironment(); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    pathTracer!.setScene(scene, camera); clearSamples();
  }
  function resize(w: number, h: number): void {
    assertOpen(); w = Math.floor(w); h = Math.floor(h); integer(w, 'width'); integer(h, 'height');
    if (Math.max(w, h) > device.limits.maxTextureDimension2D) throw new RangeError('Path tracing dimensions exceed the GPU texture limit');
    if (w === width && h === height) return;
    width = w; height = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    pathTracer?.updateCamera(); clearSamples();
  }
  function dispose(): Promise<void> {
    if (disposed) return disposal ?? Promise.resolve();
    disposed = true;
    const failures: unknown[] = [];
    const attempt = (cleanup: () => void): void => { try { cleanup(); } catch (failure) { failures.push(failure); } };
    disposal = (async () => {
      // Upstream renderSample starts sample-count readbacks of its own. WebGPU
      // settles earlier mapAsync calls before this same-queue completion promise.
      // Drain before destroying any backing buffers, then await Three's cleanup.
      try { await device.queue.onSubmittedWorkDone(); } catch (failure) { failures.push(failure); }
      attempt(() => pathTracer?.dispose()); attempt(() => bridge?.dispose());
      attempt(() => {
        if (normalizedEnvironment) {
          if (scene.environment === normalizedEnvironment.copy) scene.environment = normalizedEnvironment.original;
          normalizedEnvironment.copy.dispose();
        }
      });
      attempt(() => { if (ownedSun) { ownedSun.removeFromParent(); ownedSun.target.removeFromParent(); ownedSun.dispose(); } });
      attempt(() => { environment?.dispose(); if (scene.environment === environment) scene.environment = null; });
      try { await renderer.dispose(); } catch (failure) { failures.push(failure); }
      attempt(() => device.destroy());
      if (failures.length) {
        error = new AggregateError(failures, 'Path tracing resource cleanup failed');
        try { if (options.onError) options.onError(error); else console.error('[Harbor quality]', error); }
        catch (callbackFailure) { console.error('[Harbor quality] Error callback failed', callbackFailure); }
      }
    })();
    return disposal;
  }

  try {
    await renderer.init();
    if (!('isWebGPUBackend' in renderer.backend) || !renderer.backend.isWebGPUBackend) throw new Error('Quality path tracing requires a native WebGPU backend');
    renderer.setPixelRatio(1); renderer.toneMapping = ACESFilmicToneMapping;
    if (!options.camera) { camera.position.set(8, 6, 10); camera.lookAt(0, 1, 0); (camera as PhysicalCamera).fStop = Infinity; }
    if (!options.scene) {
      scene.background = new Color('#a3cbe4'); environment = defaultEnvironment(); scene.environment = environment;
      ownedSun = new DirectionalLight('#fff1d8', 3); ownedSun.position.set(5, 9, 4); scene.add(ownedSun, ownedSun.target);
    }
    if (options.world) { bridge = createWorldSceneBridge(options.world, scene, { segments: options.segments }); bridge.sync(); }
    resize(options.width ?? (options.canvas.clientWidth || options.canvas.width || 640), options.height ?? (options.canvas.clientHeight || options.canvas.height || 360));
    pathTracer = new WebGPUPathTracer(renderer);
    pathTracer.maxBounces = options.maxBounces ?? 15;
    pathTracer.frameBudget = options.frameBudget ?? 250000;
    pathTracer.maxSamples = options.maxSamples ?? 0;
    pathTracer.renderDelay = 0; pathTracer.fadeDuration = 0; pathTracer.dynamicLowRes = false;
    invalidateScene();
    return {
      renderer, scene, camera, pathTracer, worldBridge: bridge,
      render() { assertOpen(); pathTracer!.renderSample(); },
      resize, invalidateScene, dispose,
      reset() { assertOpen(); pathTracer!.reset(); clearSamples(); },
      setCamera(next) {
        assertOpen(); vector(next.position, 'camera.position'); vector(next.target, 'camera.target'); vector(next.up ?? [0, 1, 0], 'camera.up');
        const direction = next.target.map((v, i) => v - next.position[i]);
        const up = next.up ?? [0, 1, 0];
        const cross = [direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]];
        if (Math.hypot(...cross) < 1e-10) throw new RangeError('Camera direction must be nonzero and not parallel to up');
        const fov = next.fov ?? camera.fov;
        if (!Number.isFinite(fov) || fov <= 1 || fov >= 175) throw new RangeError('camera.fov must be between 1 and 175 degrees');
        if (next.focusDistance !== undefined && (!Number.isFinite(next.focusDistance) || next.focusDistance <= 0)) throw new RangeError('focusDistance must be positive and finite');
        if (next.fStop !== undefined && (!(next.fStop > 0) || Number.isNaN(next.fStop))) throw new RangeError('fStop must be positive, or Infinity');
        if ((next.focusDistance !== undefined || next.fStop !== undefined) && !(camera instanceof PhysicalCamera)) throw new TypeError('Depth of field requires a PhysicalCamera');
        const before = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, (camera as PhysicalCamera).focusDistance, (camera as PhysicalCamera).fStop].join(',');
        camera.position.fromArray(next.position); camera.up.fromArray(next.up ?? [0, 1, 0]); camera.fov = fov;
        camera.lookAt(...next.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        if (next.focusDistance !== undefined) (camera as PhysicalCamera).focusDistance = next.focusDistance;
        if (next.fStop !== undefined) (camera as PhysicalCamera).fStop = next.fStop;
        const after = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, (camera as PhysicalCamera).focusDistance, (camera as PhysicalCamera).fStop].join(',');
        if (before !== after) { pathTracer!.updateCamera(); clearSamples(); }
      },
      syncWorld() {
        assertOpen(); const change = bridge?.sync() ?? 'none';
        if (change === 'scene') refreshScene();
        else if (change === 'transforms') { scene.updateMatrixWorld(true); pathTracer!.updateTransforms(); clearSamples(); }
        return change !== 'none';
      },
      inspect() {
        let meshes = 0, triangles = 0;
        scene.traverseVisible(object => { if (object instanceof Mesh) { meshes++; triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position')?.count ?? 0) / 3 * ('isInstancedMesh' in object && object.isInstancedMesh ? Number((object as Mesh & { count: number }).count) : 1); } });
        const atlas = pathTracer!.textureAtlas;
        return { backend: 'webgpu', implementation: 'three-gpu-pathtracer', width, height, maxBounces: pathTracer!.maxBounces, frameBudget: pathTracer!.frameBudget, maxSamples: pathTracer!.maxSamples,
          meshes, triangles, texturePages: atlas.pageCount, textureWidth: atlas.width, textureHeight: atlas.height, samples: samples ? { ...samples } : null,
          limits: { maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxTextureDimension2D: device.limits.maxTextureDimension2D }, error: error?.message };
      },
      async measureSamples() { assertOpen(); const measuredRevision = revision; const counts = await pathTracer!.getSampleCountsAsync(); if (!disposed && measuredRevision === revision) samples = counts; return { ...counts }; },
    };
  } catch (failure) { await dispose(); throw failure; }
}
