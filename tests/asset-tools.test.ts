import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO, type GLTF as GLTFJSON } from '@gltf-transform/core';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { type Mesh, type SkinnedMesh } from 'three/webgpu';
import { runAssets } from '../tools/assets.js';
import { disposeObject } from '../src/assets/disposeObject.js';

const source = new URL('../public/models/mannequin.glb', import.meta.url);
const execute = promisify(execFile);

function glb(json: object, binary = new Uint8Array()): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json)), jsonSize = Math.ceil(text.length / 4) * 4;
  const binSize = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(20 + jsonSize + (binSize ? binSize + 8 : 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonSize, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonSize); bytes.set(text, 20);
  if (binSize) { view.setUint32(20 + jsonSize, binSize, true); view.setUint32(24 + jsonSize, 0x004e4942, true); bytes.set(binary, 28 + jsonSize); }
  return bytes;
}

function loadedSnapshot(asset: GLTF) {
  const meshes: object[] = [];
  asset.scene.traverse(object => {
    if (!(object as Mesh).isMesh) return;
    const mesh = object as Mesh;
    meshes.push({ name: mesh.name, data: mesh.userData,
      attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([key, attribute]) => [key, Array.from(attribute.array)])),
      indices: mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null,
      bones: (mesh as SkinnedMesh).isSkinnedMesh ? (mesh as SkinnedMesh).skeleton.bones.map(bone => bone.name) : [],
    });
  });
  return { meshes, animations: asset.animations.map(clip => ({ name: clip.name, duration: clip.duration,
    tracks: clip.tracks.map(track => ({ name: track.name, times: Array.from(track.times), values: Array.from(track.values) })) })) };
}

