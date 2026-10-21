# Building games with Harbor · 使用 Harbor 开发游戏

先选择应用合同：声明式 World 与固定步长使用 `createGame()`；迁移已有原生 Three.js 场景、TSL 后处理与剧情系统使用 `createApplication()`。后者的 `step(seconds)` 是一次秒更新，前者的 `step(count)` 是固定 tick 数。完整生命周期、取消、旧档兼容与通用剧情/空间模块见 [APPLICATION.md](APPLICATION.md)。游戏内容与平台适配留在独立应用；公共能力变化才修改引擎。

Choose the application contract first: `createGame()` owns a declarative World and fixed ticks; `createApplication()` hosts an existing native Three.js scene, postprocessing and story system. The latter steps in seconds, the former in tick counts. See [APPLICATION.md](APPLICATION.md) for lifecycle, cancellation, legacy saves, story and spatial modules. Keep content and host integration in the independent application.

Harbor is an experimental TypeScript engine for browser 3D games. Start by building game content against its public modules. Keep scene data, gameplay plugins, input, UI, and platform integration in your game application; change engine internals only to fix or deliberately extend a shared capability.

The core simulation and Rapier physics run on a cloud computer without a GPU. Browser path tracing uses the player's WebGPU adapter. Software rendering on a development machine can validate output and errors, but cannot establish player-device performance.

## Start with an independent game

After `npm ci` in the engine checkout, generate a portable application:

```sh
npm run create-game -- ../my-game
cd ../my-game
npm install
npm run validate
npm run simulate
npm run dev
npm run build
```

The generator builds/packages a local engine tarball into `vendor/engine.tgz` and copies the minimal template. It rejects nonempty destinations and does not install dependencies automatically. The generated project includes WASD movement, jumping, a following camera, raster/path-tracing choices, and headless scene checks. It can move to another computer without the engine checkout.

Most new games should start with the application facade:

```ts
import { createGame } from '@harbor/engine/browser';
import { validateScene } from '@harbor/engine';

const game = await createGame({ canvas, scene: validateScene(sceneJson),
  mode: 'pathtrace', physics: true,
  trace: { backend: 'quality', width: 640, height: 360, maxBounces: 8, live: true },
});
// Add game-specific plugins through the options or game.world.install().
```

`createGame()` owns the loop, fixed-tick advancement, physics setup, optional view, resizing, visibility handling, and teardown. Use `pause()`, `step(count)`, `snapshot()`, `setCamera()`, and `dispose()` for controlled operation. `invalidateScene()` rebuilds content bindings on the next paint; call `step(0)` to paint while paused. The lower-level guide below is for projects that need to customize these pieces.

## Set up and inspect the interfaces

Use Node.js 22.12 or newer. From the repository root:

```sh
npm ci
npm run build:engine
npm test
npm run build
```

`build:engine` writes the package modules and TypeScript declarations to `lib/`. Run it before using the package's `@harbor/engine` exports from Node.js or another local application. The package is a local source package; these instructions do not assume that it is published to npm. A separate game can depend on a locally built checkout.

Read these contracts before creating content:

- `src/core/types.ts`: scene and entity data.
- `src/core/index.ts`: public core exports.
- `docs/scene.schema.json`: editor schema; runtime validation adds relational checks.
- `src/physics/index.ts`: optional physics factory and commands.
- `src/pathtracing/index.ts`: quality adapter, native Three scene, physical camera and upstream controls.
- `src/raytrace/types.ts`: compact triangle scene, camera, and reference tracing API.
- `src/render/index.ts`: raster renderer API.

## Create, validate, and simulate a scene

```sh
npm run scene -- new games/my-game
npm run scene -- validate games/my-game/scene.json
npm run scene -- simulate games/my-game/scene.json --steps 180
```

`new` creates a starter `scene.json` without overwriting an existing file. It does not generate a complete application, input system, or UI. `validate` reports content validity. `simulate` loads the scene, installs physics when bodies are present, runs fixed ticks without a renderer, and prints a snapshot plus checksum. The checksum is useful for comparisons within the same engine/dependency versions; it is not a universal cross-version replay guarantee.

