import test from 'node:test';
import assert from 'node:assert/strict';
import { Scope, World, createWorld, validateScene } from '../src/core/index.js';
import type { EntityDefinition } from '../src/core/index.js';

test('fixed-step simulation is equivalent across frame partitions and manual stepping', () => {
  function simulation() {
    const world = new World({ seed: 42, fixedDelta: 0.01, maxSubSteps: 100 });
    world.spawn({ id: 'ball', data: { velocity: 0 } });
    world.addSystem({ id: 'move', update(current, dt) {
      const ball = current.get('ball')!;
      ball.data.velocity = Number(ball.data.velocity) + current.random() * dt;
      ball.position[0] += Number(ball.data.velocity) * dt;
    } });
    return world;
  }
  const a = simulation(), b = simulation(), c = simulation();
  a.advance(0.8);
  for (const frame of [0.003, 0.127, 0.011, 0.209, 0.25, 0.2]) b.advance(frame);
  c.step(80);
  assert.equal(a.tick, 80); assert.equal(a.time, 0.8);
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.deepEqual(a.snapshot(), c.snapshot());
  assert.equal(a.random(), b.random());
});

test('frame catch-up is bounded and reports dropped time without corrupting remainder', () => {
  const world = new World({ fixedDelta: 0.1, maxSubSteps: 2 });
  const longFrame = world.advance(1.05);
  assert.equal(longFrame.steps, 2); assert.equal(world.tick, 2);
  assert.ok(Math.abs(longFrame.droppedTime - 0.8) < 1e-10);
  assert.ok(Math.abs(longFrame.alpha - 0.5) < 1e-10);
  assert.equal(world.advance(0.05).steps, 1); assert.equal(world.tick, 3);
  assert.throws(() => world.advance(NaN)); assert.throws(() => world.advance(-1));
  assert.throws(() => world.step(0.5)); assert.throws(() => new World({ fixedDelta: 0 }));
});

test('spawn, snapshot and scene validation detach nested state and reject duplicate identities', () => {
  const source: EntityDefinition = { id: 'player', position: [1, 2, 3], tags: ['player'], data: { stats: { score: 7 } } };
  const world = new World(); const spawned = world.spawn(source);
  source.position![0] = 99; (source.data!.stats as { score: number }).score = 99;
  assert.equal(spawned.position[0], 1); assert.deepEqual(spawned.data.stats, { score: 7 });
  const snapshot = world.snapshot(); snapshot.entities[0].position[1] = 999;
  assert.equal(spawned.position[1], 2); assert.deepEqual(world.query('player'), [spawned]);
  assert.throws(() => world.spawn({ id: 'player' }), /Duplicate/);
  assert.equal(world.remove('missing'), false); assert.equal(world.remove('player'), true);
  assert.throws(() => validateScene({ version: 1, name: 'Dup', entities: [{ id: 'a' }, { id: 'a' }] }), /duplicate/);
  const scene = validateScene({ version: 1, name: 'Empty', entities: [] });
  assert.equal(createWorld(scene).entities.size, 0);
});

test('strict schema rejects errors before game initialization', () => {
  const invalid = [
    { id: 'bad id' }, { id: 'a', postion: [0, 0, 0] }, { id: 'a', position: [NaN, 0, 0] },
    { id: 'a', rotation: [0, 0, 0, 0] }, { id: 'a', rotation: [0, 0, 0, 2] },
    { id: 'a', visual: { shape: 'box', size: [0, 1, 1] } },
    { id: 'a', visual: { shape: 'sphere', size: [1, 2, 1] } },
    { id: 'a', visual: { shape: 'box', size: [1, 1, 1], color: 'guess' } },
    { id: 'a', body: { type: 'fixed', shape: 'box', size: [1, 1, 1] }, scale: [2, 1, 1] },
    { id: 'a', body: { type: 'dynamic', shape: 'box', size: [1, 1, 1] }, visual: { shape: 'box', size: [1, 1, 1], batch: true } },
    { id: 'a', body: { type: 'character', shape: 'capsule', size: [2, 1, 2] } },
    { id: 'a', tags: ['duplicate', 'duplicate'] }, { id: 'a', data: { bad: undefined } },
    { id: 'a', position: new Array(3) }, { id: 'a', data: { sparse: new Array(1) } },
    { id: 'a', position: [1e300, 0, 0] },
    { id: 'a', visual: { shape: 'box', size: [1e-300, 1, 1] } },
    { id: 'a', visual: { shape: 'box', size: [1e300, 1, 1] } },
    { id: 'a', body: { type: 'dynamic', shape: 'box', size: [1, 1, 1], mass: Number.MIN_VALUE } },
    { id: 'a', body: { type: 'dynamic', shape: 'box', size: [1, 1, 1], mass: 1e300 } },
    { id: 'a', visual: { shape: 'sphere', size: [1, 1, 1], transmission: 1.1 } },
    { id: 'a', visual: { shape: 'sphere', size: [1, 1, 1], ior: 0.9 } },
  ];
  for (const entity of invalid) assert.throws(() => validateScene({ version: 1, name: 'Invalid', entities: [entity] }), TypeError);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => validateScene({ version: 1, name: 'Cycle', entities: [{ id: 'a', data: cycle }] }), /cyclic/);
  assert.throws(() => validateScene({ version: 2, name: 'Future', entities: [] }), /version/);
  assert.throws(() => validateScene({ version: 1, name: 'Typo', entites: [] }), /unknown field/);
  assert.throws(() => validateScene({ version: 1, name: 'Sparse', entities: new Array(1) }), /expected an object/);
});

