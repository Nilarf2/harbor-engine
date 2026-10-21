# Harbor Engine

A modular TypeScript engine for AI-assisted browser games. Develop and test simulation on a computer without a GPU; render on the player's GPU. Keep the engine and replace the scene, assets, and gameplay plugins for the next game.

**Status: 0.1 experimental alpha.** The default path-tracing mode uses the native WebGPU backend of [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). It traces scene geometry and multi-bounce light transport, including textures, physical materials, and HDR lighting. A smaller custom compute tracer remains available as a reference backend. Neither claims a standard hardware RT-core API.

The latest [validation record](docs/VALIDATION.md) includes 61 passing Node tests, a production build, native GTX 1070 graphics acceptance, and measured quality-tracing budgets, alongside earlier software-adapter and independent-game checks. Short runs on one desktop GPU do not establish mobile or general game performance, sustained behavior, or Tidewater-level visual parity.

## Start a new game

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run create-game -- ../my-game
cd ../my-game
npm install
npm run dev
```

The generated project contains its own engine tarball, scene, movement/jumping, camera, build configuration, and license notices. It can move to another computer without this checkout. Edit its game code and `src/scene.json`; use the engine's public APIs instead of copying its internals.

```ts
import { createGame } from '@harbor/engine/browser';
import { validateScene } from '@harbor/engine';

const game = await createGame({
  canvas: document.querySelector('canvas')!,
  scene: validateScene(sceneJson),
  mode: 'pathtrace',
  trace: { backend: 'quality', maxBounces: 8, live: true },
});
```

`quality` is the default when `mode` is `pathtrace`. `live: true` advances simulation and updates changed world transforms; `live: false` accumulates a still view. Moving content restarts accumulation and can remain noisy. Omitting `mode` selects the raster renderer. The standalone template selects path tracing explicitly and offers raster mode for compatibility.

Start an AI coding agent with [AGENTS.md](AGENTS.md) and [the game-building guide](docs/AI_GUIDE.md). The guide includes an embedded GLB/HDR recipe, plugin ownership, physics commands, and offline tools. Scene data has a [JSON Schema](docs/scene.schema.json) and strict runtime validation.

Blender models can enter through embedded GLB exports; see the [Blender workflow](docs/BLENDER.md) for materials, scale, loading, and separate gameplay colliders.

## Rendering choices

| Choice | Purpose and supported interface |
| --- | --- |
| `mode: 'pathtrace'`, `trace.backend: 'quality'` | Native WebGPU path tracing through `three-gpu-pathtracer`: real Three scenes, standard/physical materials, texture and normal maps, HDR environments, physical camera, native update APIs |
| `mode: 'pathtrace'`, `trace.backend: 'compact'` | Harbor's small WGSL compute reference: constant materials, primitive/static-triangle conversion, CPU BVH build/refit, progressive accumulation and linear readback |
| `mode: 'raster'` | Three WebGPU rendering with a WebGL2 fallback, PBR, shadows, spatial instancing, optional bloom and an analytic ocean |

The quality backend exposes `game.pathtracing.scene` and `game.pathtracing.pathTracer` for imported assets and upstream controls. The compact backend exposes `game.tracer`. Declarative scene primitives are a convenience; they are not the only content the quality backend can render. Both path-tracing backends require WebGPU in HTTPS or localhost. A WebGL2 raster fallback is a different rendering mode and is labeled accordingly.

The quality adapter reuses an actively developed upstream implementation rather than duplicating texture, material, sampling, and camera infrastructure. Its full material API is broader than the features exercised by Harbor's tests. BVH construction can block on the CPU, animated/deformed geometry needs explicit synchronization, and custom TSL/MToon shaders need a conversion strategy. Exposed OIDN/FSR integration points are optional: no denoising weights are downloaded by default, and denoising has not been validated here.

The compact tracer deliberately has narrower support: no textures, normal maps, HDR importance sampling, skinning/morph conversion, denoiser, nested-medium stack, dispersion, or dedicated area-light/caustic sampling. Its glass is polished; roughness applies to the opaque branch. See [architecture](docs/ARCHITECTURE.md) for precise backend boundaries.

## Reusable modules

| Import | Responsibility |
| --- | --- |
| `@harbor/engine` | GPU-free fixed-tick world, stable entities, validation, seeded random numbers, systems, commands and scoped plugins |
| `@harbor/engine/browser` | Application loop, optional modules, camera, visibility, resizing and cleanup |
| `@harbor/engine/pathtracing` | Quality WebGPU adapter, Three scene bridge, physical camera and upstream rendering controls |
| `@harbor/engine/raytrace` | Compact compute tracer, triangle scenes, CPU BVH build/refit and static mesh conversion |
| `@harbor/engine/render` | Three WebGPU/WebGL2 raster view and reusable visual effects |
| `@harbor/engine/physics` | Optional Rapier WASM: rigid bodies, collisions, CCD and character movement |
| `@harbor/engine/assets` | Shared loads, cancellation, resource ownership, embedded GLB/Meshopt and skeletal actors |
| `@harbor/engine/platform` | Browser/iframe baseline and validated saves with storage-denied fallback |

The root import has no DOM, Three.js, or GPU dependency. Game-specific content and input belong in a separate application. Optional capabilities remain outside the simulation core.

## Inspect content without a GPU

```sh
npm run scene -- validate demo/scene.json
npm run scene -- simulate demo/scene.json --steps 180
npm run assets -- inspect path/to/source.glb
npm run assets -- optimize path/to/source.glb path/to/new-output.glb
npm test
npm run build
```

The asset tool performs offline validation and lossless Meshopt compression while preserving nodes, animations, metadata and decoded geometry. It never overwrites source/existing files or fetches external dependencies. Reports include raw, gzip and Brotli sizes: compression does not always improve delivery size. Texture conversion, KTX2 output, and navigation baking are not implemented by this command.

## Examples and browser checks

```sh
npm run dev
```

Open `http://localhost:5190/` for the lighting study. The secondary `?scene=island&mode=play` example exercises physics, characters, collectibles, touch controls and raster effects. Examples are test applications; the reusable engine and generated game are the main deliverables.

