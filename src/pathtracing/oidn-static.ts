// Guide-buffer and GPU-output integration adapted from three-gpu-pathtracer (MIT).
import {
  Color, ExternalTexture, HalfFloatType, LinearSRGBColorSpace, NearestFilter,
  NoToneMapping, RenderTarget, type PerspectiveCamera, type Scene, type Texture, type WebGPURenderer,
} from 'three/webgpu';
import { diffuseColor, mrt, normalView, vec4 } from 'three/tsl';
import { initUNetFromBuffer, OIDN_UNET_LARGE_SPEC, type UNet } from 'oidn-web';
import type { StaticDenoiseFrame, StaticDenoiser } from './static-refinement.js';

export const OIDN_LARGE_WEIGHTS = Object.freeze({
  file: 'rt_hdr_calb_cnrm_large.08130cdc4f33b7a5.tza',
  originalFile: 'rt_hdr_calb_cnrm_large.tza',
  bytes: 7698439,
  sha256: '08130cdc4f33b7a513d0073757f089ac830f900613bb5bad72ca42c52b934465',
  commit: '28883d1769d5930e13cf7f1676dd852bd81ed9e7',
  license: 'Apache-2.0',
});

export interface OIDNStaticOptions {
  renderer: WebGPURenderer;
  scene?: Scene;
  camera?: PerspectiveCamera;
  /** A same-origin build asset. No implicit CDN, model service, or network backend. */
  weightsUrl: string | URL;
  /** Bounded FP32 tiles; the full image is retained at the requested resolution. */
  maxTileSize?: number;
}
export interface OIDNStaticDenoiser extends StaticDenoiser {
  inspect(): { state: 'idle' | 'loading' | 'running' | 'complete' | 'error'; precision: 'fp32'; model: string; error?: string; runtime?: ReturnType<UNet['getRuntimeInfo']> };
}