test('offline lossless output preserves raw metadata, image bytes, geometry, skin and animation in the runtime loader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  try {
    const io = new NodeIO(), original = await io.binaryToJSON(await readFile(source));
    const json = original.json;
    json.extras = { game: { stableId: 'hero', quest: ['intro', 3] } };
    json.asset.extras = { license: 'Original fixture, MIT' };
    for (const collection of [json.nodes, json.meshes, json.materials, json.accessors, json.bufferViews, json.buffers, json.animations]) {
      collection?.forEach((item, index) => { item.extras = { preserved: index, nested: { value: `entry-${index}` } }; });
    }
    json.meshes![0].primitives[0].extras = { targetName: 'body' };
    json.animations![0].channels[0].extras = { event: 'idle' };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
    const bin = original.resources['@glb.bin'];
    const imageOffset = Math.ceil(bin.length / 4) * 4;
    const embedded = new Uint8Array(imageOffset + png.length); embedded.set(bin); embedded.set(png, imageOffset);
    json.images = [{ bufferView: json.bufferViews!.length, mimeType: 'image/png', name: 'Untouched image', extras: { attribution: 'fixture' } }];
    json.bufferViews!.push({ buffer: 0, byteOffset: imageOffset, byteLength: png.length, extras: { imageData: true } });
    json.buffers![0].byteLength = embedded.length;
    const input = join(directory, 'source.glb'), output = join(directory, 'optimized.glb');
    const beforeBytes = glb(json, embedded); await writeFile(input, beforeBytes);
    const report = await runAssets(['optimize', input, output]);
    assert.equal(report.ok, true); assert.equal(report.compressionApplied, true);
    assert.ok(Number(report.savedBytes) > 0);
    assert.deepEqual(await readFile(input), Buffer.from(beforeBytes));
    const afterBytes = await readFile(output), after = await io.binaryToJSON(afterBytes);
    for (const field of ['asset', 'extras', 'nodes', 'scenes', 'meshes', 'accessors', 'materials', 'animations', 'skins', 'images'] as const) {
      assert.deepEqual(after.json[field], json[field], `${field} preserved`);
    }
    assert.deepEqual(after.json.buffers![0].extras, json.buffers![0].extras);
    after.json.bufferViews!.forEach((view, i) => assert.deepEqual(view.extras, json.bufferViews![i].extras));
    const imageView = after.json.bufferViews![after.json.images![0].bufferView!];
    assert.deepEqual(Buffer.from(after.resources['@glb.bin'].subarray(imageView.byteOffset, (imageView.byteOffset ?? 0) + imageView.byteLength)), png);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const beforeModel = await loader.parseAsync(beforeBytes.buffer as ArrayBuffer, '');
    const afterModel = await loader.parseAsync(afterBytes.buffer.slice(afterBytes.byteOffset, afterBytes.byteOffset + afterBytes.byteLength), '');
    try { assert.deepEqual(loadedSnapshot(afterModel), loadedSnapshot(beforeModel)); }
    finally { disposeObject(beforeModel.scene); disposeObject(afterModel.scene); }
    assert.equal((report.after as { validation: { issues: { numErrors: number } } }).validation.issues.numErrors, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('optimizer never overwrites output or source, including concurrent output creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  try {
    const input = join(directory, 'source.glb'), output = join(directory, 'new.glb');
    await writeFile(input, await readFile(source));
    await assert.rejects(runAssets(['optimize', input, input]), /new path/);
    const results = await Promise.allSettled([runAssets(['optimize', input, output]), runAssets(['optimize', input, output])]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const outputBytes = await readFile(output);
    await assert.rejects(runAssets(['optimize', input, output]), /already exists/);
    assert.deepEqual(await readFile(output), outputBytes);
    assert.deepEqual((await readdir(directory)).sort(), ['new.glb', 'source.glb']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('indexed compression preserves triangle corner order and morph target precision exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  try {
    const doc = new Document(), buffer = doc.createBuffer();
    const position = doc.createAccessor('positions').setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const sequence = Uint16Array.from({ length: 1200 }, (_, index) => (index + Math.floor(index / 3)) % 3);
    const indices = doc.createAccessor('exact-indices').setType('SCALAR').setArray(sequence).setBuffer(buffer);
    const deltas = doc.createAccessor('morph-deltas').setType('VEC3').setArray(new Float32Array([0.123456789, 0, 0, 0, -0.0000314159, 0, 0, 0, 0.987654321])).setBuffer(buffer);
    const target = doc.createPrimitiveTarget().setAttribute('POSITION', deltas);
    const primitive = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices).addTarget(target);
    const mesh = doc.createMesh('indexed').addPrimitive(primitive).setWeights([0.25]);
    const node = doc.createNode('stable-name').setMesh(mesh);
    doc.createScene().addChild(node);
    const input = join(directory, 'source.glb'), output = join(directory, 'new.glb');
    const before = await new NodeIO().writeBinary(doc); await writeFile(input, before);
    const report = await runAssets(['optimize', input, output]); assert.equal(report.compressionApplied, true);
    const bytes = await readFile(output);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const model = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    try {
      const loaded = model.scene.getObjectByName('stable-name') as Mesh;
      assert.deepEqual(Array.from(loaded.geometry.index!.array), Array.from(sequence));
      assert.deepEqual(Array.from(loaded.geometry.morphAttributes.position![0].array), Array.from(deltas.getArray()!));
    } finally { disposeObject(model.scene); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline input guards reject external resources and unknown extensions without fetching or writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  const priorFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('unexpected request'); };
  try {
    const input = join(directory, 'source.glb'), output = join(directory, 'new.glb');
    const original = await new NodeIO().binaryToJSON(await readFile(source));
    const json: GLTFJSON.IGLTF = structuredClone(original.json);
    json.images = [{ uri: 'https://example.invalid/private-texture.png' }];
    await writeFile(input, glb(json, original.resources['@glb.bin']));
    await assert.rejects(runAssets(['optimize', input, output]), /external textures/);
    delete json.images;
    json.extensionsUsed = ['VRMC_vrm']; json.extensions = { VRMC_vrm: { specVersion: '1.0' } };
    await writeFile(input, glb(json, original.resources['@glb.bin']));
    await assert.rejects(runAssets(['optimize', input, output]), /Unsupported extensions/);
    assert.equal(networkCalls, 0);
    assert.deepEqual(await readdir(directory), ['source.glb']);
  } finally { globalThis.fetch = priorFetch; await rm(directory, { recursive: true, force: true }); }
});

test('tiny assets retain exact original bytes when compression has no size benefit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  try {
    const input = join(directory, 'source.glb'), output = join(directory, 'new.glb');
    const bytes = glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'empty', extras: { label: 'retain' } }] });
    await writeFile(input, bytes);
    const report = await runAssets(['optimize', input, output]);
    assert.equal(report.compressionApplied, false); assert.equal(report.savedBytes, 0);
    assert.deepEqual(await readFile(output), Buffer.from(bytes));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI inspect emits machine-readable JSON and a failed validation exits unsuccessfully', async () => {
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'tools/assets.ts', 'inspect', 'public/models/mannequin.glb']);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true); assert.equal(report.gpuRequired, false); assert.equal(report.asset.animations.length, 5);
  const directory = await mkdtemp(join(tmpdir(), 'harbor-assets-'));
  try {
    const invalid = join(directory, 'invalid.glb');
    await writeFile(invalid, glb({ asset: { version: '2.0' }, scene: 99 }));
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'tools/assets.ts', 'inspect', invalid]), (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).ok, false); return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
