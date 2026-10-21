import { createWorld, Scope, type Plugin, type SceneDefinition, type World, type WorldSnapshot } from '../core/index.js';
import type { BrowserRenderer, Quality } from '../render/index.js';
import type { PathTracer, TraceCamera, TraceEnvironment } from '../raytrace/types.js';
import type { PathTracingCamera, PathTracingRenderer } from '../pathtracing/index.js';
import type { PerspectiveCamera, Scene } from 'three/webgpu';

export interface GameTraceOptions {
  /** Quality is the full upstream renderer. Compact is the geometry-only reference integrator. */
  backend?: 'quality' | 'compact';
  maxBounces?: number;
  width?: number;
  height?: number;
  /** Advance simulation and synchronize changed geometry; false refines a static view. */
  live?: boolean;
  segments?: number;
  /** Quality backend: caller-owned native scene, including textures, lights and HDR environment. */
  scene?: Scene;
  /** Quality backend: caller-owned native camera. GameOptions.camera optionally sets its pose. */
  camera?: PerspectiveCamera;
  /** Quality backend: wavefront path slots per render dispatch, not samples per pixel. */
  frameBudget?: number;
  /** Quality backend: zero accumulates indefinitely; a settle point can drive an attached denoiser. */
  maxSamples?: number;
  /** Compact backend procedural lighting. Quality lighting belongs to trace.scene. */
  environment?: TraceEnvironment;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  scene: SceneDefinition;
  mode?: 'raster' | 'pathtrace';
  /** Defaults to true when the scene declares any physics bodies. */
  physics?: boolean;
  quality?: Quality;
  backend?: 'auto' | 'webgl';
  camera?: PathTracingCamera;
  autoStart?: boolean;
  trace?: GameTraceOptions;
  plugins?: Plugin[];
  onError?: (error: Error) => void;
}

export interface BrowserGame {
  readonly world: World;
  readonly renderer: BrowserRenderer | undefined;
  /** Present only for the explicit compact backend. */
  readonly tracer: PathTracer | undefined;
  /** Quality backend, exposing the native scene, camera and full upstream pathTracer. */
  readonly pathtracing: PathTracingRenderer | undefined;
  readonly running: boolean;
  readonly error: Error | undefined;
  start(): void;
  pause(): void;
  /** Advance exactly count fixed ticks, synchronize the view, and paint once. */
  step(count?: number): void;
  snapshot(): WorldSnapshot;
  setCamera(camera: PathTracingCamera): void;
  /** Rebuild scene/material bindings on the next paint; use step(0) to paint while paused. */
  invalidateScene(): void;
  resize(width?: number, height?: number): void;
  /** Stop synchronously. Await pathtracing?.dispose() afterward when quality GPU teardown must finish. */
  dispose(): void;
}

function copyCamera(camera: PathTracingCamera): Required<TraceCamera> & Pick<PathTracingCamera, 'focusDistance' | 'fStop'> {
  const vector = (value: unknown, name: string): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 || Array.from(value).some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e6)) {
      throw new TypeError(`${name} must contain three finite coordinates within ±1000000`);
    }
    return [...value] as [number, number, number];
  };
  const position = vector(camera.position, 'camera.position'), target = vector(camera.target, 'camera.target');
  const up = vector(camera.up ?? [0, 1, 0], 'camera.up'), fov = camera.fov ?? 50;
  if (!Number.isFinite(fov) || fov <= 1 || fov >= 175) throw new RangeError('camera.fov must be between 1 and 175 degrees');
  const direction = target.map((n, i) => n - position[i]);
  const cross = [direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]];
  if (Math.hypot(...cross) < 1e-8) throw new RangeError('Camera requires a nonzero direction and nonparallel up vector');
  if (camera.focusDistance !== undefined && (!Number.isFinite(camera.focusDistance) || camera.focusDistance <= 0)) throw new RangeError('camera.focusDistance must be positive and finite');
  if (camera.fStop !== undefined && (!(camera.fStop > 0) || Number.isNaN(camera.fStop))) throw new RangeError('camera.fStop must be positive, or Infinity');
  return { position, target, up, fov,
    ...(camera.focusDistance === undefined ? {} : { focusDistance: camera.focusDistance }),
    ...(camera.fStop === undefined ? {} : { fStop: camera.fStop }) };
}

