import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'harbor-independent-'));
const game = join(directory, 'Independent Consumer');
const npmEntry = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  .find(path => path && /(?:npm|npm-cli)\.js$/.test(path) && existsSync(path));
if (process.platform === 'win32' && !npmEntry) throw new Error('Cannot find npm CLI; run through npm run check:consumer');
const npm = args => execFileSync(npmEntry ? process.execPath : 'npm', [...(npmEntry ? [npmEntry] : []), ...args], {
  cwd: game, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
});
try {
  const generated = JSON.parse(execFileSync(process.execPath, [join(root, 'tools/create-game.mjs'), game], { cwd: root, encoding: 'utf8' }));
  assert.equal(generated.ok, true);
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  // These run wholly outside the checkout, using only the vendored tarball.
  npm(['run', 'validate']); npm(['run', 'simulate']); npm(['run', 'build']);
  const checkFile = join(game, 'check-public-contracts.mjs');
  await writeFile(checkFile, `
import assert from 'node:assert/strict';
import { Scope, createWorld } from '@harbor/engine';
import { createApplication, FrameLoop, SceneManager } from '@harbor/engine/application';
import { SaveStore } from '@harbor/engine/platform';
import { StoryRunner } from '@harbor/engine/narrative';
import { SpatialIndex } from '@harbor/engine/spatial';
assert.equal(typeof createApplication, 'function'); assert.equal(typeof SceneManager, 'function');
const scope = new Scope(); scope.dispose(); assert.equal(scope.signal.aborted, true);
const world = createWorld({ version: 1, name: 'independent', entities: [] }); world.step(1); assert.equal(world.tick, 1); world.dispose();
const seconds = []; const loop = new FrameLoop(); loop.add(dt => seconds.push(dt)); loop.step(1); assert.deepEqual(seconds, [1]); loop.dispose();
const save = new SaveStore({ key: 'legacy.v1', validate: value => structuredClone(value) }); save.write({ schema: 1 }); assert.deepEqual(save.read(), { schema: 1 });
assert.equal(new SpatialIndex().size, 0); assert.equal(typeof StoryRunner, 'function');
`);
  execFileSync(process.execPath, [checkFile], { cwd: game, encoding: 'utf8', stdio: 'pipe' });
  const weights = JSON.parse(await readFile(join(game, 'public/oidn/manifest.json'), 'utf8'));
  const delivered = await readFile(join(game, 'dist/oidn', weights.file));
  assert.equal(delivered.length, weights.bytes);
  assert.equal(createHash('sha256').update(delivered).digest('hex'), weights.sha256);
  const packed = JSON.parse(await readFile(join(game, 'node_modules/@harbor/engine/package.json'), 'utf8'));
  for (const entry of Object.values(packed.exports)) {
    for (const target of Object.values(entry)) await readFile(join(game, 'node_modules/@harbor/engine', target));
  }
  const archive = await readFile(join(game, 'vendor/engine.tgz'));
  console.log(JSON.stringify({ ok: true, platform: process.platform, version: packed.version,
    packageBytes: archive.length, packageSha256: createHash('sha256').update(archive).digest('hex'),
    exports: Object.keys(packed.exports).length, sameOriginWeights: { bytes: delivered.length, sha256: weights.sha256 },
    checks: ['independent install', 'scene validation', '180 simulation ticks', 'production build', 'public CPU imports', 'packaged export targets', 'dist OIDN hash'],
  }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
