import assert from 'node:assert/strict';
import test from 'node:test';
import { Scope } from '../src/core/Scope.js';
import { SaveStore, type SaveStoreOptions } from '../src/platform/SaveStore.js';
import { StoryRunner } from '../src/narrative/index.js';
import { SpatialIndex, type Rect } from '../src/spatial/index.js';

test('Scope abort precedes reverse cleanup, listener removal and immediate late registrations', () => {
  const scope = new Scope(), events: string[] = [], target = new EventTarget();
  scope.signal.addEventListener('abort', () => { events.push('abort'); });
  scope.defer(() => { events.push('first'); assert.equal(scope.signal.aborted, true); });
  scope.listen(target, 'ping', () => { events.push('ping'); });
  const last = scope.defer(() => { events.push('last'); throw new Error('last failed'); });
  target.dispatchEvent(new Event('ping'));
  assert.throws(() => scope.dispose(), AggregateError);
  scope.dispose(); last(); target.dispatchEvent(new Event('ping'));
  scope.defer(() => { events.push('late'); }); scope.listen(target, 'ping', () => { events.push('late listener'); });
  target.dispatchEvent(new Event('ping'));
  assert.deepEqual(events, ['ping', 'abort', 'last', 'first', 'late']); assert.equal(scope.size, 0);
});

test('parent signal cancellation is immediate while owned resources wait for explicit disposal', () => {
  const parent = new AbortController(), scope = new Scope(parent.signal); let cleaned = false;
  scope.defer(() => { cleaned = true; }); parent.abort('superseded');
  assert.equal(scope.signal.aborted, true); assert.equal(scope.signal.reason, 'superseded');
  assert.equal(scope.disposed, false); assert.equal(cleaned, false); scope.dispose(); assert.equal(cleaned, true);
  const late = new Scope(parent.signal); assert.equal(late.signal.aborted, true); late.dispose();
});

interface Save { schema: 1; checkpoint: string; position: { x: number; z: number } }
function validate(value: unknown): Save {
  const save = value as Save;
  if (save?.schema !== 1 || typeof save.checkpoint !== 'string' || !Number.isFinite(save.position?.x) || !Number.isFinite(save.position?.z)) throw new Error('Invalid save');
  return structuredClone(save);
}
const legacy: Save = { schema: 1, checkpoint: 'arrival', position: { x: 2, z: -4 } };
test('SaveStore preserves exact raw legacy key/schema and detaches memory', () => {
  const stored = new Map([['dragon-raja.save.v1', JSON.stringify(legacy)]]), keys: string[] = [];
  const store = new SaveStore({ key: 'dragon-raja.save.v1', validate, storage: {
    getItem(key) { keys.push(key); return stored.get(key) ?? null; }, setItem(key, text) { keys.push(key); stored.set(key, text); },
  } });
  assert.deepEqual(store.read(), legacy); assert.equal(store.persistent, true);
  const changed = structuredClone(legacy); changed.checkpoint = 'departure'; store.write(changed); changed.position.x = 999;
  assert.equal(store.read()!.position.x, 2); assert.deepEqual(JSON.parse(stored.get('dragon-raja.save.v1')!), { ...legacy, checkpoint: 'departure' });
  assert.ok(keys.every(key => key === 'dragon-raja.save.v1'));
});

test('storage getter/getItem/setItem SecurityError falls back to usable memory', () => {
  const denied = () => { throw new DOMException('denied', 'SecurityError'); };
  const options: SaveStoreOptions<Save> = { key: 'save', validate, get storage() { return denied(); } };
  const getter = new SaveStore(options); assert.equal(getter.persistent, false); getter.write(legacy); assert.deepEqual(getter.read(), legacy);
  const readDenied = new SaveStore({ key: 'save', validate, storage: { getItem: denied, setItem() {} } });
  readDenied.write(legacy); assert.deepEqual(readDenied.read(), legacy); assert.equal(readDenied.persistent, false);
  const writeDenied = new SaveStore({ key: 'save', validate, storage: { getItem() { return null; }, setItem: denied } });
  writeDenied.write(legacy); assert.equal(writeDenied.persistent, false); assert.deepEqual(writeDenied.read(), legacy);
});

