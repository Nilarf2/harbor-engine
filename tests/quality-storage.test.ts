import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import type { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
// @ts-expect-error Locked upstream packing class has no public declaration.
import { PathtracerBVHComputeData } from 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js';
import { PreparedQualityScene } from '../src/pathtracing/prepare-scene.js';
import { OwnedPathTracingBVH } from '../src/pathtracing/owned-bvh.js';

test('retiring a real native pack deletes every owned GPU attribute and breaks retained CPU references', () => {
  const source = new Scene(), geometry = new BoxGeometry(), material = new MeshStandardMaterial(); source.add(new Mesh(geometry, material));
  const prepared = new PreparedQualityScene(source), data = new PathtracerBVHComputeData(prepared.scene); data.update();
  const attributes = Object.values(data.storage as Record<string, { value: BufferAttribute }>).map(node => node.value);
  const bytes = attributes.map(attribute => attribute.array.byteLength), deleted = new Map<BufferAttribute, number>();
  const renderer = { _attributes: { delete(attribute: BufferAttribute) { deleted.set(attribute, attribute.array.byteLength); } } } as unknown as WebGPURenderer;
  const ownership = new OwnedPathTracingBVH(renderer), sourceArray = geometry.getAttribute('position').array;
  let sourceDisposals = 0; material.addEventListener('dispose', () => sourceDisposals++); geometry.addEventListener('dispose', () => sourceDisposals++);
  ownership.release(data); ownership.release(data);
  assert.equal(deleted.size, 5);
  assert.deepEqual(attributes.map(attribute => deleted.get(attribute)), bytes, 'accounting observes bytes before CPU arrays are cleared');
  assert.ok(attributes.every(attribute => attribute.array.byteLength === 0));
  assert.deepEqual(data.storage, {}, 'a normally retired pack keeps no storage-node wrappers');
  assert.deepEqual(data.objects, []); assert.equal(data.bvh, undefined); assert.equal(data.bvhMap.size, 0); assert.equal(data._bvhCache.size, 0);
  assert.equal(geometry.getAttribute('position').array, sourceArray); assert.ok(sourceArray.byteLength > 0); assert.equal(sourceDisposals, 0);
  const privateScene = prepared.scene; prepared.dispose(); assert.equal(privateScene.children.length, 0);
  geometry.dispose(); material.dispose();
});

test('a staged native packing failure releases partial buffers and latches a safely disposable owner', () => {
  const deleted: BufferAttribute[] = [], attribute = new BufferAttribute(new Uint32Array(16), 1);
  const renderer = { _attributes: { delete(value: BufferAttribute) { deleted.push(value); } } } as unknown as WebGPURenderer;
  let disposed = 0, atlasDisposed = 0;
  const next = { storage: { partial: { value: attribute } }, objects: [new Scene()], textures: [],
    textureAtlas: { setTextures() {}, dispose() { atlasDisposed++; } },
    dispose() { disposed++; }, update() { throw new RangeError('simulated ArrayBuffer allocation failure'); } };
  const ownership = new OwnedPathTracingBVH(renderer, () => next);
  const tracer = { _pathTracer: { setBVHData() {} }, dispose() {}, setCamera() {}, updateEnvironment() {}, updateLights() {} } as unknown as WebGPUPathTracer;
  assert.throws(() => ownership.setScene(tracer, new Scene(), new PerspectiveCamera()), /allocation failure/);
  assert.deepEqual(deleted, [attribute]); assert.equal(attribute.array.byteLength, 0); assert.deepEqual(next.objects, []);
  ownership.disposeTracer(tracer); assert.equal(disposed, 1); assert.equal(atlasDisposed, 1);
  assert.deepEqual(next.storage, {}, 'a staged pack with successful attribute retirement is empty');
});

test('scene refresh installs one pack into tracer, kernel, camera-ray function, and atlas bindings', () => {
  const renderer = { _attributes: { delete() {} } } as unknown as WebGPURenderer;
  const cameraRay = {}, data: { storage: Record<string, never>; textures: unknown[]; fns: { getCameraRay?: unknown };
    textureAtlas: { setTextures(): void; dispose(): void }; dispose(): void; update(): void } = {
    storage: {}, textures: [], fns: {}, textureAtlas: { setTextures() {}, dispose() {} }, dispose() {}, update() {},
  };
  const state: { _bvhData?: typeof data; _pathTracer: { kernel: { bvhData?: typeof data }; setBVHData(value: typeof data): void };
    _cameraRayFnHandle: { fn: unknown }; setCamera(camera: PerspectiveCamera): void; updateEnvironment(): void; updateLights(): void;
    dispose(): void; textureAtlas?: typeof data.textureAtlas } = {
    _pathTracer: { kernel: {}, setBVHData(value) { this.kernel.bvhData = value; } },
    _cameraRayFnHandle: { fn: cameraRay },
    setCamera() { this._bvhData!.fns.getCameraRay = cameraRay; }, updateEnvironment() {}, updateLights() {}, dispose() {},
    get textureAtlas() { return this._bvhData?.textureAtlas; },
  };
  const tracer = state as unknown as WebGPUPathTracer;
  const ownership = new OwnedPathTracingBVH(renderer, () => data);
  ownership.setScene(tracer, new Scene(), new PerspectiveCamera());
  const installed = (tracer as unknown as { _bvhData: typeof data; _pathTracer: { kernel: { bvhData: typeof data } } })._bvhData;
  assert.equal(installed, data);
  assert.equal((tracer as unknown as { _pathTracer: { kernel: { bvhData: typeof data } } })._pathTracer.kernel.bvhData, installed);
  assert.equal(data.fns.getCameraRay, cameraRay);
  assert.equal(tracer.textureAtlas, data.textureAtlas);
  ownership.disposeTracer(tracer);
});

test('release attempts atlas, every GPU attribute, and tracer disposal after cleanup failures', () => {
  const first = new BufferAttribute(new Uint8Array(8), 1), second = new BufferAttribute(new Uint8Array(16), 1);
  const deletes: BufferAttribute[] = [];
  const renderer = { _attributes: { delete(value: BufferAttribute) { deletes.push(value); if (value === first) throw new Error('delete first'); } } } as unknown as WebGPURenderer;
  let atlasDisposed = 0, tracerDisposed = 0;
  const data = { storage: { first: { value: first }, second: { value: second } }, textures: [],
    textureAtlas: { setTextures() {}, dispose() { atlasDisposed++; throw new Error('atlas dispose'); } },
    dispose() { throw new Error('pack dispose'); }, update() {} };
  const tracer = { _pathTracer: { lightsInfo: undefined }, _bvhData: data, dispose() { tracerDisposed++; throw new Error('tracer dispose'); } } as unknown as WebGPUPathTracer;
  const ownership = new OwnedPathTracingBVH(renderer);
  assert.throws(() => ownership.disposeTracer(tracer), AggregateError);
  assert.deepEqual(deletes, [first, second]);
  assert.equal(second.array.byteLength, 0, 'successful buffers are cleared despite neighboring failures');
  assert.equal(first.array.byteLength, 8, 'failed deletion retains backing bytes so it can be retried');
  assert.equal((data.storage.first?.value), first, 'only the failed attribute remains owned for retry');
  assert.equal(data.storage.second, undefined, 'successful attributes leave no storage wrapper');
  assert.equal(atlasDisposed, 1); assert.equal(tracerDisposed, 1);
});
