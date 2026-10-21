import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from 'three-mesh-bvh';
// @ts-expect-error Upstream's internal packing test helper has no public declaration.
import { ClusteredBVH } from 'three-mesh-bvh/src/webgpu/ClusteredBVH.js';
// @ts-expect-error Upstream's material packing helper has no public declaration.
import { PathtracerBVHComputeData } from 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js';
import {
  Bone, BoxGeometry, BufferAttribute, BufferGeometry, Float16BufferAttribute,
  InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicNodeMaterial,
  MeshStandardMaterial, Scene, Skeleton, SkinnedMesh, Vector3,
} from 'three/webgpu';
import { compactTraceGeometry, PreparedQualityScene } from '../src/pathtracing/prepare-scene.js';

test('private compaction preserves indexed triangle order, groups and every normalized/interleaved/morph/half attribute', () => {
  const source = new BufferGeometry();
  source.setAttribute('position', new BufferAttribute(Float32Array.from({ length: 300 }, (_, i) => i / 3), 3));
  source.setAttribute('color', new BufferAttribute(new Uint8Array(300).map((_, i) => i % 255), 3, true));
  const data = new InterleavedBuffer(Float32Array.from({ length: 500 }, (_, i) => i), 5);
  source.setAttribute('uv', new InterleavedBufferAttribute(data, 2, 3));
  source.setAttribute('customHalf', new Float16BufferAttribute(new Uint16Array(100).fill(0x3c00), 1));
  source.morphAttributes.position = [source.getAttribute('position').clone()]; source.morphTargetsRelative = true;
  source.setIndex([4, 5, 6, 80, 90, 99, 80, 99, 75, 1, 2, 3]);
  source.addGroup(0, 6, 2); source.addGroup(6, 6, 1); source.setDrawRange(3, 6);
  const marker = { refit() {} }; Object.assign(source, { boundsTree: marker });
  const before = Array.from(source.index!.array);
  const result = compactTraceGeometry(source);
  assert.equal(result.sourceVertices, 100); assert.equal(result.vertices, 4); assert.equal(result.triangles, 2);
  assert.deepEqual(Array.from(result.sourceIndices), [80, 90, 99, 75]);
  assert.deepEqual(Array.from(result.geometry.index!.array), [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(result.geometry.groups, [{ start: 0, count: 3, materialIndex: 2 }, { start: 3, count: 3, materialIndex: 1 }]);
  assert.equal(result.geometry.getAttribute('color').normalized, true);
  assert.equal(result.geometry.getAttribute('color').array.constructor, Uint8Array);
  assert.equal(result.geometry.getAttribute('color').getX(0), source.getAttribute('color').getX(80));
  assert.equal(result.geometry.getAttribute('uv').getY(2), source.getAttribute('uv').getY(99));
  assert.equal(result.geometry.getAttribute('customHalf').getX(0), 1);
  assert.deepEqual(Array.from(result.geometry.getAttribute('customHalf').array), [0x3c00, 0x3c00, 0x3c00, 0x3c00]);
  assert.equal(result.geometry.morphTargetsRelative, true);
  assert.equal(result.geometry.morphAttributes.position![0].getZ(1), source.morphAttributes.position![0].getZ(90));
  assert.deepEqual(Array.from(source.index!.array), before); assert.equal((source as typeof source & { boundsTree: unknown }).boundsTree, marker);
  result.geometry.dispose(); source.dispose();
});

test('quality preparation shares instanced bind geometry without expanding 59k instances or touching source BVHs', () => {
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  const mesh = new InstancedMesh(geometry, material, 59000); mesh.count = 59000; scene.add(mesh);
  const sentinel = {}; Object.assign(geometry, { boundsTree: sentinel });
  const prepared = new PreparedQualityScene(scene);
  const target = prepared.scene.children[0] as InstancedMesh;
  assert.equal(target.isInstancedMesh, true); assert.equal(target.count, 59000);
  assert.notEqual(target.geometry, geometry); assert.notEqual(target.instanceMatrix.array, mesh.instanceMatrix.array);
  assert.equal(prepared.inspect().uniqueGeometries, 1); assert.equal(prepared.inspect().instances, 59000);
  assert.equal((geometry as typeof geometry & { boundsTree: unknown }).boundsTree, sentinel);
  let sourceDisposals = 0; geometry.addEventListener('dispose', () => sourceDisposals++); material.addEventListener('dispose', () => sourceDisposals++);
  prepared.dispose(); prepared.dispose(); assert.equal(sourceDisposals, 0);
  geometry.dispose(); material.dispose(); mesh.dispose();
});

function skinned(geometry: BufferGeometry, material: MeshStandardMaterial): SkinnedMesh {
  const mesh = new SkinnedMesh(geometry, material), root = new Bone(); mesh.add(root); mesh.bind(new Skeleton([root])); return mesh;
}

test('separate actors retain separate pose skeletons and private caches survive unrelated geometry updates', () => {
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  const a = skinned(geometry, material), b = skinned(geometry, material), staticMesh = new Mesh(geometry, material);
  scene.add(a, b, staticMesh); const prepared = new PreparedQualityScene(scene);
  const [pa, pb, ps] = prepared.scene.children as [SkinnedMesh, SkinnedMesh, Mesh];
  assert.notEqual(pa.skeleton, a.skeleton); assert.notEqual(pa.skeleton, pb.skeleton);
  a.skeleton.bones[0].position.x = 3; b.skeleton.bones[0].position.x = -2; prepared.syncTransforms();
  assert.equal(pa.skeleton.bones[0].position.x, 3); assert.equal(pb.skeleton.bones[0].position.x, -2);
  assert.notEqual(pa.getVertexPosition(0, new Vector3()).x, pb.getVertexPosition(0, new Vector3()).x);
  assert.equal(prepared.inspect().estimatedAttributeBytes, count * 3 * 5 * 16);
  const unrelated = new Mesh(new BoxGeometry(), material); scene.add(unrelated); prepared.rebuild();
  const original = (prepared.scene.children[3] as Mesh).geometry;
  geometry.getAttribute('position').setX(0, 3); prepared.updateGeometry([a]);
  assert.equal((prepared.scene.children[3] as Mesh).geometry, original);
  assert.notEqual(ps.geometry, geometry); prepared.dispose(); geometry.dispose(); unrelated.geometry.dispose(); material.dispose();
});

test('capacity estimates use the scene-wide UV union and match the actual packed vertex binding', () => {
  const scene = new Scene(), material = new MeshStandardMaterial();
  const first = new BoxGeometry(), second = new BoxGeometry();
  first.setAttribute('uv1', first.getAttribute('uv').clone());
  second.setAttribute('uv2', second.getAttribute('uv').clone());
  scene.add(new Mesh(first, material), new Mesh(second, material));
  const prepared = new PreparedQualityScene(scene), packed = new PathtracerBVHComputeData(prepared.scene);
  try {
    packed.update();
    const actual = packed.storage.attributes.value.array.byteLength;
    assert.equal(prepared.inspect().estimatedAttributeBytes, (first.getAttribute('position').count + second.getAttribute('position').count) * 7 * 16);
    assert.equal(prepared.inspect().estimatedAttributeBytes, actual);
    assert.ok(actual < actual + packed.storage.index.value.array.byteLength, 'single attribute binding excludes other storage buffers');
  } finally { packed.dispose(); prepared.dispose(); first.dispose(); second.dispose(); material.dispose(); }
});

test('unknown shaders are explicit and a failed rebuild preserves the current graph and disposes allocated copies', () => {
  const scene = new Scene(), material = new MeshStandardMaterial(), good = new Mesh(new BoxGeometry(), material); good.name = 'good'; scene.add(good);
  const prepared = new PreparedQualityScene(scene), previous = prepared.scene;
  const oldGeometry = (previous.children[0] as Mesh).geometry; let disposed = 0; oldGeometry.addEventListener('dispose', () => disposed++);
  const bad = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()); bad.name = 'unmapped-water'; scene.add(bad);
  assert.throws(() => prepared.rebuild(), /Quality material mapping required:.*unmapped-water/);
  assert.equal(prepared.scene, previous); assert.equal(disposed, 0);
  assert.throws(() => new PreparedQualityScene(scene), /unmapped-water/);
  scene.remove(bad); prepared.dispose(); assert.equal(disposed, 1);
  good.geometry.dispose(); bad.geometry.dispose(); material.dispose(); bad.material.dispose();
});


test('morph poses bake independently for shared geometry, remain aligned with guides, and refresh explicitly', () => {
  const geometry = new BoxGeometry(), material = new MeshStandardMaterial(), scene = new Scene();
  const position = geometry.getAttribute('position');
  const morph = position.clone(); for (let i = 0; i < morph.count; i++) morph.setXYZ(i, 2, 0, 0);
  geometry.morphAttributes.position = [morph]; geometry.morphTargetsRelative = true;
  const a = new Mesh(geometry, material), b = new Mesh(geometry, material); a.morphTargetInfluences![0] = .25; b.morphTargetInfluences![0] = .75; scene.add(a, b);
  const prepared = new PreparedQualityScene(scene); const [pa, pb] = prepared.scene.children as Mesh[];
  assert.notEqual(pa.geometry, pb.geometry);
  assert.equal(pa.geometry.getAttribute('position').getX(0), position.getX(0) + .5);
  assert.equal(pb.geometry.getAttribute('position').getX(0), position.getX(0) + 1.5);
  assert.equal(pa.morphTargetInfluences![0], 0); // Prepared guide raster must not apply the morph twice.
  assert.equal(pa.getVertexPosition(0, new Vector3()).x, a.getVertexPosition(0, new Vector3()).x);
  a.morphTargetInfluences![0] = 1; prepared.updateGeometry([a]);
  assert.equal(pa.getVertexPosition(0, new Vector3()).x, a.getVertexPosition(0, new Vector3()).x);
  assert.equal(pb.getVertexPosition(0, new Vector3()).x, b.getVertexPosition(0, new Vector3()).x);
  assert.equal(position.getX(0), .5); prepared.dispose(); geometry.dispose(); material.dispose();
});


test('constructor failure after valid meshes releases every allocated private graph resource', () => {
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  const actor = skinned(geometry, material), instances = new InstancedMesh(geometry, material, 2);
  const bad = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()); bad.name = 'unsupported-after-valid'; scene.add(actor, instances, bad);
  const geometryDispose = BufferGeometry.prototype.dispose, skeletonDispose = Skeleton.prototype.dispose, instanceDispose = InstancedMesh.prototype.dispose;
  let copies = 0, skeletons = 0, instanceGraphs = 0;
  try {
    BufferGeometry.prototype.dispose = function () { if (this.name.endsWith(':quality')) copies++; geometryDispose.call(this); };
    Skeleton.prototype.dispose = function () { skeletons++; skeletonDispose.call(this); };
    InstancedMesh.prototype.dispose = function () { instanceGraphs++; instanceDispose.call(this); };
    assert.throws(() => new PreparedQualityScene(scene), /unsupported-after-valid/);
    assert.equal(copies, 1); assert.equal(skeletons, 1); assert.equal(instanceGraphs, 1);
  } finally {
    BufferGeometry.prototype.dispose = geometryDispose; Skeleton.prototype.dispose = skeletonDispose; InstancedMesh.prototype.dispose = instanceDispose;
    geometry.dispose(); bad.geometry.dispose(); material.dispose(); bad.material.dispose(); actor.skeleton.dispose(); instances.dispose();
  }
});


