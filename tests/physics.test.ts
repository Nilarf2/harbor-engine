import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { World, type EntityDefinition, type Vec3 } from '../src/core/index.js';
import { createRapierPlugin, type PhysicsService } from '../src/physics/index.js';

const plugin = await createRapierPlugin();
const floor: EntityDefinition = {
  id: 'floor', position: [0, -0.5, 0], body: { type: 'fixed', shape: 'box', size: [40, 1, 40] },
};
const character = (position: Vec3 = [0, 3, 0]): EntityDefinition => ({
  id: 'player', position, body: { type: 'character', shape: 'capsule', size: [0.6, 1.8, 0.6] },
});
const box = (id: string, position: Vec3, size: Vec3): EntityDefinition => ({
  id, position, body: { type: 'fixed', shape: 'box', size },
});
function room(t: TestContext, entities: EntityDefinition[] = [floor, character()]): World {
  const world = new World();
  t.after(() => world.dispose());
  for (const entity of entities) world.spawn(entity);
  world.install(plugin);
  return world;
}
function service(world: World): PhysicsService { return world.services.get('physics') as PhysicsService; }
function near(actual: number, expected: number, tolerance = 0.05): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} near ${expected} ± ${tolerance}`);
}

test('dynamic sphere and character land on a genuine 3D collider and remain stable', t => {
  const world = room(t, [floor, character(), {
    id: 'ball', position: [-3, 5, 0], body: { type: 'dynamic', shape: 'sphere', size: [1, 1, 1], mass: 1 },
  }]);
  world.step(360);
  near(world.get('ball')!.position[1], 0.5, 0.015);
  near(world.get('player')!.position[1], 0.92, 0.015);
  assert.equal(service(world).inspect().grounded.player, true);
  world.step(360);
  near(world.get('player')!.position[1], 0.92, 0.015);
  assert.ok(world.get('ball')!.rotation.every(Number.isFinite));
});

test('character collides with walls and slides along their surface', t => {
  const world = room(t, [floor, character(), box('wall', [2, 2, 0], [0.5, 4, 16])]);
  world.step(120);
  world.command({ type: 'physics:move', id: 'player', velocity: [4, 0, 2] });
  world.step(120);
  const [x, y, z] = world.get('player')!.position;
  assert.ok(x > 1.3 && x < 1.46, `wall must stop player, x=${x}`);
  assert.ok(z > 3.5, `player must slide, z=${z}`);
  near(y, 0.92, 0.03);
});

test('colliders spawned immediately before movement block that same tick', t => {
  const world = room(t);
  world.step(120);
  world.spawn(box('new-wall', [1, 2, 0], [0.2, 4, 8]));
  world.command({ type: 'physics:move', id: 'player', velocity: [120, 0, 0] });
  world.step();
  assert.ok(world.get('player')!.position[0] < 0.61);
});

test('character steps up a low platform', t => {
  const world = room(t, [floor, character(), box('step', [2.5, 0.125, 0], [3, 0.25, 4])]);
  world.step(120);
  world.command({ type: 'physics:move', id: 'player', velocity: [2, 0, 0] });
  world.step(75);
  const [x, y] = world.get('player')!.position;
  assert.ok(x > 2.1, `character should climb step, x=${x}`);
  near(y, 1.17, 0.04);
});

test('character walks underneath overhead geometry rather than treating its footprint as a wall', t => {
  const world = room(t, [floor, character(), box('bridge', [2, 3, 0], [3, 0.4, 4])]);
  world.step(120);
  world.command({ type: 'physics:move', id: 'player', velocity: [2, 0, 0] });
  world.step(120);
  assert.ok(world.get('player')!.position[0] > 3.8);
  near(world.get('player')!.position[1], 0.92, 0.03);
});

test('jump leaves ground, cannot jump again in air, and lands', t => {
  const world = room(t);
  world.step(120);
  const start = world.get('player')!.position[1];
  world.command({ type: 'physics:move', id: 'player', velocity: [0, 0, 0], jump: true });
  world.step(20);
  assert.ok(world.get('player')!.position[1] > start + 1);
  assert.equal(service(world).inspect().grounded.player, false);
  world.command({ type: 'physics:move', id: 'player', velocity: [0, 0, 0], jump: true });
  world.step(90);
  near(world.get('player')!.position[1], start, 0.03);
  assert.equal(service(world).inspect().grounded.player, true);
});

test('dynamic impulse changes motion and teleport resets it', t => {
  const world = room(t, [floor, {
    id: 'ball', position: [0, 2, 0], body: { type: 'dynamic', shape: 'sphere', size: [1, 1, 1], mass: 1 },
  }]);
  world.command({ type: 'physics:impulse', id: 'ball', impulse: [3, 5, 0] });
  world.step(20);
  assert.ok(world.get('ball')!.position[0] > 0.9);
  assert.ok(world.get('ball')!.position[1] > 3);
  let transformed: Vec3 | undefined;
  world.events.on<{ id: string; position: Vec3 }>('entity:transform', entity => {
    if (entity.id === 'ball') transformed = [...entity.position];
  });
  world.command({ type: 'physics:teleport', id: 'ball', position: [-5, 3, 0] });
  assert.deepEqual(world.get('ball')!.position, [-5, 3, 0]);
  assert.deepEqual(transformed, [-5, 3, 0]);
  world.step(20);
  near(world.get('ball')!.position[0], -5, 0.001);
  assert.ok(world.get('ball')!.position[1] < 3);
});

test('CCD prevents a fast dynamic body from tunnelling through a thin wall', t => {
  const world = room(t, [box('wall', [0, 2, 0], [0.2, 4, 8]), {
    id: 'ball', position: [-2, 2, 0], body: { type: 'dynamic', shape: 'sphere', size: [0.2, 0.2, 0.2], mass: 1 },
  }]);
  world.command({ type: 'physics:impulse', id: 'ball', impulse: [1000, 0, 0] });
  world.step();
  assert.ok(world.get('ball')!.position[0] < -0.14, 'fast body must stay on the entry side of the wall');
});

test('removal releases character state and colliders; a removed ID may be reused', t => {
  const world = room(t, [floor, character(), box('wall', [2, 2, 0], [0.5, 4, 8])]);
  assert.equal(service(world).inspect().bodies, 3);
  world.remove('player');
  assert.equal(service(world).inspect().characters, 0);
  assert.equal(service(world).inspect().grounded.player, undefined);
  world.spawn(character());
  world.remove('wall');
  world.step(120);
  world.command({ type: 'physics:move', id: 'player', velocity: [3, 0, 0] });
  world.step(60);
  assert.ok(world.get('player')!.position[0] > 2.6, 'player must pass the removed wall');
  const retainedService = service(world);
  world.dispose();
  assert.equal(retainedService.inspect().bodies, 0);
  assert.equal(world.services.has('physics'), false);
});

test('one plugin can install into independent worlds without shared bodies or input', t => {
  const a = room(t);
  const b = room(t);
  a.step(120); b.step(120);
  a.command({ type: 'physics:move', id: 'player', velocity: [3, 0, 0] });
  a.step(60); b.step(60);
  assert.ok(a.get('player')!.position[0] > 2.6);
  near(b.get('player')!.position[0], 0, 0.01);
  a.dispose();
  b.step();
  assert.equal(service(b).inspect().bodies, 2);
});

test('malformed commands are rejected before changing simulation state', async t => {
  const a = room(t);
  const b = room(t);
  a.step(120); b.step(120);
  const move = { type: 'physics:move', id: 'player', velocity: [1, 0, 0] };
  a.command(move); b.command(move);
  const before = a.snapshot();
  for (const command of [
    { type: 'physics:move', id: 'player', velocity: [NaN, 0, 0] },
    { type: 'physics:move', id: 'player', velocity: [2, 0] },
    { type: 'physics:move', id: 'player', velocity: new Array(3) },
    { type: 'physics:move', id: 'player', velocity: [2, 0, 0], jump: 'true' },
    { type: 'physics:move', id: 'player', velocity: [1e300, 0, 0] },
    { type: 'physics:teleport', id: 'player', position: [0, Infinity, 0] },
    { type: 'physics:teleport', id: 'unknown', position: [0, 0, 0] },
    { type: 'physics:impulse', id: 'player', impulse: [0, 1, 0] },
    { type: 'physics:move', id: 'floor', velocity: [1, 0, 0] },
    { type: 'physics:move', id: null, velocity: [1, 0, 0] },
  ]) assert.throws(() => a.command(command));
  assert.deepEqual(a.snapshot(), before);
  a.step(60); b.step(60);
  assert.deepEqual(a.snapshot(), b.snapshot());
  await assert.rejects(createRapierPlugin({ gravity: [0, NaN, 0] }), /gravity/);
});

test('failed setup rolls back resources and can be retried', t => {
  const world = new World();
  t.after(() => world.dispose());
  world.spawn(floor); world.spawn(character());
  const unregister = world.registerCommand('physics:impulse', () => {});
  assert.throws(() => world.install(plugin), /Duplicate command/);
  assert.equal(world.services.has('physics'), false);
  assert.throws(() => world.command({ type: 'physics:move', id: 'player', velocity: [0, 0, 0] }), /Unknown command/);
  unregister();
  world.install(plugin);
  world.step(120);
  assert.equal(service(world).inspect().bodies, 2);
  near(world.get('player')!.position[1], 0.92, 0.03);
});

test('unsafe float magnitudes reject a spawn without leaving a body or poisoning the world', t => {
  const world = room(t);
  const attempts: EntityDefinition[] = [
    { id: 'overflow-position', position: [1e300, 0, 0], body: { type: 'dynamic', shape: 'box', size: [1, 1, 1] } },
    { id: 'underflow-shape', body: { type: 'dynamic', shape: 'box', size: [1e-300, 1, 1] } },
    { id: 'overflow-mass', body: { type: 'dynamic', shape: 'box', size: [1, 1, 1], mass: 1e300 } },
    { id: 'underflow-mass', body: { type: 'dynamic', shape: 'box', size: [1, 1, 1], mass: 1e-300 } },
  ];
  for (const entity of attempts) {
    assert.throws(() => world.spawn(entity));
    assert.equal(world.get(entity.id), undefined);
    assert.equal(service(world).inspect().bodies, 2);
  }
  world.step(120);
  near(world.get('player')!.position[1], 0.92, 0.03);
});
