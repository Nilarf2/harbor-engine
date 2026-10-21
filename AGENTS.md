# Working in Harbor · Harbor 协作指南

Harbor is an experimental browser 3D engine with a CPU-only simulation core, a native-scene application host, optional Rapier physics, a quality WebGPU path tracer integrated from three-gpu-pathtracer, a compact reference compute tracer, and a Three.js raster view. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/APPLICATION.md`, and `docs/AI_GUIDE.md` before substantial changes. Public-facing titles, introductions and new documentation should provide Chinese and English. Keep package names, source identifiers, URLs and schema fields stable in English.

本项目的公共标题、介绍和新增文档提供中英双语；包名、源码标识符、URL 与 schema 字段保持稳定英文。应用负责剧情、UI、输入、平台和具体碰撞规则，引擎只承载可复用能力。修改前阅读对应公开合同，不将旧版本 GPU 验证当成新功能验收。

## Build games through the engine

- Put a new game's scenes, rules, input, UI, and platform integration in its own application/content directory. Use the public `@harbor/engine` package entries. Do not rewrite engine internals to add a level, quest, character controller input binding, score rule, or visual composition.
- Edit `src/` when fixing an engine defect or deliberately extending a reusable capability. Read the existing implementation and preserve other contributors' changes. Keep `src/core/` independent of Three.js, DOM globals, and GPU APIs.
- Use stable authored entity IDs and `entity.data` for game-specific JSON. Call `validateScene()` before loading generated content. Unknown scene fields are errors; consult `docs/scene.schema.json` and `src/core/types.ts` instead of guessing.
- Use `world.spawn()` and `world.remove()` so plugin/view observers receive lifecycle events. Use physics commands for physics-owned transforms. Static batched visuals must remain static; replace them through lifecycle methods when necessary.
- Install asynchronous dependencies before synchronous plugin `setup()`. Register owned systems, events, commands, and resources with `scope.add()`. Dispose independent renderers, actors, and asset handles explicitly.
- Use `createApplication()` for application-owned native scenes/cameras/postprocessing. Its `step(seconds)` updates once with exact seconds; `createGame().step(count)` still advances fixed ticks. Scene factories return fresh instances. Prepare resources in `load`, restore state before synchronous `enter`, and await view/GPU disposal before releasing its assets. Context `signal` equals `scope.signal`; cancellation aborts the signal immediately, but deferred cleanup waits for scene disposal.
- Preserve existing save keys and schema through `SaveStore<T>` when migrating applications. Do not silently wrap raw legacy saves in the namespaced platform envelope. `SpatialIndex` is a broad phase only; keep application-specific collision and walkable-height rules explicit.

## Verify the behavior you change

```sh
npm ci
npm run build:engine
npm run create-game -- ../my-game
npm run scene -- new games/my-game
npm run scene -- validate games/my-game/scene.json
npm run scene -- simulate games/my-game/scene.json --steps 180
npm test
npm run build
```

`scene new` creates a scene file, not a complete game scaffold. Build engine modules before importing package exports from Node.js. Add focused tests for simulation invariants, lifecycle defects, or public contract changes. Use existing browser checks for rendering changes where the environment supports them. Do not turn a software-adapter frame rate into a hardware performance claim.

## Preserve rendering and licensing boundaries

- `createGame({ mode: 'pathtrace' })` uses the quality native WebGPU backend. `trace.backend: 'compact'` selects the smaller constant-material reference tracer; raster is a separate view with WebGL2 fallback. Both tracing backends intersect geometry and do not claim a standard hardware RT-core API.
- Prefer the quality adapter's full Three scene for imported meshes, textures, HDR lighting and physical materials/cameras. Read `src/pathtracing/index.ts` and the GLB ownership recipe in `docs/AI_GUIDE.md`; application-owned scene resources must outlive the renderer. Native transforms, material changes and deformation need the appropriate update calls.
- Do not copy the compact backend's texture/skinning limitations onto the quality backend, or claim every upstream feature has been validated here. Packaged OIDN dependencies/weights do not establish device acceptance; record actual refinement/denoising checks separately. Continuous skinned/morph tracing and target-device frame rates need their own evidence.
- `fromWorld()`/`fromThreeScene()` in `@harbor/engine/raytrace` are compact snapshots; `updateGeometry()` refits unchanged topology and resets accumulation after changed geometry. Prefer `createGame()` and the independent generator before rebuilding application orchestration.
- Keep external assets local when required by a build, document their origins, and preserve notices. The included mannequin and adapted asset utilities retain their upstream MIT attribution. Do not copy the reference game's novel, map, or elevation content into a new game by default.
- Keep secrets and private machine configuration out of scenes, diagnostics, bundles, documentation, and git history. Refer to the repository's actual supported platform adapter API; do not claim host integration based solely on a ZIP export.

Report the result, checks actually run, and remaining limits. When extending an API, update its types, relevant tests, scene schema when applicable, and the guide so the next AI can use it without reading the entire engine.