Use `?trace=compact` for the explicit compact reference view. The raster example can use `backend=webgl` to exercise its WebGL2 fallback.

Browser checks require an installed Chromium and a functioning graphics adapter, including a software adapter for functional tests:

```sh
npm run build
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
CHROMIUM_PATH=/usr/bin/chromium npm run test:render
node tests/pathtracing.mjs
```

For Windows/desktop hardware checks and measured quality-tracing budgets, follow [hardware validation](docs/HARDWARE_VALIDATION.md). Set `HARBOR_GPU_MODE=hardware` to stop forcing a software adapter. `npm run bench:gpu` records serial dispatch timing and measured samples; it requires hardware by default.

The checked-in CI runs Node tests and a build, then uploads build artifacts. It does not assume that a hosted runner can execute WebGPU. Local software rendering validates only the tested paths, not real player-device frame rates. Commands and recorded evidence are in [VALIDATION.md](docs/VALIDATION.md).

## Export

```sh
npm run export
```

This packages the current demo as `deliverables/harbor-demo-web.zip`, with relative URLs, licenses, and a SHA-256 asset manifest. A generated game builds its own `dist/`. The application is a static web build; deployment must use HTTP/HTTPS. WebGPU availability, iframe permissions, storage, and download limits still depend on the selected host.

Bilibili Toy and VibeHub are intended distribution destinations. Account publishing, platform-specific SDKs, achievements, and host acceptance are not integrated or certified. Keep those integrations in an application/platform adapter.

## Further development

Prioritize measured needs: denoising and temporal stability, animated-character synchronization, asset residency/LOD, CPU worker BVH construction, optional navigation, and local texture-transcoder packaging. [Research notes](docs/RESEARCH.md) distinguish implemented dependencies from candidates such as MuTracer, Recast, and KTX/Basis. Tidewater, PlayCanvas, VRM Game Starter, and the Three.js WebGPU Template informed the design; their complete capabilities are not implied by a reference.

## Contributors and license

- **Nilarf2** — project owner, product direction and requirements.
- **Codex (OpenAI)** — AI programming co-contributor: implementation, integration, tooling, documentation and validation.

Harbor code and original examples use MIT. Third-party packages retain their licenses. Asset lifetime/animation helpers and the original procedural mannequin derive from Nilarf2's MIT-licensed Dragon Raja project; novel, map and location assets are excluded. Tidewater game code and art were not copied. See [NOTICE.md](NOTICE.md).