test('more than 128 ordered material groups partition privately and build real upstream clustered BVHs', () => {
  const geometry = new BufferGeometry(), values: number[] = [], indices: number[] = [];
  for (let triangle = 0; triangle < 321; triangle++) { const x = triangle * 2; values.push(x, 0, 0, x + 1, 0, 0, x, 1, 0); indices.push(triangle * 3, triangle * 3 + 1, triangle * 3 + 2); geometry.addGroup(triangle * 3, 3, triangle % 2); }
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(values), 3)); geometry.setIndex(indices); geometry.setDrawRange(3, 319 * 3);
  const sourceIndex = [...geometry.index!.array], materials = [new MeshStandardMaterial(), new MeshStandardMaterial()], mesh = new InstancedMesh(geometry, materials, 3), scene = new Scene();
  mesh.position.set(3, 4, 5); mesh.name = 'ordered-groups'; scene.add(mesh);
  const prepared = new PreparedQualityScene(scene), first = prepared.scene.children[0] as InstancedMesh;
  const partitions: InstancedMesh[] = []; prepared.scene.traverse(object => { if (object instanceof InstancedMesh) partitions.push(object); });
  assert.equal(partitions.length, 3); assert.equal(prepared.inspect().expandedTriangles, 319 * 3);
  const materialOrder = partitions.flatMap(part => part.geometry.groups.map(group => group.materialIndex));
  assert.deepEqual(materialOrder, geometry.groups.slice(1, 320).map(group => group.materialIndex));
  const xOrder = partitions.flatMap(part => Array.from({ length: part.geometry.index!.count / 3 }, (_, triangle) => part.geometry.getAttribute('position').getX(part.geometry.index!.getX(triangle * 3))));
  assert.deepEqual(xOrder, Array.from({ length: 319 }, (_, i) => (i + 1) * 2));
  for (const part of partitions) { assert.ok(part.geometry.groups.length <= 128); assert.equal(part.count, 3); Object.assign(part.geometry, { boundsTree: new MeshBVH(part.geometry) }); }
  assert.doesNotThrow(() => new ClusteredBVH(prepared.scene, { getBVH: (object: InstancedMesh) => object.geometry.boundsTree!, primitiveLimit: 64 }));
  mesh.position.x += 2; mesh.setMatrixAt(0, mesh.matrix.clone().makeTranslation(7, 0, 0)); prepared.syncTransforms();
  for (const part of partitions) { assert.equal(part.matrixWorld.elements[12], mesh.matrixWorld.elements[12]); assert.equal(part.instanceMatrix.getX(0), mesh.instanceMatrix.getX(0)); }
  mesh.matrixWorldAutoUpdate = false; mesh.matrixWorld.makeTranslation(20, 4, 5); prepared.syncTransforms();
  for (const part of partitions) assert.equal(part.matrixWorld.elements[12], 20);
  const marker = partitions[2].geometry; geometry.getAttribute('position').setY(0, 2); prepared.updateGeometry([mesh]);
  assert.notEqual(partitions[2].geometry, marker); assert.equal(first.material, materials); assert.deepEqual([...geometry.index!.array], sourceIndex);
  prepared.dispose(); geometry.dispose(); for (const material of materials) material.dispose(); mesh.dispose();
});