Use permanent, meaningful IDs such as `player`, `dock/crate-01`, and `level-2/exit`. Do not derive persistent IDs from object UUIDs, array indices, minified function names, or unseeded randomness. Keep game-specific fields inside `data`:

```json
{
  "version": 1,
  "name": "Small lighting study",
  "seed": 42,
  "fixedDelta": 0.016666666666666666,
  "entities": [
    {
      "id": "floor",
      "position": [0, -0.5, 0],
      "visual": { "shape": "box", "size": [12, 1, 12], "color": "#c8c7c0", "batch": true },
      "body": { "type": "fixed", "shape": "box", "size": [12, 1, 12] }
    },
    {
      "id": "ball",
      "position": [0, 2, 0],
      "visual": { "shape": "sphere", "size": [1, 1, 1], "color": "#d99042", "metalness": 0.8, "roughness": 0.2 },
      "body": { "type": "dynamic", "shape": "sphere", "size": [1, 1, 1], "mass": 1 },
      "tags": ["interactive"],
      "data": { "scoreValue": 10 }
    }
  ]
}
```

Coordinates are metres, Y is up, and quaternions use `[x, y, z, w]`. Sizes are full dimensions. Spheres require equal dimensions; capsules require equal width/depth and height at least the diameter. Cylinder/cone width and depth must match. Physics entities require unit scale. Colors are `#RGB` or `#RRGGBB`. Use `visual.batch` only for visuals that remain static.

Runtime input limits are positions within ±1,000,000; dimensions and scale in `[0.0001, 1000000]`; mass in `[0.000001, 1000000]`; normalized quaternions; and finite JSON numbers. These are safety bounds, not recommended scene sizes. Keep actual games near a sensible metre scale to preserve precision. Unknown fields fail validation, so a misspelling such as `postion` cannot quietly disappear.

## Run the simulation through public imports

```ts
import { createWorld, validateScene } from '@harbor/engine';
import { createRapierPlugin } from '@harbor/engine/physics';

const world = createWorld(validateScene(sceneJson));
world.install(await createRapierPlugin());
world.step(180);
console.log(world.snapshot());
world.dispose();
```

For a browser loop, call `world.advance(elapsedSeconds)` and then render once. The result reports dropped catch-up time and interpolation alpha. Do not pass elapsed seconds to `step()`; its argument is a count of fixed ticks. Input and gameplay systems run before physics by default. Use the `afterPhysics` phase for gameplay that reads collision-corrected transforms.

## Add game behavior as a plugin

```ts
import type { Plugin } from '@harbor/engine';

export const scoring: Plugin = {
  id: 'game:scoring',
  setup(world, scope) {
    scope.add(world.registerCommand('game:addScore', command => {
      if (typeof command.id !== 'string' ||
          typeof command.amount !== 'number' || !Number.isFinite(command.amount)) {
        throw new TypeError('game:addScore requires id and finite amount');
      }
      const entity = world.get(command.id);
      if (!entity) throw new Error(`Unknown entity: ${command.id}`);
      entity.data.score = Number(entity.data.score ?? 0) + command.amount;
      return entity.data.score;
    }));
    scope.add(world.addSystem({
      id: 'game:scoring:update',
      phase: 'afterPhysics',
      update(current, dt) {
        // Apply game rules using fixed dt and explicit entity IDs/tags.
        // Use current.random() when reproducible random choices are needed.
      },
    }));
  },
};
```

Every registered listener, system, command, and owned resource needs a cleanup registered with `scope.add()`. Plugin setup is synchronous; load asynchronous dependencies before `world.install()`. Declare `requires: ['physics']` when the plugin depends on the physics service. Register commands once during setup and validate their payloads. Use `world.spawn()`/`world.remove()` for membership changes so physics and views receive lifecycle events.

## Physics commands

```ts
world.command({ type: 'physics:move', id: 'player', velocity: [3, 0, 0] });
world.command({ type: 'physics:move', id: 'player', velocity: [0, 0, 0], jump: true });
world.command({ type: 'physics:impulse', id: 'crate', impulse: [0, 4, 0] });
world.command({ type: 'physics:teleport', id: 'player', position: [0, 2, 0] });
```

