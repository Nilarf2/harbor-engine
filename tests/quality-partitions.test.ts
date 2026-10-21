import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bone, BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4,
  Mesh, MeshStandardMaterial, Scene, Skeleton, SkinnedMesh, Vector3,
} from 'three/webgpu';
// @ts-expect-error Pinned upstream internal CPU packing helper has no declaration file.
import { PathtracerBVHComputeData } from 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js';
import { PreparedQualityScene } from '../src/pathtracing/prepare-scene.js';

test('group partitions retain skinned world positions, inherited visibility and independent instance transforms', () => {
  const geometry = new BufferGeometry(), positions: number[] = [], indices: number[] = [];
  for (let triangle = 0; triangle < 260; triangle++) {
    positions.push(triangle, 0, 0, triangle + .5, 0, 0, triangle, .5, 0);
    indices.push(triangle * 3, triangle * 3 + 1, triangle * 3 + 2);
    geometry.addGroup(triangle * 3, 3, triangle % 2);
  }
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3)); geometry.setIndex(indices);
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(positions.length / 3 * 4), 4));
  const weights = new Float32Array(positions.length / 3 * 4);
  for (let index = 0; index < weights.length; index += 4) weights[index] = 1;
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  const materials = [new MeshStandardMaterial(), new MeshStandardMaterial()];
  const scene = new Scene(), parent = new Group(); parent.position.set(10, 2, -3); parent.rotation.y = .3; parent.scale.set(2, .5, 1.5); scene.add(parent);
  const skin = new SkinnedMesh(geometry, materials), bone = new Bone(); skin.add(bone); skin.position.set(3, 2, 1); parent.add(skin);
  scene.updateMatrixWorld(true); skin.bind(new Skeleton([bone]));
  const instances = new InstancedMesh(geometry, materials, 3); instances.position.set(-2, 4, 3); instances.rotation.z = .2;
  instances.setMatrixAt(0, new Matrix4().makeTranslation(5, 0, 2)); parent.add(instances);
  const prepared = new PreparedQualityScene(scene);
  try {
    bone.position.set(2, 1, .5); skin.position.x += 2; parent.rotation.y += .1;
    instances.count = 2; instances.setMatrixAt(1, new Matrix4().makeTranslation(-4, 3, 1)); prepared.syncTransforms();
    const skinParts: SkinnedMesh[] = [], instanceParts: InstancedMesh[] = [];
    prepared.scene.traverse(object => { if (object instanceof SkinnedMesh) skinParts.push(object); if (object instanceof InstancedMesh) instanceParts.push(object); });
    assert.equal(skinParts.length, 3); assert.equal(instanceParts.length, 3);
    let offset = 0;
    for (const part of skinParts) {
      assert.equal(part.skeleton, skinParts[0].skeleton);
      for (let index = 0; index < part.geometry.index!.count; index++) {
        const originalIndex = geometry.index!.getX(offset + index), privateIndex = part.geometry.index!.getX(index);
        const actual = part.getVertexPosition(privateIndex, new Vector3()).applyMatrix4(part.matrixWorld);
        const expected = skin.getVertexPosition(originalIndex, new Vector3()).applyMatrix4(skin.matrixWorld);
        assert.ok(actual.distanceTo(expected) < 1e-5, `Partition changed skinned source vertex ${originalIndex}`);
      }
      offset += part.geometry.index!.count;
    }
    for (const part of instanceParts) {
      assert.equal(part.count, 2); assert.deepEqual(part.matrixWorld.elements, instances.matrixWorld.elements);
      assert.deepEqual([...part.instanceMatrix.array], [...instances.instanceMatrix.array]);
    }
    parent.visible = false; prepared.syncTransforms(); let visibleParts = 0;
    prepared.scene.traverseVisible(object => { if (object instanceof SkinnedMesh || object instanceof InstancedMesh) visibleParts++; });
    assert.equal(visibleParts, 0);
    const originalSkeleton = skin.skeleton, privateSkeleton = skinParts[0].skeleton, release = privateSkeleton.dispose.bind(privateSkeleton);
    let releases = 0; privateSkeleton.dispose = () => { releases++; release(); };
    prepared.dispose(); assert.equal(releases, 1); assert.equal(skin.skeleton, originalSkeleton);
  } finally {
    prepared.dispose(); geometry.dispose(); materials.forEach(material => material.dispose()); skin.skeleton.dispose(); instances.dispose();
  }
});

test('empty skinned and instanced scaffolds bypass both upstream renderable paths and can recover', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(12), 4));
  const weights = new Float32Array(12); weights[0] = weights[4] = weights[8] = 1;
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4)); geometry.setIndex([0, 1, 2]); geometry.addGroup(0, 3, 0); geometry.setDrawRange(0, 0);
  const material = new MeshStandardMaterial(), scene = new Scene(), skin = new SkinnedMesh(geometry, [material]), bone = new Bone();
  skin.add(bone); skin.bind(new Skeleton([bone])); skin.position.x = 3;
  const instances = new InstancedMesh(geometry, [material], 2); instances.position.x = -2;
  const childGeometry = geometry.clone(); childGeometry.setDrawRange(0, 3);
  const child = new Mesh(childGeometry, material); child.position.x = 2; skin.add(child); scene.add(skin, instances);
  const prepared = new PreparedQualityScene(scene), [privateSkin, privateInstances] = prepared.scene.children as [SkinnedMesh, InstancedMesh];
  try {
    assert.equal(privateSkin.isMesh, false); assert.equal(privateSkin.isSkinnedMesh, false); assert.equal(privateInstances.isMesh, false);
    assert.equal((privateSkin.children[1] as Mesh).matrixWorld.elements[12], 5);
    const packed = new PathtracerBVHComputeData(prepared.scene);
    try { packed.update(); assert.equal(packed.bvh.objects.length, 1); } finally { packed.dispose(); }
    geometry.setDrawRange(0, 3); prepared.updateGeometry([skin, instances]);
    assert.equal(privateSkin.isMesh, true); assert.equal(privateSkin.isSkinnedMesh, true); assert.equal(privateInstances.isMesh, true);
    assert.equal(privateInstances.count, 2); assert.equal(skin.isSkinnedMesh, true); assert.equal(skin.isMesh, true);
    const restored = new PathtracerBVHComputeData(prepared.scene);
    try { restored.update(); assert.equal(restored.bvh.objects.length, 3); } finally { restored.dispose(); }
  } finally { prepared.dispose(); geometry.dispose(); childGeometry.dispose(); material.dispose(); skin.skeleton.dispose(); instances.dispose(); }
});
