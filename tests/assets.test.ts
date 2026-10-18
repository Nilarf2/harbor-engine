import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AnimationClip, BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Actor, AssetManager, assertEmbeddedGLB, disposeObject } from '../src/assets/index.js';
import type { AssetHandle } from '../src/assets/index.js';

test('shared load survives one consumer cancellation and is freed after the last owner', async () => {
  const manager = new AssetManager(); let loads = 0, frees = 0;
  let resolve!: (value: object) => void;
  manager.register('model', { load() { loads++; return new Promise(r => { resolve = r; }); }, dispose() { frees++; } });
  const abort = new AbortController();
  const a = manager.acquire('model', 'test', abort.signal);
  const b = manager.acquire('model', 'test');
  await Promise.resolve(); abort.abort(); resolve({ ready: true });
  await assert.rejects(a); const handle = await b;
  assert.equal(loads, 1); assert.equal(frees, 0);
  handle.release(); handle.release(); assert.equal(frees, 1); assert.equal(manager.size, 0);
});

test('a late load is disposed when its lifetime has ended', async () => {
  const manager = new AssetManager(); let frees = 0;
  let resolve!: (v: object) => void;
  manager.register('slow', { load() { return new Promise(r => { resolve = r; }); }, dispose() { frees++; } });
  const a = manager.acquire('slow', 'test');
  await Promise.resolve(); manager.dispose(); resolve({});
  await assert.rejects(a); assert.equal(frees, 1); assert.equal(manager.size, 0);
});

test('embedded mannequin GLB is accepted and malformed input rejected before parsing', async () => {
  const data = await readFile(new URL('../public/models/mannequin.glb', import.meta.url));
  assert.doesNotThrow(() => assertEmbeddedGLB(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  assert.throws(() => assertEmbeddedGLB(new ArrayBuffer(32)), /GLB|glTF/);
});

test('disposal promptly rejects a pending loader which ignores cancellation, then frees its late result', async () => {
  const manager = new AssetManager();
  let finish!: (value: object) => void, frees = 0;
  manager.register('slow', { load: () => new Promise(resolve => { finish = resolve; }), dispose: () => { frees++; } });
  const pending = manager.acquire('slow', 'object');
  await Promise.resolve();
  manager.dispose();
  await assert.rejects(pending, /abort/i);
  finish({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frees, 1);
  assert.equal(manager.size, 0);
});

test('asset disposal attempts every owner, handles undefined resources, and runs once after failure', async () => {
  const manager = new AssetManager();
  let badFrees = 0, goodFrees = 0, emptyFrees = 0;
  manager.register('bad', { load: async () => ({}), dispose: () => { badFrees++; throw new Error('bad cleanup'); } });
  manager.register('good', { load: async () => ({}), dispose: () => { goodFrees++; } });
  manager.register('empty', { load: async () => undefined, dispose: () => { emptyFrees++; } });
  const handles = await Promise.all([manager.acquire('bad', 'a'), manager.acquire('good', 'b'), manager.acquire('empty', 'c')]);
  assert.throws(() => manager.dispose(), /Asset cleanup failed/);
  assert.equal(badFrees, 1); assert.equal(goodFrees, 1); assert.equal(emptyFrees, 1);
  assert.equal(manager.size, 0);
  manager.dispose();
  for (const handle of handles) handle.release();
  assert.equal(badFrees, 1); assert.equal(goodFrees, 1); assert.equal(emptyFrees, 1);
  assert.throws(() => manager.register('late', { load: async () => null, dispose() {} }), /disposed/);
});

test('asset cache keys cannot collide across type and URL boundaries', async () => {
  const manager = new AssetManager();
  manager.register('a:b', { load: async () => 'first', dispose() {} });
  manager.register('a', { load: async () => 'second', dispose() {} });
  const first = await manager.acquire('a:b', 'c');
  const second = await manager.acquire('a', 'b:c');
  assert.equal(first.value, 'first'); assert.equal(second.value, 'second');
  first.release(); second.release(); manager.dispose();
});

test('actor clones share template assets while teardown releases handles despite listener failure', () => {
  const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
  const scene = new Group(); scene.add(new Mesh(geometry, material), new Mesh(geometry, material));
  let geometryFrees = 0, materialFrees = 0, releases = 0, childFrees = 0;
  geometry.addEventListener('dispose', () => { geometryFrees++; });
  material.addEventListener('dispose', () => { materialFrees++; });
  const actor = new Actor('first', { scene, animations: [] }, () => { releases++; });
  const other = new Actor('second', { scene, animations: [] }, () => { releases++; });
  actor.root.children[1].addEventListener('dispose', () => { childFrees++; });
  actor.root.addEventListener('dispose', () => { actor.root.clear(); throw new Error('listener failure'); });
  assert.throws(() => actor.dispose(), /cleanup failed/);
  assert.equal(childFrees, 1); assert.equal(releases, 1);
  assert.equal(geometryFrees, 0); assert.equal(materialFrees, 0);
  assert.equal((other.root.children[0] as Mesh).geometry, geometry);
  actor.dispose(); other.dispose();
  assert.equal(releases, 2);
  disposeObject(scene);
  assert.equal(geometryFrees, 1); assert.equal(materialFrees, 1);
});

test('actor construction failure releases the acquired handle', () => {
  let releases = 0;
  const handle = { value: { scene: null, animations: [] }, release: () => { releases++; } } as unknown as AssetHandle<GLTF>;
  assert.throws(() => Actor.fromHandle('broken', handle));
  assert.equal(releases, 1);
});

test('actor teardown removes owned animation event listeners', () => {
  const clip = new AnimationClip('idle', 1, []);
  const actor = new Actor('animation', { scene: new Group(), animations: [clip] });
  const action = actor.mixer.clipAction(clip);
  let callbacks = 0;
  actor.onFinished(() => { callbacks++; });
  actor.mixer.dispatchEvent({ type: 'finished', action, direction: 1 });
  assert.equal(callbacks, 1);
  actor.dispose();
  actor.mixer.dispatchEvent({ type: 'finished', action, direction: 1 });
  assert.equal(callbacks, 1);
  assert.throws(() => actor.onFinished(() => {}), /disposed/);
});

test('template disposal deduplicates resources across scenes and finishes after listener errors', () => {
  const geometry = new BoxGeometry(), texture = new Texture(), material = new MeshBasicMaterial({ map: texture });
  const a = new Group(), b = new Group();
  a.add(new Mesh(geometry, material)); b.add(new Mesh(geometry, material));
  let geometryFrees = 0, materialFrees = 0, textureFrees = 0, imageCloses = 0;
  texture.source.data = { close() { imageCloses++; } };
  geometry.addEventListener('dispose', () => { geometryFrees++; });
  material.addEventListener('dispose', () => { materialFrees++; throw new Error('material listener'); });
  texture.addEventListener('dispose', () => { textureFrees++; });
  a.addEventListener('dispose', () => { throw new Error('object listener'); });
  assert.throws(() => disposeObject([a, b]), /cleanup failed/);
  assert.equal(geometryFrees, 1); assert.equal(materialFrees, 1); assert.equal(textureFrees, 1); assert.equal(imageCloses, 1);
});
