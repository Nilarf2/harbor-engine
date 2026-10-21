import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve('dist');
const files = [];
async function walk(directory) {
  for (const name of (await readdir(directory)).sort()) {
    if (directory === root && name === 'harbor-manifest.json') continue;
    const path = resolve(directory, name), info = await stat(path);
    if (info.isDirectory()) await walk(path);
    else files.push({ path: relative(root, path), bytes: info.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
await walk(root);
if (!files.some(f => f.path === 'index.html')) throw new Error('dist/index.html missing');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = { engine: '@harbor/engine', version, entry: 'index.html', static: true, isolatedRequired: false, bytes: files.reduce((s,f)=>s+f.bytes,0), files };
await writeFile('dist/harbor-manifest.json', JSON.stringify(manifest, null, 2));
await mkdir('deliverables', { recursive: true });
// A fresh archive prevents obsolete files from surviving subsequent exports.
const output = resolve('deliverables/harbor-demo-web.zip');
const temporary = resolve('deliverables/harbor-demo-web.tmp.zip');
const { rm, rename } = await import('node:fs/promises');
await rm(temporary, { force: true });
execFileSync('zip', ['-q', '-r', temporary, '.'], { cwd: root });
await rename(temporary, output);
console.log(JSON.stringify({ ok: true, output, bytes: (await stat(output)).size, uncompressedBytes: manifest.bytes, files: files.length }));
