import { buildBVH, finiteVec3, refitBVH } from './bvh.js';
import { PRESENT_SHADER, TRACE_SHADER } from './shader.js';
import type {
  BuiltBVH, PathTracer, PathTracerOptions, PathTracerStats, TraceCamera,
  TraceEnvironment, TraceScene, TraceVec3,
} from './types.js';

export { buildBVH, refitBVH } from './bvh.js';
export { fromWorld } from './from-world.js';
export { fromThreeScene } from './from-three.js';
export type { FromThreeOptions } from './from-three.js';
export type { WorldTraceOptions } from './from-world.js';
export type * from './types.js';

function normalized(value: TraceVec3, label: string): TraceVec3 {
  finiteVec3(value, label);
  const scale = Math.max(...value.map(Math.abs));
  if (scale < 1e-8) throw new RangeError(`${label} must have a non-zero length.`);
  const scaled = value.map(n => n / scale);
  const length = Math.hypot(...scaled);
  return scaled.map(n => n / length) as TraceVec3;
}

function cross(a: TraceVec3, b: TraceVec3): TraceVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function nonnegative(value: TraceVec3, label: string, maximum = 1e6): void {
  finiteVec3(value, label);
  if (value.some(n => n < 0 || n > maximum)) throw new RangeError(`${label} must be in [0, ${maximum}].`);
}

const defaultEnvironment: Required<TraceEnvironment> = {
  skyTop: [0.25, 0.5, 0.85], skyHorizon: [0.85, 0.93, 1], ground: [0.15, 0.2, 0.18],
  sunDirection: [0.45, 0.8, 0.35], sunColor: [1, 0.91, 0.76], sunIntensity: 3.5, sunAngularRadius: 0.009,
};

/**
 * Independent WebGPU compute path tracer. Initialization requires a WebGPU adapter;
 * callers choose their own raster fallback when one is unavailable.
 */
