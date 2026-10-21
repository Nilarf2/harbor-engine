import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));

async function destinationState(destination) {
  let info;
  try { info = await lstat(destination); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Destination must be a new or empty regular directory');
  if ((await readdir(destination)).length) throw new Error('Destination is not empty; no files were changed');
  return 'empty';
}

export async function createGameProject(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Provide a new project directory');
  const destination = resolve(input);
  await destinationState(destination);
  const templateRoot = join(engineRoot, 'templates/minimal');
  const withinTemplates = relative(join(engineRoot, 'templates'), destination);
  // Windows relative() returns an absolute path when the destination is on a
  // different drive. That is outside templates, just like a parent-relative path.
  if (!isAbsolute(withinTemplates) && withinTemplates !== '..' && !withinTemplates.startsWith(`..${sep}`)) throw new Error('Create games outside the engine templates directory');
  for (const file of ['lib/core/index.js', 'lib/browser/index.js']) {
    try { await lstat(join(engineRoot, file)); }
    catch { throw new Error('Build the engine first: npm run build:engine'); }
  }
  const packDirectory = await mkdtemp(join(tmpdir(), 'harbor-package-'));
  let staging;
  try {
    // Windows cannot exec a .cmd file directly. Invoke npm's JS entry without
    // introducing a shell or interpolating destination paths into shell text.
    const npmEntry = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
      .find(path => path && /(?:npm|npm-cli)\.js$/.test(path) && existsSync(path));
    if (process.platform === 'win32' && !npmEntry) throw new Error('Cannot find npm CLI; run through npm run create-game');
    const command = npmEntry ? process.execPath : 'npm';
    const args = [...(npmEntry ? [npmEntry] : []), 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', packDirectory];
    const output = execFileSync(command, args, {
      cwd: engineRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
    });
    const [packed] = JSON.parse(output);
    if (!packed?.filename || basename(packed.filename) !== packed.filename) throw new Error('npm pack did not produce a valid local package');
    await mkdir(dirname(destination), { recursive: true });
    staging = await mkdtemp(join(dirname(destination), `.${basename(destination)}.harbor-`));
    for (const name of await readdir(templateRoot)) {
      await cp(join(templateRoot, name), join(staging, name), { recursive: true, force: false, errorOnExist: true });
    }
    const licenseDirectory = join(staging, 'public/licenses');
    await mkdir(licenseDirectory, { recursive: true });
    await cp(join(engineRoot, 'public/licenses'), licenseDirectory, { recursive: true });
    await cp(join(engineRoot, 'public/oidn'), join(staging, 'public/oidn'), { recursive: true });
    await copyFile(join(engineRoot, 'NOTICE.md'), join(licenseDirectory, 'NOTICE.md'));
    await mkdir(join(staging, 'vendor'));
    await copyFile(join(packDirectory, packed.filename), join(staging, 'vendor/engine.tgz'));
    const packageFile = join(staging, 'package.json');
    const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
    manifest.name = basename(destination).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'harbor-game';
    await writeFile(packageFile, JSON.stringify(manifest, null, 2) + '\n');
    // Re-check after packaging; never merge into files created while the tool ran.
    if (await destinationState(destination) === 'empty') await rmdir(destination);
    await rename(staging, destination); staging = undefined;
    return { ok: true, directory: destination, enginePackage: 'vendor/engine.tgz',
      next: ['npm install', 'npm run validate', 'npm run simulate', 'npm run dev', 'npm run build'] };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(packDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    console.log('Usage: npm run create-game -- <new-project-directory>');
    if (args[0] !== '--help') process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await createGameProject(args[0]), null, 2)); }
    catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
  }
}
