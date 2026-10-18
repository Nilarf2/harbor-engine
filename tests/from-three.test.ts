import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferGeometry, Color, Float32BufferAttribute, Group, InstancedMesh,
  InterleavedBuffer, InterleavedBufferAttribute, Matrix4, Mesh,
  MeshPhysicalMaterial, MeshStandardMaterial, SkinnedMesh, Texture, Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fromThreeScene } from '../src/raytrace/from-three.js';
import type { TraceVec3 } from '../src/raytrace/types.js';

function triangle(indexed = true): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  if (indexed) geometry.setIndex([0, 1, 2]);
  return geometry;
}
function near(actual: readonly number[], expected: readonly number[], tolerance = 1e-6): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${actual} != ${expected}`);
}
function geometric(a: TraceVec3, b: TraceVec3, c: TraceVec3): number[] {
  return new Vector3().subVectors(new Vector3(...b), new Vector3(...a))
    .cross(new Vector3().subVectors(new Vector3(...c), new Vector3(...a))).normalize().toArray();
}

test('indexed and nonindexed meshes preserve world-space geometry without changing source attributes', () => {
  for (const indexed of [true, false]) {
    const geometry = triangle(indexed);
    const original = Array.from(geometry.getAttribute('position').array);
    const parent = new Group(); parent.position.set(10, 20, 30); parent.rotation.y = Math.PI / 2;
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: '#804020', roughness: 0.35, metalness: 0.8 }));
    mesh.position.set(0, 2, 0); mesh.scale.set(2, 3, 4); parent.add(mesh);
    const scene = fromThreeScene(parent);
    assert.equal(scene.triangles.length, 1);
    const [t] = scene.triangles;
    near(t.a, [10, 22, 30]); near(t.b, [10, 22, 28]); near(t.c, [10, 25, 30]);
    near(t.normalA!, [1, 0, 0]);
    near(scene.materials[0].color, new Color('#804020').toArray());
    assert.equal(scene.materials[0].roughness, 0.35); assert.equal(scene.materials[0].metalness, 0.8);
    assert.deepEqual(Array.from(geometry.getAttribute('position').array), original);
    parent.position.x = 50;
    near(t.a, [10, 22, 30]); // The returned scene is a detached snapshot.
    geometry.dispose(); mesh.material.dispose();
  }
});

test('interleaved attributes and inverse-transpose normals work under nonuniform scale', () => {
  const geometry = new BufferGeometry();
  const n = Math.SQRT1_2;
  const data = new InterleavedBuffer(new Float32Array([0, 0, 0, n, n, 0, 1, 0, 0, n, n, 0, 0, 1, 0, n, n, 0]), 6);
  geometry.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('normal', new InterleavedBufferAttribute(data, 3, 3));
  const mesh = new Mesh(geometry, new MeshStandardMaterial()); mesh.scale.set(2, 1, 3);
  const [t] = fromThreeScene(mesh).triangles;
  near(t.normalA!, [1 / Math.sqrt(5), 2 / Math.sqrt(5), 0]);
  near(t.b, [2, 0, 0]); near(t.c, [0, 1, 0]);
  geometry.dispose(); mesh.material.dispose();
});

test('negative scales preserve outward triangle winding and corresponding normals', () => {
  const mesh = new Mesh(triangle(), new MeshPhysicalMaterial({ transmission: 1, roughness: 0, ior: 1.4 }));
  mesh.scale.set(-2, 3, 1);
  const scene = fromThreeScene(mesh), [t] = scene.triangles;
  near(t.a, [0, 0, 0]); near(t.b, [0, 3, 0]); near(t.c, [-2, 0, 0]);
  near(geometric(t.a, t.b, t.c), [0, 0, 1]);
  near(t.normalB!, [0, 0, 1]);
  assert.equal(scene.materials[0].transmission, 1); assert.equal(scene.materials[0].ior, 1.4);
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('material groups and draw ranges map triangles to the correct PBR factors', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    2, 0, 0, 3, 0, 0, 2, 1, 0,
    4, 0, 0, 5, 0, 0, 4, 1, 0,
  ], 3));
  geometry.addGroup(0, 3, 0); geometry.addGroup(3, 6, 1);
  const red = new MeshStandardMaterial({ color: '#ff0000' });
  const green = new MeshStandardMaterial({ color: '#00ff00', emissive: '#00ff00', emissiveIntensity: 2 });
  const mesh = new Mesh(geometry, [red, green]);
  const all = fromThreeScene(mesh);
  assert.equal(all.triangles.length, 3);
  near(all.materials[all.triangles[0].material!].color, [1, 0, 0]);
  near(all.materials[all.triangles[1].material!].emission!, [0, 2, 0]);
  assert.equal(all.triangles[1].material, all.triangles[2].material);
  geometry.setDrawRange(3, 3);
  const clipped = fromThreeScene(mesh);
  assert.equal(clipped.triangles.length, 1); near(clipped.triangles[0].a, [2, 0, 0]);
  near(clipped.materials[0].color, [0, 1, 0]);
  geometry.dispose(); red.dispose(); green.dispose();
});

test('instances combine parent and instance transforms, colors, and mirrored winding', () => {
  const material = new MeshStandardMaterial({ color: '#ffffff' });
  const instances = new InstancedMesh(triangle(), material, 2);
  instances.position.set(5, 1, 0);
  instances.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
  instances.setMatrixAt(1, new Matrix4().makeScale(-1, 1, 1).setPosition(3, 0, 0));
  instances.setColorAt(0, new Color(1, 0, 0)); instances.setColorAt(1, new Color(0, 0, 1));
  const scene = fromThreeScene(instances);
  assert.equal(scene.triangles.length, 2);
  near(scene.triangles[0].a, [6, 1, 0]); near(scene.triangles[1].a, [8, 1, 0]);
  near(scene.materials[scene.triangles[0].material!].color, [1, 0, 0]);
  near(scene.materials[scene.triangles[1].material!].color, [0, 0, 1]);
  near(geometric(scene.triangles[1].a, scene.triangles[1].b, scene.triangles[1].c), [0, 0, 1]);
  instances.dispose(); instances.geometry.dispose(); material.dispose();
});

test('missing normals get geometric normals and flat shading overrides smooth normals', () => {
  const geometry = triangle(false); geometry.deleteAttribute('normal');
  const material = new MeshStandardMaterial({ flatShading: true });
  const mesh = new Mesh(geometry, material);
  near(fromThreeScene(mesh).triangles[0].normalA!, [0, 0, 1]);
  geometry.setAttribute('normal', new Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  near(fromThreeScene(mesh).triangles[0].normalA!, [0, 0, 1]);
  geometry.dispose(); material.dispose();
});

test('textures and custom nodes fail by default; deliberate approximation emits warnings', () => {
  const texture = new Texture(), material = new MeshStandardMaterial({ map: texture });
  const mesh = new Mesh(triangle(), material);
  assert.throws(() => fromThreeScene(mesh), /textures.*map/);
  const warnings: string[] = [];
  const approximate = fromThreeScene(mesh, { allowUnsupported: true, onWarning: message => warnings.push(message) });
  assert.equal(approximate.triangles.length, 1); assert.ok(warnings.some(message => message.includes('map')));
  const node = new MeshStandardNodeMaterial(), nodeMesh = new Mesh(mesh.geometry, node);
  assert.doesNotThrow(() => fromThreeScene(nodeMesh));
  node.colorNode = color('#ff0000');
  assert.throws(() => fromThreeScene(nodeMesh), /custom shader nodes.*colorNode/);
  node.dispose(); material.dispose(); texture.dispose(); mesh.geometry.dispose();
});

test('skinning and morph geometry are explicitly rejected or skipped, never mistaken for a baked pose', () => {
  const geometry = triangle(), material = new MeshStandardMaterial();
  const skinned = new SkinnedMesh(geometry, material);
  assert.throws(() => fromThreeScene(skinned), /skinning.*bake/i);
  const warnings: string[] = [];
  assert.equal(fromThreeScene(skinned, { allowUnsupported: true, onWarning: message => warnings.push(message) }).triangles.length, 0);
  assert.ok(warnings[0].includes('Skipping'));
  geometry.morphAttributes.position = [geometry.getAttribute('position').clone()];
  assert.throws(() => fromThreeScene(new Mesh(geometry, material)), /morph targets/);
  geometry.dispose(); material.dispose();
});

test('hidden objects are omitted and malformed geometry/transforms fail before BVH upload', () => {
  const geometry = triangle(), material = new MeshStandardMaterial(), mesh = new Mesh(geometry, material);
  const root = new Group(); root.add(mesh); root.visible = false;
  assert.equal(fromThreeScene(mesh).triangles.length, 0);
  root.visible = true; mesh.scale.x = 0;
  assert.throws(() => fromThreeScene(root), /singular/);
  mesh.scale.x = 1; geometry.setIndex([0, 1, 999]);
  assert.throws(() => fromThreeScene(root), /out-of-range vertex/);
  geometry.setIndex([0, 1, 2]); geometry.getAttribute('position').setX(0, Infinity);
  assert.throws(() => fromThreeScene(root), /finite/);
  geometry.dispose(); material.dispose();
});

test('a real embedded GLB static mesh reaches trace triangles with its source precision and material', async () => {
  const vertices = new Float32Array([0.12345678, 0, 0, 1.1234567, 0, 0, 0.12345678, 1, 0]);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, 2, 3] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    buffers: [{ byteLength: vertices.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0.12345678, 0, 0], max: [1.1234567, 1, 0] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.8, 1], metallicFactor: 0.7, roughnessFactor: 0.25 } }],
  });
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const buffer = new ArrayBuffer(12 + 8 + jsonBytes.length + 8 + vertices.byteLength), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonBytes.length).set(jsonBytes);
  const binaryStart = 20 + jsonBytes.length;
  view.setUint32(binaryStart, vertices.byteLength, true); view.setUint32(binaryStart + 4, 0x004e4942, true);
  new Uint8Array(buffer, binaryStart + 8).set(new Uint8Array(vertices.buffer));
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const scene = fromThreeScene(gltf.scene);
  assert.equal(scene.triangles.length, 1);
  near(scene.triangles[0].a, [10 + vertices[0], 2, 3], 1e-9);
  near(scene.materials[0].color, [0.2, 0.4, 0.8]);
  assert.equal(scene.materials[0].roughness, 0.25);
  gltf.scene.traverse(object => {
    const mesh = object as Mesh;
    if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); }
  });
});