test('invalid or corrupt saves remain content errors and do not replace the previous memory save', () => {
  const store = new SaveStore({ key: 'save', validate }); store.write(legacy);
  assert.throws(() => store.write({ ...legacy, schema: 2 } as unknown as Save), /Invalid save/); assert.deepEqual(store.read(), legacy);
  const corrupt = new SaveStore({ key: 'save', validate, storage: { getItem: () => '{', setItem() {} } });
  assert.throws(() => corrupt.read(), SyntaxError); assert.equal(corrupt.persistent, true);
});

test('StoryRunner keeps stable checkpoints, one command per update, waits and closes skipped generators', () => {
  const events: string[] = []; let ready = false;
  const runner = new StoryRunner([
    { id: 'arrival', *run() { try { events.push('first'); yield 1; events.push('waited'); yield () => ready; events.push('ready'); } finally { events.push('closed'); } } },
    { id: 'departure', *run() { events.push('second'); yield 0; } },
  ], () => { events.push('changed'); }, () => { events.push('complete'); });
  runner.start('arrival'); runner.update(5); assert.deepEqual(events, ['changed', 'first']);
  runner.update(0.5); assert.equal(events.includes('waited'), false);
  runner.update(0.5); assert.equal(events.at(-1), 'waited');
  runner.update(10); assert.equal(events.includes('ready'), false); ready = true; runner.update(0);
  assert.equal(runner.checkpoint, 'departure'); assert.equal(events.includes('second'), false);
  runner.update(0); runner.next(); assert.equal(runner.active, false); assert.equal(events.at(-1), 'complete');
  runner.start(); runner.update(0); runner.stop(); assert.equal(events.at(-1), 'closed');
  assert.throws(() => runner.start('missing'), /Unknown/);
});

test('SpatialIndex includes rotated rectangle overlaps across negative cells and supports reindex/removal', () => {
  const index = new SpatialIndex<Rect>(8), rects: Rect[] = [];
  for (let i = 0; i < 80; i++) {
    const angle = i * 0.79, rect = { x: ((i * 41) % 101) - 50, z: ((i * 67) % 103) - 51, hw: 0.5 + i % 6, hd: 1 + i % 4, c: Math.cos(angle), s: Math.sin(angle) };
    rects.push(rect); index.add(rect);
  }
  for (let x = -60; x <= 60; x += 3) for (let z = -60; z <= 60; z += 5) {
    const candidates = index.query(x, z, 1);
    for (const rect of rects) {
      const dx = x - rect.x, dz = z - rect.z;
      // A circle hit in local rectangle space must be retained by the broad phase.
      if (Math.abs(dx * rect.c + dz * rect.s) <= rect.hw + 1 && Math.abs(-dx * rect.s + dz * rect.c) <= rect.hd + 1) {
        // The expanded local rectangle includes corner false positives. Check actual nearest distance.
        const lx = Math.max(Math.abs(dx * rect.c + dz * rect.s) - rect.hw, 0), lz = Math.max(Math.abs(-dx * rect.s + dz * rect.c) - rect.hd, 0);
        if (lx * lx + lz * lz <= 1) assert.ok(candidates.has(rect), `miss at ${x},${z}`);
      }
    }
  }
  const moved = rects[0]; moved.x = 300; moved.z = 300; const remove = index.add(moved);
  assert.ok(index.query(300, 300).has(moved)); assert.equal(index.query(-50, -51).has(moved), false);
  remove(); remove(); assert.equal(index.size, 79); index.clear(); assert.equal(index.size, 0);
  assert.throws(() => index.query(NaN, 0), /finite/); assert.throws(() => index.query(0, 0, 1e12), /too many/);
});
