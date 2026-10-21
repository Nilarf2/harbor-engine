import { Box3, type BufferAttribute, type Camera, type Scene, type SkinnedMesh, type WebGPURenderer } from 'three/webgpu';
import { MeshBVH, SAH, SkinnedMeshBVH } from 'three-mesh-bvh';
import type { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
// @ts-expect-error Pinned upstream internal class has no declaration file.
import { PathtracerBVHComputeData } from 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js';
// @ts-expect-error Pinned upstream internal geometry helper has no declaration file.
import { setCommonAttributes } from 'three-gpu-pathtracer/src/core/utils/GeometryPreparationUtils.js';

interface PackedData {
  storage: Record<string, { value?: BufferAttribute }>;
  textureAtlas: { setTextures(renderer: WebGPURenderer, textures: unknown[]): void; dispose(): void };
  textures: unknown[];
  fns?: { getCameraRay?: unknown };
  materials?: unknown[];
  bvh?: unknown;
  bvhMap?: Map<unknown, unknown>;
  materialsMap?: Map<unknown, unknown>;
  _bvhCache?: Map<unknown, unknown>;
  objects?: unknown[];
  dispose(): void;
  update(): void;
}
interface NativeInternals {
  scene?: Scene;
  _bvhData?: PackedData;
  _pathTracer: { setBVHData(data: PackedData): void; lightsInfo?: { buffer?: BufferAttribute }; kernel?: { bvhData?: PackedData } };
  _cameraRayFnHandle?: { fn: unknown };
  _denoiser?: { setScene(scene: Scene, camera: Camera): void };
  generateMissingAttributes: boolean;
  commonAttributes: string[];
}
type RendererInternals = { _attributes?: { delete(attribute: BufferAttribute): unknown } };

/**
 * Compatibility boundary for three 0.186.1 and the locked native tracer revision.
 * Compute-only storage attributes do not have Three's geometry disposal listener.
 * Upstream also allocates a new CPU pack before retiring the old one. Keep this
 * workaround scoped to the tracer's own pack, never the borrowed scene/device.
 */
export class OwnedPathTracingBVH {
  private released = new WeakSet<object>();
  private releasedAttributes = new WeakSet<object>();
  constructor(private renderer: WebGPURenderer, private createData: (scene: Scene) => PackedData = scene => new PathtracerBVHComputeData(scene)) {
    if (!(renderer as unknown as RendererInternals)._attributes?.delete) throw new Error('Pinned renderer storage retirement API is unavailable');
  }

  release(data?: PackedData): void {
    if (!data || this.released.has(data)) return;
    const attributes = new Set(Object.values(data.storage).map(node => node.value).filter((value): value is BufferAttribute => Boolean(value)));
    const errors: unknown[] = [], failed = new Set<BufferAttribute>();
    try { data.dispose(); } catch (error) { errors.push(error); }
    try { data.textureAtlas.dispose(); } catch (error) { errors.push(error); }
    for (const attribute of attributes) {
      try { this.releaseAttribute(attribute); } catch (error) { errors.push(error); failed.add(attribute); }
    }
    // Retired TSL/compiler nodes can outlive the view. Remove their strong CPU
    // backing references too; a GPU destroy event alone does not release them.
    const retainedStorage: Record<string, { value?: BufferAttribute }> = {};
    for (const [key, node] of Object.entries(data.storage)) {
      if (node.value && failed.has(node.value)) retainedStorage[key] = node;
    }
    // The normal path retains no storage-node wrappers. If one renderer
    // deletion failed, keep only that node so a later retry still has an owner.
    data.storage = retainedStorage;
    data.bvh = undefined; data.bvhMap?.clear(); data.materialsMap?.clear();
    data._bvhCache?.clear(); data.objects = []; data.textures = []; data.materials = [];
    if (errors.length) throw new AggregateError(errors, 'Failed to retire all owned path-tracing resources');
    this.released.add(data);
  }

  private releaseAttribute(attribute?: BufferAttribute): void {
    if (!attribute || this.releasedAttributes.has(attribute)) return;
    // Delete before clearing arrays so renderer.info subtracts the original bytes.
    (this.renderer as unknown as RendererInternals)._attributes!.delete(attribute);
    const ArrayType = attribute.array.constructor as new (length: number) => BufferAttribute['array'];
    attribute.array = new ArrayType(0); (attribute as unknown as { count: number }).count = 0;
    this.releasedAttributes.add(attribute);
  }

  updateLights(tracer: WebGPUPathTracer): void {
    const native = tracer as unknown as NativeInternals, previous = native._pathTracer.lightsInfo?.buffer;
    tracer.updateLights();
    if (previous !== native._pathTracer.lightsInfo?.buffer) this.releaseAttribute(previous);
  }

  disposeTracer(tracer: WebGPUPathTracer): void {
    const native = tracer as unknown as NativeInternals;
    const errors: unknown[] = [];
    try { this.release(native._bvhData); } catch (error) { errors.push(error); }
    try { this.releaseAttribute(native._pathTracer.lightsInfo?.buffer); } catch (error) { errors.push(error); }
    // Upstream dispose assumes setScene succeeded, including on constructor errors.
    // The real pack was already retired above, so hand upstream an empty owner to
    // keep its own teardown from disposing the same atlas and storage twice.
    const emptyPack: PackedData = { storage: {}, textures: [], update() {}, dispose() {}, textureAtlas: { setTextures() {}, dispose() {} } };
    native._bvhData = emptyPack;
    if (native._pathTracer.kernel) native._pathTracer.kernel.bvhData = emptyPack;
    try { tracer.dispose(); } catch (error) { errors.push(error); }
    finally {
      native.scene = undefined; native._bvhData = undefined;
      if (native._pathTracer.kernel) native._pathTracer.kernel.bvhData = undefined;
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose all owned path-tracing resources');
  }

  setScene(tracer: WebGPUPathTracer, scene: Scene, camera: Camera): void {
    const native = tracer as unknown as NativeInternals;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld();
    // All geometry here belongs to PreparedQualityScene, so generation/BVH state
    // remains private even when application geometry and actors share bind data.
    scene.traverse(object => {
      const mesh = object as SkinnedMesh & { isMesh?: boolean; boundsTree?: SkinnedMeshBVH };
      if (native.generateMissingAttributes && mesh.geometry?.isBufferGeometry) setCommonAttributes(mesh.geometry, native.commonAttributes);
      if (mesh.isSkinnedMesh) {
        if (!mesh.boundsTree) mesh.boundsTree = new SkinnedMeshBVH(mesh, { strategy: SAH, targetLeafSize: 5, indirect: true });
        else mesh.boundsTree.refit();
        mesh.boundingBox ??= new Box3(); mesh.boundsTree.getBoundingBox(mesh.boundingBox);
      } else if (mesh.isMesh) {
        const geometry = mesh.geometry as typeof mesh.geometry & { boundsTree?: MeshBVH };
        geometry.boundsTree ??= new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5 });
      }
    });
    // Previous submissions have already been enqueued; no compute is submitted
    // inside this synchronous swap. WebGPU retires their GPU use safely on destroy.
    this.release(native._bvhData);
    const next = this.createData(scene);
    try {
      next.update(); next.textureAtlas.setTextures(this.renderer, next.textures);
      native._bvhData = next; native.scene = scene; native._pathTracer.setBVHData(next);
      tracer.setCamera(camera);
      tracer.updateEnvironment(); this.updateLights(tracer);
      native._denoiser?.setScene(scene, camera);
      if (native._bvhData !== next || native._pathTracer.kernel && native._pathTracer.kernel.bvhData !== next || (tracer.textureAtlas as unknown as PackedData['textureAtlas']) !== next.textureAtlas) {
        throw new Error('Pinned path tracer BVH bindings do not reference the installed scene pack');
      }
      // `wgslTagFn` is a shader-node object rather than a JavaScript function;
      // only assert that the camera ray entry is present after setCamera().
      if (native._cameraRayFnHandle && next.fns?.getCameraRay == null) {
        throw new Error('Pinned path tracer camera ray function is not installed on the scene pack');
      }
    } catch (error) {
      // Even update()/atlas failures before assignment have a reachable owner.
      native._bvhData = next;
      try { this.release(next); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Scene packing and staged resource cleanup both failed');
      }
      throw error;
    }
  }
}
