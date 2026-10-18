import { readFile } from 'node:fs/promises';
import { validateScene, createWorld } from '@harbor/engine';
const scene = validateScene(JSON.parse(await readFile(new URL('../src/scene.json', import.meta.url), 'utf8')));
if (!process.argv.includes('--simulate')) console.log(JSON.stringify({ ok: true, entities: scene.entities.length }));
else {
  const world = createWorld(scene);
  try {
    const { createRapierPlugin } = await import('@harbor/engine/physics');
    world.install(await createRapierPlugin()); world.step(180);
    console.log(JSON.stringify({ ok: true, gpuRequired: false, snapshot: world.snapshot() }, null, 2));
  } finally { world.dispose(); }
}
