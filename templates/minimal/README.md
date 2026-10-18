# My Harbor Game

A small independent game built with Harbor. The engine is included as `vendor/engine.tgz`; this project does not import files from the engine checkout or depend on its original path.

Use Node.js 22.12 or newer:

```sh
npm install
npm run validate
npm run simulate
npm run dev
npm run build
```

Commit the generated lockfile after installing dependencies. Deploy all of `dist/` to a static HTTPS host. Vite uses relative asset paths. Host-specific SDK and iframe permissions still require verification.

Edit `src/scene.json` for geometry/materials/physics and `src/main.ts` for game behavior and controls. `createGame()` owns the fixed-step browser loop, physics initialization, optional rendering, resizing, and cleanup. WASD/arrow keys move the player and Space jumps. This template defaults to the quality WebGPU path tracer. The two links select physical path tracing or the compatible raster view.

The tracing mode uses live physics and updates changed geometry. Movement restarts accumulation, so moving scenes can be noisy. Rendering performance has not been established for your target device. WebGPU requires a compatible browser and HTTPS/localhost; it has no silent raster substitute. The lower-level engine API remains available when the game needs custom systems, rendering, or assets.

`game.pathtracing` exposes the native Three `scene`, physical `camera`, and complete upstream `pathTracer`. Add imported GLB objects, textured physical materials, lights, and an HDR environment to that scene, then call `game.invalidateScene()`. Set `trace.frameBudget`, dimensions, and bounce count for the target device. Wavefront render calls are not samples per pixel; use `await game.pathtracing.measureSamples()` when sample statistics are needed. Camera options support `focusDistance` and `fStop` for depth of field. The optional `?trace=compact` view uses the smaller geometry-only reference integrator and is exposed as `game.tracer`.

The engine documentation is included in `node_modules/@harbor/engine/docs/`, including `AI_GUIDE.md`, `ARCHITECTURE.md`, and `scene.schema.json`. Run headless validation/simulation on a GPU-less workstation, and use the browser for visual checks. `window.__HARBOR_GAME__` exposes the running local game's public API for inspection and test automation.

Keep `public/licenses/` in deployed builds. It contains the engine and dependency notices copied by the generator; importing a model still requires preserving that model's own attribution.