`move` applies persistent horizontal velocity to a character body; its Y input is ignored because the controller owns gravity/jumping. Send zero velocity when movement ends. `impulse` requires a dynamic body. `teleport` resets velocity and character jump state. Do not reposition physics entities by assigning `entity.position`: the physics system owns those transforms. To replace a collider or its dimensions, remove and re-spawn the entity.

## Choose and drive a view

For most applications use `createGame()`. Set `mode: 'pathtrace'` for the quality native WebGPU backend; `trace.backend: 'quality'` is the default. `mode: 'raster'` selects Three's WebGPU/WebGL2 view. The overall mode defaults to raster when omitted. The generated game explicitly starts in quality path tracing and offers raster compatibility mode.

The quality result is `game.pathtracing`, exposing the real `scene`, `camera`, `renderer`, and upstream `pathTracer`. Supply a caller-owned `trace.scene` to render imported GLB meshes, lights, textures and HDR environments alongside the generated world group. The scene bridge does not replace game-specific art with primitives. Configure `trace.frameBudget`, `trace.maxSamples`, `trace.maxBounces`, and internal resolution against the target device; the defaults are not measured budgets for every scene.

The owning `createPathTracingRenderer()` / `createGame()` quality adapter advances a wavefront workload; its `render()` call does not mean one sample per pixel. The native borrowed `createPathTracingView()` below defaults to a bounded complete-frame megakernel cycle instead, completing all pixels in each call; its explicit `samplingMode: 'progressive'` advances one tile. `inspect().samples` is cached and may be `null`; `await measureSamples()` performs explicit GPU readback. Camera/scene changes reset accumulation. Static refinement uses minimum per-pixel samples rather than an average; do not hide low-sample noise behind a claim of convergence.

For an application owning its native renderer, use the borrowed view and a single HDR composition:

```ts
import {
  createPathTracingView, createPathTracingOutputNode,
  createOIDNStaticDenoiser, StaticRefinementController, OIDN_LARGE_WEIGHTS,
} from '@harbor/engine/pathtracing';

const view = await createPathTracingView({ renderer, scene: physicalProxyScene, camera });
const denoiser = createOIDNStaticDenoiser({
  renderer, weightsUrl: new URL(`./oidn/${OIDN_LARGE_WEIGHTS.file}`, document.baseURI),
});
const refinement = new StaticRefinementController(view, denoiser, showDenoiseError);
const output = createPathTracingOutputNode(view.outputTexture);
// Use output.colorNode as linear HDR input to ONE final RenderPipeline.
// Keep its default outputColorTransform=true; do not manually tone-map again.

function render() {
  view.render(); refinement.tick();
  output.textureNode.value = refinement.outputTexture;
  finalPipeline.render();
}
function refine() {
  freezeCompleteWorldState(); // Includes clock, weather, trains and skeletal pose.
  refinement.start({ samples: 64 }); // 256 is the explicit longer refinement option.
}
function resume() { refinement.cancel(); resumeWorldState(); }
async function dispose() { await refinement.dispose(); await view.dispose(); }
```

These application callbacks/pipeline variables are illustrative. Keep source TSL effects in explicit composition layers or convert them to physical proxy materials; unknown shaders produce object-path diagnostics. Use `view.syncScene({ transforms: true })` for moved rigid objects, `{ geometry: [actor.root] }` for skin/morph deformation, `{ materials: true }`, `{ lights: true }`, `{ environment: true }`, `{ camera: true }`, or `{ topology: true }` as appropriate. Coalesce dirty causes per frame. `view.resize(width,height)` does not resize the caller's renderer or alter camera optics. Source geometry/BVHs remain untouched; the view owns only its compact graph/caches. The application owns renderer/device lifetime and should request actual device limits with `createQualityDevice()` before creating a renderer for large scenes. Catch unavailable WebGPU/adapter/device/capacity errors and offer raster; OIDN failure keeps the raw quality image.

Copy `public/oidn/` and its MIT/Apache license files from the engine package to the application's relative static build root. The 7.7 MB large model is fetched only when refinement is requested; never inline it into HTML or fetch it from a CDN at runtime. Its local manifest pins origin, size and SHA-256, which the loader verifies. Guides use the current private PBR graph and matching camera, with no early tone mapping. Runtime values remain linear HDR; the output helper uses top-down screen coordinates without an extra Y flip and does not require optional float32 filtering or FP16. Validate real inference and guide alignment on the target GPU before claiming support.