/** Browser orchestration with optional modules loaded only for the requested game. */
export async function createGame(options: GameOptions): Promise<BrowserGame> {
  const { canvas } = options;
  const document = canvas?.ownerDocument, window = document?.defaultView;
  if (!document || !window || typeof window.requestAnimationFrame !== 'function') throw new Error('createGame requires a browser canvas');
  const mode = options.mode ?? 'raster';
  if (mode !== 'raster' && mode !== 'pathtrace') throw new TypeError(`Unknown rendering mode: ${mode}`);
  const traceBackend = options.trace?.backend ?? 'quality';
  if (traceBackend !== 'quality' && traceBackend !== 'compact') throw new TypeError(`Unknown path tracing backend: ${traceBackend}`);
  if (mode === 'pathtrace' && traceBackend === 'quality' && options.trace?.environment !== undefined) throw new TypeError('trace.environment is compact lighting; use trace.scene.environment for quality lighting');
  if (mode === 'pathtrace' && traceBackend === 'compact' && [options.trace?.scene, options.trace?.camera, options.trace?.frameBudget, options.trace?.maxSamples].some(value => value !== undefined)) {
    throw new TypeError('Native scenes, cameras, frameBudget and maxSamples require the quality path tracing backend');
  }
  let camera = options.camera ? copyCamera(options.camera) : mode === 'pathtrace' && traceBackend === 'quality' && options.trace?.camera
    ? undefined : copyCamera({ position: [8, 6, 10], target: [0, 1, 0] });
  const scope = new Scope();
  // An unstyled canvas derives CSS dimensions from its backing buffer. DPR resizing
  // would otherwise feed itself through ResizeObserver and grow without bound.
  // Probe before creating a context; preserve responsive stylesheet dimensions.
  const originalWidth = canvas.width, originalHeight = canvas.height;
  const cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight;
  const originalStyleWidth = canvas.style.width, originalStyleHeight = canvas.style.height;
  const computedStyle = window.getComputedStyle(canvas);
  const declaredWidth = computedStyle.width, declaredHeight = computedStyle.height;
  canvas.width = originalWidth + 1;
  // display:none yields zero client dimensions even with explicit vw/% sizing.
  // Those declarations still control layout once visible; do not override them.
  const intrinsicWidth = cssWidth > 0 ? canvas.clientWidth !== cssWidth : declaredWidth === 'auto';
  canvas.width = originalWidth;
  canvas.height = originalHeight + 1;
  const intrinsicHeight = cssHeight > 0 ? canvas.clientHeight !== cssHeight : declaredHeight === 'auto';
  canvas.height = originalHeight;
  if (intrinsicWidth) canvas.style.width = `${cssWidth || originalWidth}px`;
  if (intrinsicHeight) canvas.style.height = `${cssHeight || originalHeight}px`;
  scope.add(() => {
    if (intrinsicWidth) canvas.style.width = originalStyleWidth;
    if (intrinsicHeight) canvas.style.height = originalStyleHeight;
  });
  let world: World;
  try { world = createWorld(options.scene); }
  catch (error) {
    try { scope.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Scene validation and canvas cleanup failed'); }
    throw error;
  }
  scope.add(() => world.dispose());
  let renderer: BrowserRenderer | undefined, tracer: PathTracer | undefined, pathtracing: PathTracingRenderer | undefined;
  let traceModule: typeof import('../raytrace/index.js') | undefined;
  let requested = false, disposed = false, frame = 0, previous: number | undefined;
  let lastError: Error | undefined;
  let sceneDirty = true, geometryKey = '', definitionKey = '';

  function cancelFrame(): void {
    if (frame) window!.cancelAnimationFrame(frame);
    frame = 0; previous = undefined;
  }
  function pause(): void { requested = false; cancelFrame(); }
  function report(error: unknown): void {
    if (disposed) return;
    lastError = error instanceof Error ? error : new Error(String(error));
    pause();
    if (options.onError) options.onError(lastError);
    else console.error('[Harbor]', lastError);
  }
  function reportCleanup(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    lastError ??= failure;
    try {
      if (options.onError) options.onError(failure);
      else console.error('[Harbor] GPU cleanup failed', failure);
    } catch (callbackError) { console.error('[Harbor] Cleanup error callback failed', callbackError); }
  }
  function assertOpen(): void {
    if (disposed) throw new Error('Game disposed');
    if (lastError) throw lastError;
  }
  function updateTrace(): void {
    if (!tracer || !traceModule) return;
    const visuals = [...world.entities.values()].filter(entity => entity.visual);
    const definitions = JSON.stringify(visuals.map(entity => [entity.id, entity.visual]));
    const geometry = JSON.stringify(visuals.map(entity => [entity.position, entity.rotation, entity.scale]));
    if (sceneDirty || definitions !== definitionKey) {
      const scene = traceModule.fromWorld(world, { segments: options.trace?.segments });
      if (options.trace?.environment) scene.environment = options.trace.environment;
      tracer.setScene(scene);
      sceneDirty = false; definitionKey = definitions; geometryKey = geometry;
    } else if (geometry !== geometryKey) {
      tracer.updateGeometry(traceModule.fromWorld(world, { segments: options.trace?.segments }).triangles);
      geometryKey = geometry;
    }
  }
  function paint(): void {
    assertOpen();
    if (pathtracing) {
      if (sceneDirty) { pathtracing.invalidateScene(); sceneDirty = false; }
      else pathtracing.syncWorld();
      pathtracing.render();
    } else if (tracer) { updateTrace(); tracer.render(); }
    else renderer!.render();
  }
  function schedule(): void {
    if (!requested || disposed || document!.hidden || frame || lastError) return;
    frame = window!.requestAnimationFrame(now => {
      frame = 0;
      if (!requested || disposed || document!.hidden) { previous = undefined; return; }
      const dt = previous === undefined ? 0 : Math.max(0, (now - previous) / 1000);
      previous = now;
      try {
        if (mode === 'raster' || options.trace?.live === true) world.advance(dt);
        paint(); schedule();
      } catch (error) { report(error); }
    });
  }
  function start(): void { assertOpen(); if (requested) return; requested = true; previous = undefined; schedule(); }
  function setCamera(next: PathTracingCamera): void {
    assertOpen(); camera = copyCamera(next);
    if (!pathtracing && (camera.focusDistance !== undefined || camera.fStop !== undefined)) throw new TypeError('Camera focusDistance and fStop require quality path tracing');
    if (pathtracing) pathtracing.setCamera(camera);
    if (tracer) tracer.setCamera(camera);
    if (renderer) {
      renderer.camera.position.fromArray(camera.position);
      renderer.camera.up.fromArray(camera.up);
      renderer.camera.fov = camera.fov;
      renderer.camera.lookAt(...camera.target);
      renderer.camera.updateProjectionMatrix();
    }
  }
  function resize(width?: number, height?: number): void {
    assertOpen();
    const w = width ?? (mode === 'pathtrace' ? options.trace?.width : undefined) ?? (canvas.clientWidth || canvas.width || 640);
    const h = height ?? (mode === 'pathtrace' ? options.trace?.height : undefined) ?? (canvas.clientHeight || canvas.height || 360);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) throw new RangeError('Game dimensions must be positive');
    if (pathtracing) pathtracing.resize(w, h); else if (tracer) tracer.resize(w, h); else renderer!.resize(w, h);
  }

  try {
    if (options.physics ?? [...world.entities.values()].some(entity => !!entity.body)) {
      const { createRapierPlugin } = await import('../physics/index.js');
      world.install(await createRapierPlugin());
    }
    for (const plugin of options.plugins ?? []) world.install(plugin);
    if (mode === 'pathtrace' && traceBackend === 'quality') {
      const { createPathTracingRenderer } = await import('../pathtracing/index.js');
      pathtracing = await createPathTracingRenderer({ canvas, world, scene: options.trace?.scene, camera: options.trace?.camera,
        width: options.trace?.width, height: options.trace?.height, maxBounces: options.trace?.maxBounces,
        frameBudget: options.trace?.frameBudget, maxSamples: options.trace?.maxSamples, segments: options.trace?.segments,
        onError: error => disposed ? reportCleanup(error) : report(error) });
      const owned = pathtracing;
      scope.add(() => { void owned.dispose().catch(reportCleanup); }); sceneDirty = false;
    } else if (mode === 'pathtrace') {
      traceModule = await import('../raytrace/index.js');
      tracer = await traceModule.createPathTracer({ canvas, width: options.trace?.width, height: options.trace?.height,
        maxBounces: options.trace?.maxBounces, onError: report });
      const owned = tracer; scope.add(() => owned.dispose());
    } else {
      const { createBrowserRenderer } = await import('../render/index.js');
      renderer = await createBrowserRenderer({ canvas, world, quality: options.quality, backend: options.backend });
      const owned = renderer; scope.add(() => owned.dispose());
    }
    if (camera) setCamera(camera);
    resize();
    // Quality observes lifecycle changes through its bridge and retains unchanged
    // geometry BVHs. Only compact snapshots need lifecycle events to mark a rebuild.
    if (tracer) for (const type of ['entity:spawn', 'entity:remove']) {
      scope.add(world.events.on(type, () => { sceneDirty = true; }));
    }
    const visibility = () => { cancelFrame(); if (!document.hidden) schedule(); };
    document.addEventListener('visibilitychange', visibility);
    scope.add(() => document.removeEventListener('visibilitychange', visibility));
    const onResize = () => { try { resize(); } catch (error) { report(error); } };
    window.addEventListener('resize', onResize); scope.add(() => window.removeEventListener('resize', onResize));
    if (window.ResizeObserver) {
      const observer = new window.ResizeObserver(onResize); observer.observe(canvas);
      scope.add(() => observer.disconnect());
    }
    paint();
    const game: BrowserGame = {
      world, renderer, tracer, pathtracing,
      get running() { return requested && !document.hidden && !disposed && !lastError; },
      get error() { return lastError; },
      start, pause, setCamera, resize,
      step(count = 1) { assertOpen(); world.step(count); paint(); },
      snapshot: () => world.snapshot(),
      invalidateScene() { assertOpen(); sceneDirty = true; renderer?.invalidateScene(); },
      dispose() { if (disposed) return; disposed = true; pause(); scope.dispose(); },
    };
    if (options.autoStart !== false) start();
    return game;
  } catch (error) {
    disposed = true; pause();
    try { scope.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Game initialization and cleanup failed'); }
    throw error;
  }
}
