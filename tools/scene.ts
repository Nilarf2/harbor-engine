import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateScene, createWorld } from '../src/core/index.js';

async function main() {
  const [action, file, ...args] = process.argv.slice(2);
  if (action === 'new' && file) {
    const directory = resolve(file); await mkdir(directory, { recursive: true });
    const scene = { version: 1, name: 'My first Harbor scene', seed: 42, entities: [
      { id: 'ground', position: [0, -0.5, 0], visual: { shape: 'box', size: [20, 1, 20], color: '#91aa91', batch: true }, body: { type: 'fixed', shape: 'box', size: [20, 1, 20] } },
      { id: 'player', position: [0, 2, 0], tags: ['player'], visual: { shape: 'capsule', size: [0.7, 1.8, 0.7], color: '#ffbb55' }, body: { type: 'character', shape: 'capsule', size: [0.7, 1.8, 0.7] } },
      { id: 'crate', position: [2, 4, 0], visual: { shape: 'box', size: [1, 1, 1], color: '#e47d54' }, body: { type: 'dynamic', shape: 'box', size: [1, 1, 1], mass: 1 } },
    ] };
    await writeFile(join(directory, 'scene.json'), JSON.stringify(scene, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ ok: true, file: join(directory, 'scene.json'), next: 'npm run scene -- simulate <path>/scene.json --steps 180' }));
    return;
  }
  if (!file || !['validate', 'simulate'].includes(action)) throw new Error('Usage: npm run scene -- validate|simulate <scene.json> [--steps 180] | new <directory>');
  const scene = validateScene(JSON.parse(await readFile(resolve(file), 'utf8')));
  if (action === 'validate') {
    console.log(JSON.stringify({ ok: true, name: scene.name, entities: scene.entities.length, bodies: scene.entities.filter(e => e.body).length })); return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--steps')) throw new Error('Only --steps <integer> is supported');
  const steps = args.length ? Number(args[1]) : 180;
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > 36000) throw new Error('steps must be an integer from 0 to 36000');
  const world = createWorld(scene);
  try {
    if (scene.entities.some(e => e.body)) {
      const { createRapierPlugin } = await import('../src/physics/index.js');
      world.install(await createRapierPlugin());
    }
    world.step(steps);
    const state = world.snapshot();
    console.log(JSON.stringify({ ok: true, gpuRequired: false, checksum: createHash('sha256').update(JSON.stringify(state)).digest('hex'), state }, null, 2));
  } finally { world.dispose(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
