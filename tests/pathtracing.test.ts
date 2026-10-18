import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, MeshPhysicalMaterial } from 'three/webgpu';
import { createWorld } from '../src/core/index.js';
import { createWorldSceneBridge } from '../src/pathtracing/from-world.js';

test('quality bridge shares physical resources and distinguishes transform changes from rebuilds', () => {
  const world = createWorld({ version: 1, name: 'Quality bridge', entities: [
    { id: 'a', visual: { shape: 'sphere', size: [2, 2, 2], transmission: .8, ior: 1.45, castShadow: false } },
    { id: 'b', visual: { shape: 'sphere', size: [2, 2, 2], transmission: .8, ior: 1.45, castShadow: false } },
  ] });
  const scene = new Scene(), bridge = createWorldSceneBridge(world, scene, { segments: 16 });
  assert.equal(bridge.sync(), 'scene');
  const a = bridge.getObject('a')!, b = bridge.getObject('b')!;
  assert.equal(a.geometry, b.geometry); assert.equal(a.material, b.material);
  assert.ok(a.material instanceof MeshPhysicalMaterial);
  assert.equal(a.material.transmission, .8); assert.equal(a.material.ior, 1.45); assert.equal(a.visibleToShadowRays, false);
  assert.equal(bridge.sync(), 'none');
  world.get('a')!.position[0] = 3;
  assert.equal(bridge.sync(), 'transforms'); assert.equal(bridge.getObject('a'), a); assert.equal(a.position.x, 3);
  assert.equal(bridge.sync(), 'none');
  world.get('a')!.visual!.roughness = .1;
  assert.equal(bridge.sync(), 'scene'); assert.equal(bridge.getObject('a')!.geometry, b.geometry);
  assert.notEqual(bridge.getObject('a')!.material, b.material);
  let geometryDisposals = 0, materialDisposals = 0;
  b.geometry.addEventListener('dispose', () => geometryDisposals++);
  (b.material as MeshPhysicalMaterial).addEventListener('dispose', () => materialDisposals++);
  world.remove('b'); assert.equal(bridge.sync(), 'scene'); assert.equal(materialDisposals, 1); assert.equal(geometryDisposals, 0);
  world.remove('a'); assert.equal(bridge.sync(), 'scene'); assert.equal(geometryDisposals, 1);
  bridge.dispose(); bridge.dispose(); assert.equal(scene.children.length, 0);
  assert.throws(() => bridge.sync(), /disposed/); world.dispose();
});

test('quality geometry precision is configurable and validates its range', () => {
  const world = createWorld({ version: 1, name: 'Precision', entities: [
    { id: 'sphere', visual: { shape: 'sphere', size: [2, 2, 2] } },
  ] });
  const scene = new Scene();
  const low = createWorldSceneBridge(world, scene, { segments: 8 }); low.sync();
  const high = createWorldSceneBridge(world, scene, { segments: 64 }); high.sync();
  assert.ok(high.getObject('sphere')!.geometry.index!.count > low.getObject('sphere')!.geometry.index!.count * 20);
  for (const segments of [0, 7, 257, NaN, 8.5]) assert.throws(() => createWorldSceneBridge(world, scene, { segments }), /segments/);
  low.dispose(); high.dispose(); world.dispose();
});
