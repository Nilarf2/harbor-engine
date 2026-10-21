import {
  LinearFilter, LinearSRGBColorSpace, NearestFilter, NoToneMapping, PerspectiveCamera,
  RenderTarget, Vector2, type Scene, type Texture, type WebGPURenderer,
} from 'three/webgpu';
import { WebGPUPathTracer, type SampleCounts } from 'three-gpu-pathtracer/webgpu';
import { PreparedQualityScene, type PreparedSceneInspection, type QualitySceneChange } from './prepare-scene.js';
import { completeFramePlan, type CompleteFramePlan } from './frame-plan.js';
import { OwnedPathTracingBVH } from './owned-bvh.js';

export interface PathTracingViewOptions {
  /** Initialized native WebGPU renderer; its canvas, device and output policy remain caller-owned. */
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  width?: number;
  height?: number;
  maxBounces?: number;
  frameBudget?: number;
  maxSamples?: number;
  /** Complete full-resolution sample per render (default), or one progressive tile. */
  samplingMode?: 'complete-frame' | 'progressive';
  onError?: (error: Error) => void;
}
export interface PathTracingViewInspection extends PreparedSceneInspection {
  backend: 'webgpu';
  implementation: 'three-gpu-pathtracer';
  width: number;
  height: number;
  revision: number;
  maxBounces: number;
  maxSamples: number;
  frameBudget: number;
  samplingMode: 'complete-frame' | 'progressive';
  tracingKernel: 'megakernel';
  tiles: { columns: number; rows: number; dispatches: number; maxTilePixels: number };
  samples: SampleCounts | null;
  texturePages: number;
  textureWidth: number;
  textureHeight: number;
  /** Actual single packed vertex binding; excludes all other renderer resources. */
  packedAttributeBytes?: number;
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number; maxTextureDimension2D: number };
  error?: string;
}
export interface PathTracingView {
  readonly renderer: WebGPURenderer;
  /** Caller-owned source scene. */
  readonly scene: Scene;
  /** Read-only private PBR graph, also used for matching denoising guides. */
  readonly preparedScene: Scene;
  readonly camera: PerspectiveCamera;
  readonly pathTracer: WebGPUPathTracer;
  readonly revision: number;
  /** Linear HDR, top-to-bottom image. Output tone mapping belongs to the application. */
  readonly outputTexture: Texture;
  /** Accumulates one complete sample by default; never presents or changes output policy. */
  render(): void;
  /** Dimensions are drawing-buffer pixels. Does not resize the renderer or change the camera. */
  resize(width: number, height: number): void;
  syncScene(change: QualitySceneChange): boolean;
  reset(): void;
  measureSamples(): Promise<SampleCounts>;
  inspect(): PathTracingViewInspection;
  dispose(): Promise<void>;
}

function positiveInteger(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffffffff) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

