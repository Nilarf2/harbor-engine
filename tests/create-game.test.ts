import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'tools/create-game.mjs');

test('project generator refuses nonempty destinations without changing user files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-generator-guard-'));
  try {
    await writeFile(join(directory, 'keep.txt'), 'user work');
    const result = spawnSync(process.execPath, [cli, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /not empty/);
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'user work');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('project generator bundles a portable local engine without installing dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-generator-portable-'));
  try {
    // The public generator packages compiled exports, exactly as its npm script does.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['run', 'build:engine'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    const destination = join(directory, 'My New Game'); await mkdir(destination);
    const result = JSON.parse(execFileSync(process.execPath, [cli, destination], { cwd: root, encoding: 'utf8' }));
    assert.equal(result.ok, true); assert.equal(result.directory, destination);
    const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'my-new-game');
    assert.equal(manifest.dependencies['@harbor/engine'], 'file:vendor/engine.tgz');
    const archive = join(destination, 'vendor/engine.tgz');
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.match(files, /package\/lib\/browser\/index\.js/);
    assert.match(files, /package\/lib\/core\/index\.js/);
    assert.match(files, /package\/docs\/AI_GUIDE\.md/);
    assert.match(await readFile(join(destination, 'public/licenses/three-gpu-pathtracer.txt'), 'utf8'), /Garrett Johnson/);
    assert.match(await readFile(join(destination, 'public/licenses/three-mesh-bvh.txt'), 'utf8'), /Garrett Johnson/);
    assert.match(await readFile(join(destination, 'public/licenses/NOTICE.md'), 'utf8'), /Notices and attribution/);
    const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    assert.ok(packedManifest.exports['./browser'], 'packed engine exposes the facade');
    assert.match(await readFile(join(destination, 'src/main.ts'), 'utf8'), /createGame/);
    assert.ok(!(await readFile(join(destination, 'src/main.ts'), 'utf8')).includes(root));
    await assert.rejects(access(join(destination, 'node_modules')));
    await assert.rejects(access(join(destination, 'package-lock.json')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