export async function createPathTracer(options: PathTracerOptions): Promise<PathTracer> {
  const { canvas } = options;
  const gpu = canvas.ownerDocument?.defaultView?.navigator.gpu;
  if (!gpu) throw new Error('Path tracing requires WebGPU in a supported secure-context browser.');
  const maxBounces = options.maxBounces ?? 6;
  if (!Number.isInteger(maxBounces) || maxBounces < 1 || maxBounces > 32) throw new RangeError('maxBounces must be an integer in [1, 32].');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available for compute path tracing.');
  // Opt into the adapter's actual capacity instead of silently keeping minimum limits.
  const device = await adapter.requestDevice({ requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
  } });
  const context = canvas.getContext('webgpu');
  if (!context) { device.destroy(); throw new Error('This canvas could not create a WebGPU context. Use a separate canvas from WebGL.'); }
  let status: PathTracerStats['status'] = 'ready', lastError: string | undefined;
  function fail(error: Error, next: 'error' | 'lost' = 'error'): void {
    if (status === 'disposed') return;
    status = next; lastError = error.message;
    options.onError?.(error);
  }
  device.addEventListener('uncapturederror', event => fail(new Error(`WebGPU validation: ${event.error.message}`)));
  void device.lost.then(info => {
    if (status !== 'disposed') fail(new Error(`WebGPU device lost (${info.reason}): ${info.message}`), 'lost');
  });
  const format = gpu.getPreferredCanvasFormat();
  let computePipeline: GPUComputePipeline, presentPipeline: GPURenderPipeline;
  device.pushErrorScope('validation');
  try {
    const computeModule = device.createShaderModule({ label: 'Harbor path tracing WGSL', code: TRACE_SHADER });
    const presentModule = device.createShaderModule({ label: 'Harbor ACES presentation WGSL', code: PRESENT_SHADER });
    const reports = await Promise.all([computeModule.getCompilationInfo(), presentModule.getCompilationInfo()]);
    const problems = reports.flatMap(report => report.messages.filter(message => message.type === 'error'));
    if (problems.length) throw new Error(`Path tracer shader compilation failed:\n${problems.map(p => `${p.lineNum}:${p.linePos} ${p.message}`).join('\n')}`);
    [computePipeline, presentPipeline] = await Promise.all([
      device.createComputePipelineAsync({ label: 'Harbor BVH path tracing', layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } }),
      device.createRenderPipelineAsync({
        label: 'Harbor path tracer presentation', layout: 'auto',
        vertex: { module: presentModule, entryPoint: 'vertexMain' },
        fragment: { module: presentModule, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    const validation = await device.popErrorScope();
    if (validation) throw new Error(`Path tracer pipeline validation failed: ${validation.message}`);
  } catch (error) {
    // A scope can already be popped when pipeline validation itself fails.
    void device.popErrorScope().catch(() => {});
    status = 'disposed'; device.destroy(); throw error;
  }
  const uniformData = new ArrayBuffer(160);
  const floats = new Float32Array(uniformData), uints = new Uint32Array(uniformData);
  const uniformBuffer = device.createBuffer({ label: 'Harbor trace parameters', size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let width = 1, height = 1, samples = 0;
  let bvh: BuiltBVH = buildBVH([]);
  let triangleBuffer: GPUBuffer | undefined, nodeBuffer: GPUBuffer | undefined, materialBuffer: GPUBuffer | undefined;
  let accumulationBuffer: GPUBuffer | undefined;
  let computeGroup: GPUBindGroup, presentGroup: GPUBindGroup;
  let bufferBytes = 160;
  let sceneBytes = 0, accumulationBytes = 0;
  let materialCount = 1;
  let environment: Required<TraceEnvironment> = { ...defaultEnvironment };
  let camera: Required<TraceCamera> = { position: [12, 8, 16], target: [0, 1, 0], fov: 50, up: [0, 1, 0] };

  function assertReady(): void {
    if (status !== 'ready') throw new Error(lastError ?? `Path tracer is ${status}.`);
  }
  function reset(): void { samples = 0; }
  function upload(data: ArrayBuffer, label: string): GPUBuffer {
    if (data.byteLength > device.limits.maxStorageBufferBindingSize) throw new RangeError(`${label} exceeds the WebGPU storage-buffer limit.`);
    const buffer = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
  }
  function bind(): void {
    if (!triangleBuffer || !nodeBuffer || !materialBuffer || !accumulationBuffer) return;
    computeGroup = device.createBindGroup({
      label: 'Harbor trace bindings', layout: computePipeline.getBindGroupLayout(0),
      entries: [uniformBuffer, triangleBuffer, nodeBuffer, materialBuffer, accumulationBuffer]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    presentGroup = device.createBindGroup({
      label: 'Harbor presentation bindings', layout: presentPipeline.getBindGroupLayout(0),
      entries: [uniformBuffer, accumulationBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    bufferBytes = 160 + sceneBytes + accumulationBytes;
  }

  function setScene(scene: TraceScene): void {
    assertReady();
    if (!scene.materials.length) throw new RangeError('A trace scene requires at least one material.');
    const materialData = new Float32Array(scene.materials.length * 12);
    scene.materials.forEach((material, i) => {
      nonnegative(material.color, `material ${i}.color`, 1);
      const emission = material.emission ?? [0, 0, 0];
      nonnegative(emission, `material ${i}.emission`);
      const metalness = material.metalness ?? 0, roughness = material.roughness ?? 0.7;
      if (![metalness, roughness].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
        throw new RangeError(`material ${i} metalness and roughness must be in [0, 1].`);
      }
      const transmission = material.transmission ?? 0, ior = material.ior ?? 1.5;
      if (!Number.isFinite(transmission) || transmission < 0 || transmission > 1 || !Number.isFinite(ior) || ior < 1 || ior > 3) {
        throw new RangeError(`material ${i}: transmission must be in [0, 1] and ior in [1, 3].`);
      }
      materialData.set([...material.color, metalness, ...emission, roughness, transmission, ior, 0, 0], i * 12);
    });
    for (const triangle of scene.triangles) {
      if ((triangle.material ?? 0) >= scene.materials.length) throw new RangeError('Triangle references a missing material.');
    }
    const nextEnvironment = { ...defaultEnvironment, ...scene.environment };
    for (const key of ['skyTop', 'skyHorizon', 'ground', 'sunColor'] as const) nonnegative(nextEnvironment[key], `environment.${key}`);
    nextEnvironment.sunDirection = normalized(nextEnvironment.sunDirection, 'environment.sunDirection');
    if (!Number.isFinite(nextEnvironment.sunIntensity) || nextEnvironment.sunIntensity < 0 || nextEnvironment.sunIntensity > 1e6) {
      throw new RangeError('sunIntensity must be in [0, 1000000].');
    }
    if (!Number.isFinite(nextEnvironment.sunAngularRadius) || nextEnvironment.sunAngularRadius < 0 || nextEnvironment.sunAngularRadius > 0.2) {
      throw new RangeError('sunAngularRadius must be in [0, 0.2] radians.');
    }
    const nextBVH = buildBVH(scene.triangles);
    let nextTriangles: GPUBuffer | undefined, nextNodes: GPUBuffer | undefined, nextMaterials: GPUBuffer | undefined;
    try {
      nextTriangles = upload(nextBVH.triangleData.buffer as ArrayBuffer, 'Harbor triangles');
      nextNodes = upload(nextBVH.nodeData, 'Harbor BVH nodes');
      nextMaterials = upload(materialData.buffer as ArrayBuffer, 'Harbor materials');
    } catch (error) {
      nextTriangles?.destroy(); nextNodes?.destroy(); nextMaterials?.destroy(); throw error;
    }
    triangleBuffer?.destroy(); nodeBuffer?.destroy(); materialBuffer?.destroy();
    triangleBuffer = nextTriangles; nodeBuffer = nextNodes; materialBuffer = nextMaterials;
    bvh = nextBVH; environment = nextEnvironment;
    materialCount = scene.materials.length;
    sceneBytes = nextBVH.triangleData.byteLength + nextBVH.nodeData.byteLength + materialData.byteLength;
    bind(); reset();
  }

  function updateGeometry(triangles: TraceScene['triangles']): void {
    assertReady();
    for (const triangle of triangles) {
      if ((triangle.material ?? 0) >= materialCount) throw new RangeError('Triangle references a missing material.');
    }
    const revision = bvh.revision;
    refitBVH(bvh, triangles);
    if (revision === bvh.revision) return;
    device.queue.writeBuffer(triangleBuffer!, 0, bvh.triangleData.buffer as ArrayBuffer);
    device.queue.writeBuffer(nodeBuffer!, 0, bvh.nodeData);
    reset();
  }

  function setCamera(next: TraceCamera): void {
    assertReady();
    finiteVec3(next.position, 'camera.position'); finiteVec3(next.target, 'camera.target');
    if ([...next.position, ...next.target].some(n => Math.abs(n) > 1e6)) throw new RangeError('Trace camera coordinates must be within ±1,000,000 world units.');
    const fov = next.fov ?? 50, up = next.up ?? [0, 1, 0];
    if (!Number.isFinite(fov) || fov <= 1 || fov >= 175) throw new RangeError('Camera fov must be between 1 and 175 degrees.');
    const forward = normalized(next.target.map((n, i) => n - next.position[i]) as TraceVec3, 'camera direction');
    const right = cross(forward, normalized(up, 'camera.up'));
    if (Math.hypot(...right) < 1e-6) throw new RangeError('Camera up must not be parallel to its viewing direction.');
    const replacement: Required<TraceCamera> = { position: [...next.position], target: [...next.target], fov, up: [...up] };
    if (JSON.stringify(replacement) === JSON.stringify(camera)) return;
    camera = replacement; reset();
  }

  function resize(nextWidth: number, nextHeight: number): void {
    assertReady();
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) throw new RangeError('Trace resolution must be positive.');
    const w = Math.floor(nextWidth), h = Math.floor(nextHeight);
    if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D || w * h * 16 > device.limits.maxStorageBufferBindingSize) {
      throw new RangeError('Trace resolution exceeds the device limit; reduce render resolution.');
    }
    if (w === width && h === height && accumulationBuffer) return;
    const nextBuffer = device.createBuffer({ label: 'Harbor progressive linear mean', size: w * h * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    accumulationBuffer?.destroy(); accumulationBuffer = nextBuffer;
    width = w; height = h; canvas.width = w; canvas.height = h;
    accumulationBytes = w * h * 16;
    context!.configure({ device, format, alphaMode: 'opaque' });
    bind(); reset();
  }

  function updateUniforms(): void {
    const forward = normalized(camera.target.map((n, i) => n - camera.position[i]) as TraceVec3, 'camera direction');
    const right = normalized(cross(forward, camera.up), 'camera right');
    const up = cross(right, forward);
    floats.set([...camera.position, Math.tan(camera.fov * Math.PI / 360)], 0);
    floats.set([...forward, width / height], 4);
    floats.set([...right, width], 8); floats.set([...up, height], 12);
    uints.set([samples, bvh.triangleCount, bvh.nodeCount, maxBounces], 16);
    floats.set([...environment.skyTop, environment.sunIntensity], 20);
    floats.set([...environment.skyHorizon, environment.sunAngularRadius], 24);
    floats.set([...environment.ground, 1], 28);
    floats.set([...environment.sunDirection, 0], 32);
    floats.set([...environment.sunColor, 0], 36);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  try {
    setScene({ triangles: [], materials: [{ color: [0.8, 0.8, 0.8] }] });
    resize(options.width ?? (canvas.clientWidth || canvas.width || 640), options.height ?? (canvas.clientHeight || canvas.height || 360));
  } catch (error) {
    status = 'disposed'; triangleBuffer?.destroy(); nodeBuffer?.destroy(); materialBuffer?.destroy();
    accumulationBuffer?.destroy(); uniformBuffer.destroy(); device.destroy(); throw error;
  }

  return {
    setScene, updateGeometry, setCamera, resize, reset,
    render() {
      assertReady();
      // Keep integer sample indices exact in both u32 and the floating-point running mean.
      if (samples >= 16_000_000) reset();
      updateUniforms();
      device.pushErrorScope('validation');
      try {
        const encoder = device.createCommandEncoder({ label: `Harbor trace sample ${samples + 1}` });
        const compute = encoder.beginComputePass({ label: 'Ray trace triangles and accumulate' });
        compute.setPipeline(computePipeline); compute.setBindGroup(0, computeGroup);
        compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); compute.end();
        const present = encoder.beginRenderPass({
          label: 'ACES and sRGB presentation',
          colorAttachments: [{ view: context!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        present.setPipeline(presentPipeline); present.setBindGroup(0, presentGroup); present.draw(3); present.end();
        device.queue.submit([encoder.finish()]); samples++;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        void device.popErrorScope().then(error => { if (error) fail(new Error(`Path trace validation failed: ${error.message}`)); });
      }
    },
    inspect() {
      return { backend: 'webgpu-compute', samples, width, height, triangles: bvh.triangleCount, bvhNodes: bvh.nodeCount, bvhDepth: bvh.maxDepth, maxBounces, approximateBufferBytes: bufferBytes, status, ...(lastError ? { error: lastError } : {}) };
    },
    async captureLinear() {
      assertReady();
      if (!samples) throw new Error('Render at least one sample before reading accumulation.');
      const readback = device.createBuffer({ label: 'Harbor trace readback', size: accumulationBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(accumulationBuffer!, 0, readback, 0, accumulationBytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        return result;
      } finally { readback.destroy(); }
    },
    dispose() {
      if (status === 'disposed') return;
      status = 'disposed';
      triangleBuffer?.destroy(); nodeBuffer?.destroy(); materialBuffer?.destroy(); accumulationBuffer?.destroy(); uniformBuffer.destroy();
      context!.unconfigure(); device.destroy();
    },
  };
}