For a small, inspectable triangle-tracing experiment, select `trace.backend: 'compact'`, or use its lower-level API:

```ts
import { createPathTracer, fromWorld } from '@harbor/engine/raytrace';

const tracer = await createPathTracer({ canvas, width: 640, height: 360, maxBounces: 4 });
tracer.setScene(fromWorld(world));
tracer.setCamera({ position: [5, 3, 6], target: [0, 1, 0], fov: 45 });
tracer.render(); // Compact backend: one sample per pixel.
```

For unchanged compact topology/materials, `updateGeometry(fromWorld(world).triangles)` refits the CPU BVH. Topology/material changes need `setScene()`. The compact bridge captures primitive geometry and constant materials with polished dielectric transmission; it does not sample imported textures or skinning/morph animation. `fromThreeScene()` only converts supported static meshes/constants and rejects unsupported features by default. Its limits do not describe the separate quality backend. See [architecture](ARCHITECTURE.md#compact-reference-tracer).

For lower-level raster control, use `createBrowserRenderer()` from `@harbor/engine/render`, then own the loop, input, visibility and cleanup. The facade already owns those responsibilities in ordinary applications. Never label a raster fallback as path tracing.

## Load assets deliberately

For Blender-authored content, follow [Blender assets in Harbor](BLENDER.md): keep `.blend` source files, export embedded `.glb`, and define gameplay colliders separately from imported visuals.

Use `createAssetManager()` and acquire a separate handle per independent owner. The default model format is a self-contained GLB; embedded Meshopt decoding is available. External GLB buffer/image references are rejected. Draco and KTX2 decoding are not configured. An `Actor` supports independent skeletons, action blending, and completion listeners. Raster animation is supported. Quality tracing uses an explicit scene/update contract; the compact snapshot does not include actors automatically.

`Actor.fromHandle(id, handle)` takes ownership of that handle. Dispose the actor to release its skeleton, animation mixer, and template reference. Do not dispose shared template materials or geometry from one actor. Keep an asset manager alive until its dependent actors and handles have been released.

## Load a textured GLB into the quality scene

Keep the GLB's images/buffers embedded and put its licensed source at `public/models/prop.glb`. Put a licensed equirectangular HDR at `public/environments/studio.hdr`. These paths are application-owned example inputs, not assets downloaded by Harbor. The recipe uses one owner for the loaded scene; use `Actor.fromHandle()` when independent skeletal instances are needed.

```ts
import { Scene, EquirectangularReflectionMapping } from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Scope, validateScene } from '@harbor/engine';
import { createGame } from '@harbor/engine/browser';
import { createAssetManager } from '@harbor/engine/assets';

async function openAssetGame(canvas: HTMLCanvasElement) {
  const scope = new Scope();
  try {
    const assets = createAssetManager();
    scope.add(() => assets.dispose());
    const model = await assets.acquire<GLTF>('gltf', './models/prop.glb');
    scope.add(() => model.release());

    const scene = new Scene();
    scene.add(model.value.scene);
    scope.add(() => scene.remove(model.value.scene));
    const hdr = await new HDRLoader().loadAsync('./environments/studio.hdr');
    hdr.mapping = EquirectangularReflectionMapping;
    scene.environment = hdr;
    scope.add(() => hdr.dispose());

    const game = await createGame({
      canvas,
      scene: validateScene({ version: 1, name: 'Asset scene', entities: [] }),
      mode: 'pathtrace',
      camera: { position: [4, 3, 6], target: [0, 1, 0],
        fov: 45, focusDistance: 6, fStop: 8 },
      trace: { backend: 'quality', scene, live: false, maxBounces: 8 },
    });
    scope.add(() => game.dispose());

    return {
      game,
      moveModel(x: number) {
        model.value.scene.position.x = x;
        game.pathtracing!.pathTracer.updateTransforms();
        game.pathtracing!.reset(); // Also invalidate the adapter's cached sample count.
      },
      dispose: async () => {
        game.dispose();
        await game.pathtracing?.dispose();
        scope.dispose();
      },
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}
```

Material edits use upstream `updateMaterials()`; light/environment edits use their corresponding update methods. Replacing an environment with a nearest-filter texture should use the adapter's `invalidateScene()` so its filtering normalization runs. Ordinary geometry edits also require invalidation and BVH rebuilding. Reset the adapter's cached accumulation state after calling native update APIs. Add/remove imported objects before `game.invalidateScene()`; the next paint synchronizes the scene, or call `game.step(0)` while paused. Keep geometry, materials, textures and handles alive until the game has been disposed. The cleanup above stops the game, awaits quality GPU cleanup, removes the imported scene, and releases its shared asset handle. `BrowserGame.dispose()` itself is synchronous; the quality adapter's idempotent `dispose()` returns the same completion promise when called again.

The upstream WebGPU path tracer has a `SkinnedMeshBVH` path, but `updateTransforms()` only updates object matrices. It is not a skeletal/morph animation update loop. Ordinary geometry edits and animated deformation need the renderer's explicit rebuild/refit contract and separate validation; do not claim that `actor.update(dt)` alone updates traced geometry. Harbor currently makes no validated continuous skinning/morph-performance guarantee. VRM, humanoid retargeting, foot IK, and path-traced MToon remain future optional character work.

## Inspect and optimize a GLB offline

From the engine checkout, use the CPU-only asset tool before importing a new model:

```sh
npm run assets -- inspect path/to/source.glb
npm run assets -- optimize path/to/source.glb path/to/model.meshopt.glb
```

The tool prints JSON with geometry/animation counts, glTF Validator results, hashes, and raw/gzip/Brotli byte sizes. Input must be a self-contained GLB. It never fetches external buffers or textures. Optimization accepts original uncompressed assets with supported extensions; unknown extensions such as VRM are rejected rather than silently stripped. Existing output paths and the source are never overwritten, including concurrent attempts to create the same output. Keep source art and its attribution alongside generated assets.

The default operation applies only lossless Meshopt compression. It preserves node and animation structure, material definitions, custom `extras`, images, morph/skin data, and the exact decoded numeric bytes. It does not quantize, simplify, reorder triangles, merge nodes, resample animation, or recompress textures. Each compressed buffer view is decoded and compared byte-for-byte, then glTF Transform compares every interpreted accessor. Tests also load the result with Three's runtime Meshopt decoder. The Khronos validator currently reports that it cannot validate the Meshopt extension itself; that limitation is included in the report.

Compression is retained only if the complete raw GLB becomes smaller. Otherwise the new output is an exact input copy. Check `savedGzipBytes`, `savedBrotliBytes`, and `deliveryWarning`: a smaller raw GLB can still be larger after HTTP compression. Choose the asset that is smaller under the host's actual encoding. Compression changes delivery and decoding costs; it does not reduce triangle count or promise a higher frame rate. KTX2 output, texture resizing, and navigation baking are not part of this command.

## Verify and export

```sh
npm run scene -- validate games/my-game/scene.json
npm run scene -- simulate games/my-game/scene.json --steps 180
npm test
npm run build
npm run dev
```

Use the local browser preview to inspect controls, rendering errors, and output. A software WebGPU adapter is useful for shader/renderer checks; neither successful compilation nor a screenshot proves real-device performance. Add focused tests for new gameplay invariants and engine bugs. Avoid claiming a check passed unless it was actually run, and preserve diagnostic output when a check fails.

`npm run export` builds and packages the current demo application into `deliverables/harbor-demo-web.zip`, with a content manifest in `dist/harbor-manifest.json`. A new game's application must be wired into the build before using that export. Keep relative asset paths and upload all build files. Verify host-specific iframe permissions, storage, package limits, input, audio activation, and actual WebGPU availability against the selected platform. A generic export is not proof of a completed Bilibili Toy or VibeHub integration.

原生应用应以 `createPathTracingView` 复用共享 renderer，默认完整帧模式会完成所有有界 tile；如显式选择 progressive，调用方必须承认它只是逐块推进。精修必须冻结完整世界状态，等待最小像素采样达到 64/256，再加载随应用同源打包、固定 SHA 的 OIDN 权重。初始化、推理或取消失败都保留 raw HDR；用同一代理场景/相机生成导引，最终合成只执行一次色调映射和输出转换。真实 GPU、朝向和最终复合画面通过前不能声明硬件支持。