export async function verifyOIDNWeights(bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength !== OIDN_LARGE_WEIGHTS.bytes) throw new Error(`OIDN weight size mismatch: expected ${OIDN_LARGE_WEIGHTS.bytes}, got ${bytes.byteLength}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== OIDN_LARGE_WEIGHTS.sha256) throw new Error('OIDN weight SHA-256 mismatch');
}

/** Clean-guided local OIDN, sharing the native renderer's device and always using FP32. */
export function createOIDNStaticDenoiser(options: OIDNStaticOptions): OIDNStaticDenoiser {
  const { renderer } = options;
  const tileSize = options.maxTileSize ?? 256;
  if (!Number.isSafeInteger(tileSize) || tileSize < 16 || tileSize > 512) throw new RangeError('OIDN maxTileSize must be an integer from 16 to 512');
  const backend = renderer.backend as typeof renderer.backend & { device?: GPUDevice; get(texture: Texture): { texture: GPUTexture } };
  const device = backend.device;
  if (!device) throw new Error('OIDN requires an initialized native WebGPU renderer');
  const url = new URL(String(options.weightsUrl), globalThis.location?.href);
  if (globalThis.location && url.origin !== location.origin) throw new Error('OIDN weights must be a same-origin build asset');
  let disposed = false, generation = 0, model: UNet | undefined, modelPromise: Promise<UNet> | undefined;
  let loadGeneration = 0;
  const pendingLoads = new Set<Promise<UNet>>();
  let guides: RenderTarget | undefined, output: ExternalTexture | undefined, gpuTexture: GPUTexture | undefined, copyPipeline: GPUComputePipeline | undefined;
  let abortExecution: (() => void) | undefined, rejectExecution: ((reason: unknown) => void) | undefined, loadAbort: AbortController | undefined;
  let state: 'idle' | 'loading' | 'running' | 'complete' | 'error' = 'idle', failure: Error | undefined;

  async function load(signal: AbortSignal): Promise<UNet> {
    if (model) return model;
    if (!modelPromise) {
      const captured = ++loadGeneration;
      loadAbort = new AbortController();
      const cancel = (): void => loadAbort?.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      modelPromise = (async () => {
        state = 'loading';
        const response = await fetch(url, { signal: loadAbort!.signal });
        if (!response.ok) throw new Error(`OIDN weights HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        signal.throwIfAborted(); await verifyOIDNWeights(data); signal.throwIfAborted();
        const unet = await initUNetFromBuffer(data, { device: device! }, {
          aux: true, hdr: true, hdrTransfer: 'pu', engine: 'wgsl', precision: 'fp32',
          maxTileSize: tileSize, dynamicTile: false, modelSpec: OIDN_UNET_LARGE_SPEC,
        });
        if (disposed || captured !== loadGeneration || signal.aborted) { unet.dispose(); throw new DOMException('OIDN initialization cancelled', 'AbortError'); }
        model = unet; return unet;
      })().catch(error => { if (captured === loadGeneration) modelPromise = undefined; throw error; }).finally(() => {
        signal.removeEventListener('abort', cancel); if (captured === loadGeneration) loadAbort = undefined;
      });
      const pending = modelPromise; pendingLoads.add(pending);
      void pending.then(() => pendingLoads.delete(pending), () => pendingLoads.delete(pending));
    }
    return modelPromise;
  }

  function renderGuides(scene: Scene, camera: PerspectiveCamera, width: number, height: number): [Texture, Texture] {
    if (!guides) {
      guides = new RenderTarget(1, 1, { count: 2, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, samples: 4 });
      guides.textures[0].name = 'output'; guides.textures[1].name = 'normal';
    }
    guides.setSize(width, height);
    const target = renderer.getRenderTarget(), previousMRT = renderer.getMRT(), toneMapping = renderer.toneMapping, colorSpace = renderer.outputColorSpace;
    const background = scene.background, fog = scene.fog;
    const clearColor = renderer.getClearColor(new Color()), clearAlpha = renderer.getClearAlpha();
    try {
      // Clean deterministic albedo + view-space normals encoded [0,1], matching
      // oidn-web's input conversion. No lighting, display transform, or grain.
      scene.background = null; scene.fog = null;
      renderer.toneMapping = NoToneMapping; renderer.outputColorSpace = LinearSRGBColorSpace;
      renderer.setClearColor(0, 1); renderer.setRenderTarget(guides);
      renderer.setMRT(mrt({ output: diffuseColor, normal: vec4(normalView.mul(0.5).add(0.5), 1) }));
      renderer.render(scene, camera);
      return [guides.textures[0], guides.textures[1]];
    } finally {
      renderer.setMRT(previousMRT); renderer.setRenderTarget(target);
      renderer.toneMapping = toneMapping; renderer.outputColorSpace = colorSpace;
      renderer.setClearColor(clearColor, clearAlpha); scene.background = background; scene.fog = fog;
    }
  }

  function copyOutput(data: GPUBuffer, width: number, height: number): ExternalTexture {
    if (!copyPipeline) {
      copyPipeline = device!.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: device!.createShaderModule({ code: `
        @group(0) @binding(0) var<storage, read> source: array<vec4f>;
        @group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
        @compute @workgroup_size(8,8)
        fn main(@builtin(global_invocation_id) id:vec3u) {
          let size=textureDimensions(destination);
          if(id.x<size.x && id.y<size.y) { textureStore(destination,id.xy,source[id.y*size.x+id.x]); }
        }` }) } });
    }
    if (!gpuTexture || gpuTexture.width !== width || gpuTexture.height !== height) {
      output?.dispose(); gpuTexture?.destroy();
      gpuTexture = device!.createTexture({ size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      output = new ExternalTexture(gpuTexture); (output as Texture).image = { width, height }; output.colorSpace = LinearSRGBColorSpace;
    }
    const bindings = device!.createBindGroup({ layout: copyPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: data } }, { binding: 1, resource: gpuTexture.createView() },
    ] });
    const encoder = device!.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(copyPipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    device!.queue.submit([encoder.finish()]);
    return output!;
  }

  function reset(): void {
    generation++; loadAbort?.abort(); abortExecution?.(); abortExecution = undefined;
    if (loadAbort) { loadGeneration++; modelPromise = undefined; loadAbort = undefined; }
    rejectExecution?.(new DOMException('Static denoising cancelled', 'AbortError')); rejectExecution = undefined;
    output?.dispose(); output = undefined; gpuTexture?.destroy(); gpuTexture = undefined;
    state = 'idle'; failure = undefined;
  }

  return {
    async denoise(frame: StaticDenoiseFrame) {
      if (disposed) throw new Error('OIDN denoiser disposed');
      if (state === 'loading' || state === 'running') throw new Error('OIDN denoising already running');
      const captured = generation;
      try {
        frame.signal.throwIfAborted();
        const unet = await load(frame.signal); frame.signal.throwIfAborted();
        if (captured !== generation || disposed) throw new DOMException('Stale OIDN request', 'AbortError');
        const scene = frame.scene ?? options.scene, camera = frame.camera ?? options.camera;
        if (!scene || !camera) throw new Error('OIDN requires the prepared PBR scene and matching camera');
        const { width, height } = frame.color;
        const [albedo, normal] = renderGuides(scene, camera, width, height);
        renderer.initTexture(frame.color); renderer.initTexture(albedo); renderer.initTexture(normal);
        state = 'running';
        return await new Promise<Texture>((resolve, reject) => {
          let settled = false;
          const finish = (reason?: unknown, texture?: Texture): void => {
            if (settled) return; settled = true;
            frame.signal.removeEventListener('abort', cancel); abortExecution = undefined; rejectExecution = undefined;
            if (reason) reject(reason); else resolve(texture!);
          };
          const cancel = (): void => { abortExecution?.(); finish(frame.signal.reason ?? new DOMException('OIDN cancelled', 'AbortError')); };
          rejectExecution = reason => finish(reason);
          frame.signal.addEventListener('abort', cancel, { once: true });
          try {
            abortExecution = unet.tileExecute({
              color: { data: backend.get(frame.color).texture, width, height },
              albedo: { data: backend.get(albedo).texture, width, height },
              normal: { data: backend.get(normal).texture, width, height },
              scheduling: 'animation-frame',
              done: result => {
                try {
                  if (frame.signal.aborted || captured !== generation || disposed) { finish(new DOMException('Stale OIDN output', 'AbortError')); return; }
                  const texture = copyOutput(result.data, width, height); state = 'complete'; finish(undefined, texture);
                } catch (error) { finish(error); }
              },
              error: reason => finish(reason),
            });
          } catch (error) { finish(error); }
        });
      } catch (error) {
        if (captured === generation && !frame.signal.aborted) { failure = error instanceof Error ? error : new Error(String(error)); state = 'error'; }
        throw error;
      }
    },
    reset,
    inspect() { return { state, precision: 'fp32', model: OIDN_LARGE_WEIGHTS.originalFile, ...(failure ? { error: failure.message } : {}), ...(model ? { runtime: model.getRuntimeInfo() } : {}) }; },
    async dispose() {
      if (disposed) return; disposed = true; reset();
      await Promise.allSettled(pendingLoads);
      try { await device!.queue.onSubmittedWorkDone(); } catch { /* Device loss. */ }
      model?.dispose(); model = undefined; modelPromise = undefined; guides?.dispose(); guides = undefined;
    },
  };
}
