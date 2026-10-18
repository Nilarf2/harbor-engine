import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPlatform } from '../src/platform/index.js';
const isScore = (x: unknown): x is { score: number } => typeof x === 'object' && x !== null && Number.isFinite((x as {score: number}).score);
test('sandbox without storage retains a session save and validates it', () => {
  const platform = createBrowserPlatform('test', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(platform.save('game', { score: 3 }), false);
  assert.deepEqual(platform.load('game', isScore), { score: 3 });
  platform.save('game', { score: 'bad' }); assert.equal(platform.load('game', isScore), undefined);
  platform.dispose(); assert.equal(platform.load('game', isScore), undefined);
});