test('systems follow phases, stable order and removals; commands have explicit lifetimes', () => {
  const world = new World(), calls: string[] = [];
  const off = world.addSystem({ id: 'after', phase: 'afterPhysics', update() { calls.push('after'); } });
  world.addSystem({ id: 'physics', phase: 'physics', update() { calls.push('physics'); } });
  world.addSystem({ id: 'input2', order: 1, update() { calls.push('input2'); } });
  world.addSystem({ id: 'input1', order: -1, update() { calls.push('input1'); } });
  world.step(); assert.deepEqual(calls, ['input1', 'input2', 'physics', 'after']);
  calls.length = 0; off(); world.step(); assert.deepEqual(calls, ['input1', 'input2', 'physics']);
  const removeCommand = world.registerCommand('score:add', command => Number(command.amount) + 2);
  assert.equal(world.command({ type: 'score:add', amount: 5 }), 7);
  assert.throws(() => world.registerCommand('score:add', () => {}), /Duplicate/);
  removeCommand(); assert.throws(() => world.command({ type: 'score:add' }), /Unknown/);
  assert.throws(() => world.addSystem({ id: 'physics', update() {} }), /Duplicate/);
  assert.throws(() => world.addSystem({ id: 'invalid', phase: '__proto__' as never, update() {} }), /Unknown system phase/);
});

test('scope and dependent plugins dispose once, in reverse order, including failed setup', () => {
  const calls: string[] = [], scope = new Scope();
  const early = scope.add(() => calls.push('early')); scope.add(() => calls.push('late'));
  early(); early(); scope.dispose(); scope.dispose(); scope.add(() => calls.push('already-disposed'));
  assert.deepEqual(calls, ['early', 'late', 'already-disposed']);
  const world = new World(); calls.length = 0;
  world.install({ id: 'base', setup(_, lifetime) { lifetime.add(() => calls.push('base')); } });
  world.install({ id: 'feature', requires: ['base'], setup(_, lifetime) { lifetime.add(() => calls.push('feature')); } });
  assert.throws(() => world.install({ id: 'bad-dependency', requires: ['missing'], setup() {} }), /requires/);
  assert.throws(() => world.install({ id: 'failed', setup(_, lifetime) {
    lifetime.add(() => calls.push('failed-cleanup')); throw new Error('setup failed');
  } }), /setup failed/);
  world.events.on('entity:remove', () => calls.push('entity-remove'));
  world.spawn({ id: 'a' }); world.dispose(); world.dispose();
  assert.deepEqual(calls, ['failed-cleanup', 'entity-remove', 'feature', 'base']);
  assert.throws(() => world.spawn({ id: 'closed' }), /disposed/); assert.equal(world.entities.size, 0);
});

test('failed spawn rolls back observers and all cleanup callbacks still run after a failure', () => {
  const world = new World(), observed = new Set<string>();
  world.events.on<{ id: string }>('entity:spawn', entity => observed.add(entity.id));
  world.events.on('entity:spawn', () => { throw new Error('rejected'); });
  world.events.on<{ id: string }>('entity:remove', entity => observed.delete(entity.id));
  assert.throws(() => world.spawn({ id: 'a' }), /rejected/);
  assert.equal(observed.size, 0); assert.equal(world.entities.size, 0);
  const scope = new Scope(), calls: number[] = [];
  scope.add(() => calls.push(1)); scope.add(() => { throw new Error('cleanup'); }); scope.add(() => calls.push(3));
  assert.throws(() => scope.dispose(), AggregateError); assert.deepEqual(calls, [3, 1]);
});

test('plugin setup cannot leak a lifetime into a closed world or recursively install itself', () => {
  const world = new World(); let cleaned = 0;
  assert.throws(() => world.install({ id: 'close-during-setup', setup(current, scope) {
    scope.add(() => cleaned++); current.dispose();
  } }), /disposed/);
  assert.equal(cleaned, 1); world.dispose(); assert.equal(cleaned, 1);
  const other = new World();
  assert.throws(() => other.install({ id: 'recursive', setup(current, scope) {
    scope.add(() => cleaned++);
    current.install({ id: 'recursive', setup() {} });
  } }), /Duplicate plugin/);
  assert.equal(cleaned, 2);
  other.install({ id: 'recursive', setup() {} }); other.dispose();
});