/** Request actual adapter limits for large native scenes; no optional FP16 requirement. Caller owns the result. */
export async function createQualityDevice(): Promise<GPUDevice> {
  if (!globalThis.navigator?.gpu) throw new Error('Quality rendering requires WebGPU in a secure browser context');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available');
  const requiredLimits: Record<string, number> = {};
  for (const name of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxTextureDimension2D', 'maxTextureArrayLayers'] as const) requiredLimits[name] = adapter.limits[name];
  return adapter.requestDevice({ requiredLimits });
}

/**
 * Native quality view borrowing an application's renderer. Its private compact graph
 * prevents upstream BVH preparation from changing application geometry or skeletons.
 */
export async function createPathTracingView(options: PathTracingViewOptions): Promise<PathTracingView> {
  positiveInteger(options.maxBounces ?? 15, 'maxBounces');
  positiveInteger(options.frameBudget ?? 250000, 'frameBudget');
  positiveInteger(options.maxSamples ?? 0, 'maxSamples', 0);
  const samplingMode = options.samplingMode ?? 'complete-frame';
  if (!['complete-frame', 'progressive'].includes(samplingMode)) throw new TypeError('Unknown quality sampling mode');
  const { renderer, scene, camera } = options;
  await renderer.init();
  const backend = renderer.backend as typeof renderer.backend & { device?: GPUDevice; isWebGPUBackend?: boolean };
  const device = backend.device;
  if (!backend.isWebGPUBackend || !device) throw new Error('Quality view requires a native WebGPU renderer; use raster on WebGL2');
  const ownedBVH = new OwnedPathTracingBVH(renderer);
  let prepared: PreparedQualityScene | undefined, tracer: WebGPUPathTracer | undefined;
  // Upstream presents after computing. Bind a private 1px discard target so the
  // application alone composes raw HDR and performs the display transformation.
  const discard = new RenderTarget(1, 1);
  let disposed = false, disposal: Promise<void> | undefined, failure: Error | undefined;
  let width = 0, height = 0, revision = 0, samples: SampleCounts | null = null;
  let requestedBudget = options.frameBudget ?? 250000, installedBudget = requestedBudget;
  let plan: CompleteFramePlan;
  const pendingReads = new Set<Promise<SampleCounts>>();
  let filteredEnvironment: { original: Texture; copy: Texture } | undefined;
  const report = (error: unknown): void => {
    if (disposed || failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    options.onError?.(failure);
  };
  const assertOpen = (): void => { if (disposed) throw new Error('Path tracing view disposed'); if (failure) throw failure; };
  const changed = (): void => { revision++; samples = null; };
  const checkCapacity = (): void => {
    const bytes = prepared!.inspect().estimatedAttributeBytes;
    const maximum = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (bytes > maximum) throw new RangeError(`Quality scene needs ${bytes} bytes of vertex storage, device allows ${maximum}; retain scene fidelity and use raster on this device`);
  };
  const normalizeEnvironment = (): void => {
    const current = prepared!.scene.environment;
    if (filteredEnvironment && current !== filteredEnvironment.copy) { filteredEnvironment.copy.dispose(); filteredEnvironment = undefined; }
    if (current && !filteredEnvironment && (current.minFilter === NearestFilter || current.magFilter === NearestFilter)) {
      const copy = current.clone(); copy.minFilter = copy.magFilter = LinearFilter; copy.needsUpdate = true;
      filteredEnvironment = { original: current, copy }; prepared!.scene.environment = copy;
    }
  };
  const refresh = (): void => {
    checkCapacity(); normalizeEnvironment();
    try { ownedBVH.setScene(tracer!, prepared!.scene, camera); }
    catch (error) { report(error); throw error; }
  };
  function configureTiles(): void {
    if (tracer!.frameBudget !== installedBudget) requestedBudget = positiveInteger(tracer!.frameBudget, 'frameBudget');
    const next = completeFramePlan(width, height, requestedBudget);
    if (plan && next.backendBudget !== installedBudget) { tracer!.reset(); changed(); }
    plan = next; installedBudget = next.backendBudget; tracer!.frameBudget = installedBudget;
  }
  async function measureSamples(): Promise<SampleCounts> {
    assertOpen(); const measuredRevision = revision;
    const read = tracer!.getSampleCountsAsync(); pendingReads.add(read);
    try {
      const measured = await read;
      if (!disposed && measuredRevision === revision) samples = { ...measured };
      return { ...measured };
    } finally { pendingReads.delete(read); }
  }
  function render(): void {
    assertOpen(); configureTiles();
    const target = renderer.getRenderTarget(), mrt = renderer.getMRT();
    const toneMapping = renderer.toneMapping, outputColorSpace = renderer.outputColorSpace;
    try {
      renderer.setMRT(null); renderer.setRenderTarget(discard);
      renderer.toneMapping = NoToneMapping; renderer.outputColorSpace = LinearSRGBColorSpace;
      // A pinned upstream megakernel call completes one tile's full light path.
      // Never replace this finite cycle with sample-count polling or one giant dispatch.
      const dispatches = samplingMode === 'complete-frame' ? plan.dispatches : 1;
      for (let tile = 0; tile < dispatches; tile++) tracer!.renderSample();
    } finally {
      renderer.setRenderTarget(target); renderer.setMRT(mrt);
      renderer.toneMapping = toneMapping; renderer.outputColorSpace = outputColorSpace;
    }
    // Megakernel counters are CPU-derived, with no GPU readback or blocking wait.
    // Observe rejection explicitly: callers may destroy the device during teardown.
    void measureSamples().catch(report);
  }
  function resize(w: number, h: number): void {
    assertOpen(); positiveInteger(w, 'width'); positiveInteger(h, 'height');
    if (Math.max(w, h) > device!.limits.maxTextureDimension2D) throw new RangeError('Quality dimensions exceed the GPU texture limit');
    if (w === width && h === height) return;
    const next = completeFramePlan(w, h, requestedBudget);
    width = w; height = h; tracer!.setSize(w, h); changed();
    plan = next; installedBudget = next.backendBudget; tracer!.frameBudget = installedBudget;
  }
  async function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      await Promise.allSettled(pendingReads);
      try { await device!.queue.onSubmittedWorkDone(); } catch { /* Device loss still requires local cleanup. */ }
      const errors: unknown[] = [];
      const attempt = (cleanup: () => void): void => { try { cleanup(); } catch (error) { errors.push(error); } };
      if (tracer) attempt(() => ownedBVH.disposeTracer(tracer!));
      attempt(() => discard.dispose());
      if (prepared) attempt(() => prepared!.dispose());
      if (filteredEnvironment) attempt(() => filteredEnvironment!.copy.dispose());
      // Renderer, device, source graph, materials and textures are deliberately borrowed.
      if (errors.length) throw new AggregateError(errors, 'Failed to dispose all owned quality-view resources');
    })();
    return disposal;
  }
  try {
    prepared = new PreparedQualityScene(scene); checkCapacity();
    tracer = new WebGPUPathTracer(renderer);
    const native = tracer as WebGPUPathTracer & { useMegakernel(value: boolean): void };
    if (typeof native.useMegakernel !== 'function') throw new Error('Pinned native tracer is missing its megakernel implementation');
    native.useMegakernel(true);
    // Switching the upstream backend replaces its configuration with defaults.
    tracer.maxBounces = options.maxBounces ?? 15;
    tracer.frameBudget = options.frameBudget ?? 250000;
    tracer.maxSamples = options.maxSamples ?? 0;
    tracer.renderDelay = 0; tracer.fadeDuration = 0; tracer.dynamicLowRes = false;
    tracer.synchronizeRenderSize = false;
    const size = renderer.getDrawingBufferSize(new Vector2());
    resize(options.width ?? Math.max(1, size.x), options.height ?? Math.max(1, size.y));
    refresh(); changed();
    // Allocate the raw target before exposing it to the application's composition
    // graph. The initial sample is offscreen; reset establishes a clean revision.
    render(); tracer.reset(); changed();
    void device.lost.then(info => report(new Error(`Quality device lost: ${info.message}`))).catch(report);
    return {
      renderer, scene, camera, pathTracer: tracer,
      get preparedScene() { return prepared!.scene; },
      get outputTexture() { return tracer!.target!; },
      get revision() { return revision; },
      render,
      resize,
      syncScene(change) {
        assertOpen();
        const geometry = change.geometry && change.geometry.length > 0;
        const any = Boolean(change.topology || geometry || change.camera || change.transforms || change.materials || change.lights || change.environment);
        if (!any) return false;
        if (change.topology) { prepared!.rebuild(); refresh(); }
        else if (geometry) { prepared!.updateGeometry(change.geometry!); refresh(); }
        else {
          if (change.transforms || change.lights) prepared!.syncTransforms();
          if (change.transforms) tracer!.updateTransforms();
          if (change.materials) { prepared!.syncMaterials(); tracer!.updateMaterials(); }
          if (change.environment) { prepared!.syncEnvironment(); normalizeEnvironment(); tracer!.updateEnvironment(); }
          if (change.lights) ownedBVH.updateLights(tracer!);
          if (change.camera) tracer!.updateCamera();
        }
        changed(); return true;
      },
      reset() { assertOpen(); tracer!.reset(); changed(); },
      measureSamples,
      inspect() {
        const atlas = tracer!.textureAtlas;
        const packed = (tracer as unknown as { _bvhData?: { storage?: { attributes?: { value?: { array?: ArrayBufferView } } } } })._bvhData?.storage?.attributes?.value?.array;
        return { ...prepared!.inspect(), backend: 'webgpu', implementation: 'three-gpu-pathtracer', width, height, revision,
          maxBounces: tracer!.maxBounces, maxSamples: tracer!.maxSamples, frameBudget: requestedBudget,
          samplingMode, tracingKernel: 'megakernel', tiles: { columns: plan.columns, rows: plan.rows, dispatches: plan.dispatches, maxTilePixels: plan.maxTilePixels },
          samples, texturePages: atlas.pageCount, textureWidth: atlas.width, textureHeight: atlas.height,
          ...(packed ? { packedAttributeBytes: packed.byteLength } : {}),
          limits: { maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxTextureDimension2D: device.limits.maxTextureDimension2D },
          ...(failure ? { error: failure.message } : {}), };
      }, dispose,
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Quality-view initialization and cleanup both failed'); }
    throw error;
  }
}
