import { createGame, type BrowserGame } from '@harbor/engine/browser';
import { validateScene, type Plugin } from '@harbor/engine';
import sceneJson from './scene.json';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const query = new URLSearchParams(location.search);
const mode = query.get('mode') === 'raster' ? 'raster' : 'pathtrace';
const traceBackend = query.get('trace') === 'compact' ? 'compact' : 'quality';
let game: BrowserGame | undefined;

const controls: Plugin = {
  id: 'game:controls', requires: ['physics'],
  setup(world, scope) {
    const held = new Set<string>(); let jump = false;
    const keys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    const down = (event: KeyboardEvent) => {
      if (!keys.has(event.code)) return;
      event.preventDefault(); held.add(event.code);
      if (event.code === 'Space' && !event.repeat) jump = true;
    };
    const up = (event: KeyboardEvent) => { held.delete(event.code); };
    const blur = () => { held.clear(); jump = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    scope.add(() => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); });
    scope.add(world.addSystem({ id: 'game:movement', update() {
      const x = Number(held.has('KeyD') || held.has('ArrowRight')) - Number(held.has('KeyA') || held.has('ArrowLeft'));
      const z = Number(held.has('KeyS') || held.has('ArrowDown')) - Number(held.has('KeyW') || held.has('ArrowUp'));
      const speed = 4 / Math.max(1, Math.hypot(x, z));
      world.command({ type: 'physics:move', id: 'player', velocity: [x * speed, 0, z * speed], jump }); jump = false;
    } }));
    scope.add(world.addSystem({ id: 'game:camera', phase: 'afterPhysics', update() {
      const player = world.get('player')!;
      const [x, y, z] = player.position.map(value => Math.round(value * 1000) / 1000);
      game?.setCamera({ position: [x + 7, y + 5, z + 8], target: [x, y, z], fov: 48 });
    } }));
  },
};

try {
  game = await createGame({ canvas, scene: validateScene(sceneJson), mode, plugins: [controls],
    autoStart: !query.has('test'), backend: query.get('backend') === 'webgl' ? 'webgl' : 'auto',
    camera: { position: [7, 6.2, 8], target: [0, 1.2, 0], fov: 48 },
    trace: { backend: traceBackend, width: Number(query.get('width')) || 640, height: Number(query.get('height')) || 360,
      maxBounces: Number(query.get('bounces')) || (traceBackend === 'quality' ? 15 : 6), live: true,
      ...(traceBackend === 'quality' ? { frameBudget: Number(query.get('budget')) || 250000, maxSamples: Number(query.get('samples')) || 0 } : {}) },
    onError(error) { status.textContent = error.message; },
  });
  status.textContent = mode === 'pathtrace' ? `${traceBackend === 'quality' ? 'Physical' : 'Compact'} path tracing — stand still to refine the image.` : 'Ready.';
  // A small explicit inspection surface for local browser testing and AI tools.
  Object.defineProperty(window, '__HARBOR_GAME__', { value: game, configurable: true });
  window.addEventListener('pagehide', () => game?.dispose(), { once: true });
  if (import.meta.hot) import.meta.hot.dispose(() => game?.dispose());
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}