test('zero-triangle array-material draw ranges remain transform scaffolds and never request missing material roots', () => {
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  geometry.setDrawRange(geometry.index!.count, 0); const empty = new Mesh(geometry, [material]); empty.position.x = 3;
  const child = new Mesh(new BoxGeometry(), material); child.position.x = 2; empty.add(child); scene.add(empty);
  const prepared = new PreparedQualityScene(scene), scaffold = prepared.scene.children[0] as Mesh, visible = scaffold.children[0] as Mesh;
  assert.equal(scaffold.isMesh, false); assert.equal(visible.isMesh, true); assert.equal(visible.matrixWorld.elements[12], 5);
  const rendered: Mesh[] = []; prepared.scene.traverse(object => { if ((object as Mesh).isMesh) rendered.push(object as Mesh); });
  assert.equal(rendered.length, 1); for (const mesh of rendered) Object.assign(mesh.geometry, { boundsTree: new MeshBVH(mesh.geometry) });
  const data = new PathtracerBVHComputeData(prepared.scene); try { assert.doesNotThrow(() => data.update()); } finally { data.dispose(); }
  assert.doesNotThrow(() => new ClusteredBVH(prepared.scene, { getBVH: (object: Mesh) => object.geometry.boundsTree!, primitiveLimit: 64 }));
  geometry.setDrawRange(0, geometry.index!.count); prepared.updateGeometry([empty]); assert.equal(scaffold.isMesh, true);
  assert.equal(empty.isMesh, true); assert.equal(geometry.groups.length, 6); prepared.dispose(); geometry.dispose(); child.geometry.dispose(); material.dispose();
});
