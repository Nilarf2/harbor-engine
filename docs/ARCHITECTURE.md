# Harbor architecture

Harbor is an experimental modular browser 3D engine. Its default path-tracing backend reuses three-gpu-pathtracer's native WebGPU implementation for geometry-based multi-bounce light transport. A smaller custom compute tracer remains available for focused experiments. The same project also provides a Three.js raster renderer for interactive development and WebGL2 compatibility. Game simulation runs independently in Node.js, including CPU/WASM physics, so development does not require a GPU on the cloud workstation.

This alpha establishes executable interfaces and validation. It does not establish desktop or mobile GPU frame rates, visual parity with a large commercial engine, or production readiness for every hosting platform.

## Module boundaries

| Package entry | Responsibility | Execution environment |
| --- | --- | --- |
| `@harbor/engine` | Entities, fixed simulation ticks, deterministic random numbers, events, commands, plugin lifetimes, scene validation | Node.js or browser; no DOM or GPU |
| `@harbor/engine/browser` | `createGame()` application facade: optional modules, loop, resizing, visibility, camera, and cleanup | Browser |
| `@harbor/engine/physics` | Rapier rigid bodies and character movement | Node.js or browser; CPU/WASM |
| `@harbor/engine/pathtracing` | Quality native WebGPU adapter, full Three scenes, physical materials/camera, world scene bridge | CPU BVH preparation; browser WebGPU rendering |
| `@harbor/engine/raytrace` | Compact triangle tracer, CPU BVH construction/refit, progressive WGSL rendering | CPU geometry preparation; browser WebGPU rendering |
| `@harbor/engine/render` | Three.js WebGPU/WebGL2 raster view, static instancing, TSL environment and ocean | Browser graphics context |
| `@harbor/engine/assets` | Explicit asset handles, embedded GLB loading, Meshopt decoding, skeletal actors | Three.js asset runtime; GLB image decoding may require browser facilities |
| `@harbor/engine/platform` | Namespaced browser storage with memory fallback and a host adapter interface | Browser, including constrained iframe storage |

`src/core/` imports none of the rendering modules. A game owns its input mapping, user interface, authored scenes, and choice of view. Most games can use `createGame()` to manage the application loop and module lifetimes; lower-level applications can own those directly. Game code belongs in a separate application or game directory. Shared engine fixes belong in `src/` only when the public engine behavior itself needs to change.

```text
Scene JSON + gameplay plugins + imported Three assets
                       |
         validated World / fixed simulation
                       |
           application selects a view
        /                |                 \
Quality Three scene   Compact triangles    Raster view
+ world bridge        + CPU BVH/refit       Three / TSL
        |                |                 |
three-gpu-pathtracer   Harbor WGSL          WebGPU / WebGL2
native WebGPU         native WebGPU
```


## World and simulation

`World` stores stable, application-assigned entity IDs. `spawn()` validates and clones the complete definition before publishing `entity:spawn`; `remove()` publishes `entity:remove`. Listeners receive the entity. A failed spawn rolls back the entity and publishes removal so observers can release partial allocations. Use these methods instead of directly inserting or deleting entries in the public entity map.

Entity positions are metres, time is seconds, and Y points up. Rotations are normalized `[x, y, z, w]` quaternions. Primitive sizes are full width, height, and depth. Physics shapes carry their own dimensions and require entity scale `[1, 1, 1]`. Entity `data` stores game-specific JSON; new game rules do not require adding fields to the engine's entity type.

`step(count)` advances exactly that many fixed ticks. `advance(seconds)` accumulates real elapsed time and executes at most `maxSubSteps`, returning `{ steps, alpha, droppedTime }`. Excess complete ticks are discarded and reported; a fractional remainder is retained. This prevents an overloaded frame from causing unbounded catch-up work. `alpha` is available for application interpolation; the built-in raster view currently copies the latest simulation transform without interpolating it.

Systems run in `beforePhysics`, `physics`, then `afterPhysics`, ordered numerically within each phase and by registration order for ties. The registry order is cached until systems change. Each system receives the fixed `dt`; `world.tick` and `world.time` describe the tick being processed. Reentrant stepping is rejected. Seeded random numbers and fixed ticks make equal command sequences reproducible in the same implementation; bit-identical physics across arbitrary engine versions or platforms is not promised.

Snapshots are deep copies of the current entity state and simulation clock. They are inspection/export records, not a complete replay checkpoint: they do not include Rapier velocities, plugin internals, random generator state, or a pending command queue. Restore behavior must be defined by a game or a future versioned persistence module.

## Plugins, services, and ownership

A plugin has `id`, optional `requires`, and synchronous `setup(world, scope)`. Dependencies must already be installed. Initialize asynchronous resources before installing a plugin, for example `world.install(await createRapierPlugin())`.

Register each owned cleanup with `scope.add()`. A returned cleanup can be called early and still runs at most once. Scopes clean up in reverse registration order and attempt every callback even when one throws. Installation failure cleans up the candidate scope. Duplicate IDs, recursive installation of the same ID, and installation that closes its own world are rejected.

`World.dispose()` emits entity removals while plugin services still exist, then disposes plugin scopes in reverse installation order. It clears systems, commands, services, and event listeners. Application-owned renderers, actors, and asset managers have separate lifetimes and must also be disposed. Keep dependent objects inside a common application scope and register their cleanup in construction order.

Services are explicit entries in `world.services`; commands are registered handlers with explicit names and payload validation. Neither is an untyped global object. A game plugin should own the systems, listeners, and commands that it registers.

## Browser path tracing

The quality adapter in `src/pathtracing/` is the default for `createGame({ mode: 'pathtrace' })`. It imports the native WebGPU entry of `three-gpu-pathtracer` 0.0.27, checks the actual renderer backend, and fails explicitly if WebGPU is unavailable. The raster renderer is a separate compatibility choice. Both tracing implementations use programmable GPU computation; neither exposes a standard hardware RT-core/ray-query API.

`createPathTracingRenderer()` accepts a real Three `Scene`, an optional `PerspectiveCamera` or `PhysicalCamera`, and an optional Harbor `World`. Imported static GLB meshes retain standard/physical materials and their supported texture maps. HDR equirectangular environments and physical camera depth of field are available. Upstream material capabilities are broader than Harbor's exercised test cases; custom TSL/MToon shaders are not automatically translated into the integrator's material model.

The adapter owns its renderer, GPU device, tracing resources, and generated world bridge. A caller-supplied scene, camera, meshes, materials, and textures remain caller-owned. The bridge owns only its generated group/resources. A nearest-filter environment may receive a private linear-filter copy for tracing; disposal restores the caller's original environment without disposing it. Keep imported assets alive until the renderer has finished using them. The quality adapter stops immediately on `dispose()`, drains submitted GPU work before releasing its buffers, and returns a promise for complete Three backend cleanup and destruction of its owned GPU device. The facade's `game.dispose()` synchronously stops RAF and disposes its scope; use `game.dispose(); await game.pathtracing?.dispose();` when the caller must wait for complete quality GPU teardown.

The world bridge caches geometry/materials and reports definition/topology changes separately from transforms. `syncWorld()` rebuilds the tracing scene for structural or material changes while preserving unchanged geometry BVHs, calls upstream `updateTransforms()` for moved objects, and leaves unchanged worlds accumulating. The public `pathTracer` exposes upstream material, environment, light and camera updates for application-owned Three objects. Changes reset accumulated samples. Explicit invalidation clears cached ordinary geometry BVHs before rebuilding, so geometry edits do not retain stale bounds. CPU BVH construction can block, so large/animated scenes require measured preparation budgets.

`render()` advances the upstream wavefront scheduler; one call is not one sample per pixel. `frameBudget` controls path slots per call, `maxBounces` controls path depth, and `maxSamples: 0` allows continued accumulation. `inspect()` reports configuration, texture atlas dimensions, actual device limits, errors, and cached sample counts. Call `measureSamples()` when explicit GPU readback is needed; initial/cached counts may be `null`. Defaults are 15 bounces, 250,000 path slots, and no sample cap. These are settings, not performance guarantees or scene budgets.

The adapter exports optional OIDN and FSR integration classes from upstream. It does not install the external denoising/upscaling libraries, fetch model weights, or claim validated denoising. Noise and accumulation resets remain visible during motion. Asset loading and skeletal animation ownership are separate from tracing synchronization: the loader's ability to play an animation does not establish efficient or visually correct skinning/morph updates in this backend. Use the upstream update contract and validate the specific animated asset before shipping it.

## Compact reference tracer

`createPathTracer()` creates its own WebGPU device and canvas context. It accepts a triangle scene and camera through `setScene()` and `setCamera()`. `render()` traces one stochastic sample per pixel and displays the accumulated running mean. There is no hidden animation loop. `inspect()` exposes sample count, dimensions, triangle/BVH counts, estimated buffer bytes, bounce limit, and device/error status. `captureLinear()` reads the accumulated linear image back asynchronously for diagnostics or export.

The CPU constructs a median-split bounding volume hierarchy with small triangle leaves. The WGSL compute shader traverses that hierarchy, intersects real triangles, follows diffuse and metallic scattering paths, and evaluates emissive surfaces, a procedural environment, and sampled sun visibility. This can include geometry outside the camera's visible image. It is a custom compute implementation; Harbor does not expose a standardized hardware ray-query API or claim access to dedicated hardware ray-tracing units. See [the source review](RESEARCH.md#webgpu-and-ray-tracing).

`fromWorld(world)` converts the declarative primitive visuals into world-space triangles and linear material constants. It is a snapshot. Use `setScene()` after topology or material changes. With the same triangle count/order, `updateGeometry()` refits BVH bounds on the CPU and updates the existing GPU buffers. Unchanged packed geometry preserves accumulation; changed geometry resets it. Camera changes, resizing, and `reset()` also invalidate accumulation. This is CPU refitting, with conversion/upload costs that must be measured for the target scene.

Materials support constant color, emission, metalness, roughness, transmission, and index of refraction. Smooth vertex normals are supported. The opaque branch mixes a GGX metallic lobe with diffuse sampling; the polished dielectric branch uses Fresnel reflection/refraction and total internal reflection. Roughness affects the opaque branch, not the transmission branch. There is no nested-medium stack, dispersion, or volume absorption: transmission color is an interface tint. Emissive triangles contribute when paths hit them; dedicated area-light or caustic importance sampling is not implemented. Textures, normal maps, volumes, skinning, motion blur, denoising, and importance-sampled environment maps are outside this compact backend. Custom Three objects, imported GLB actors, and the raster TSL ocean/sky are not captured by `fromWorld()`.

For external static assets, `fromThreeScene(object)` snapshots visible ordinary and instanced Three meshes, including indexed/interleaved geometry, material groups, draw ranges, mirrored transforms, and constant standard PBR materials. It does not silently render unsupported content: textures, custom shader nodes, unsupported physical material lobes, skinning, morphs, and unsupported renderable object types fail unless the caller explicitly opts into warnings/approximations through `allowUnsupported`. Animated objects are skipped in that mode rather than pretending to have been skinned. The importer does not dispose or rewrite the source asset. Its alpha conversion budget is 250,000 visible triangles. Cameras, lights, fog, and environments are configured separately.

Coordinates must remain within ±1,000,000; linear albedo and transmission components are in `[0, 1]`, index of refraction is in `[1, 3]`, and the supported bounce range is one to 32. Geometry buffers and output dimensions are checked against actual device limits rather than a fixed triangle ceiling. These limits bound inputs, not expected interactive budgets; actual viable scene size and resolution depend on the device and integrator workload.

## High-level browser application

`createGame({ canvas, scene, ...options })` validates the world, optionally initializes physics, installs plugins, and dynamically imports the selected view. It owns RAF, fixed-step advancement, resize observation, visibility time resets, and failure cleanup. `mode` defaults to `raster`; within `pathtrace`, `trace.backend` defaults to `quality`. Use `trace.backend: 'compact'` to select the reference implementation explicitly.

Quality options include a caller-owned `trace.scene`, `trace.camera`, internal dimensions, bounce count, `frameBudget`, `maxSamples`, and primitive tessellation. Configure HDR lighting on the native scene's `environment`. Compact uses `trace.environment` for its procedural sky/sun; native scene/camera and wavefront-only options are rejected there. `setCamera()` accepts physical focus/f-stop settings for quality mode. The public result exposes `world`, optional `renderer`, `pathtracing` or `tracer`, and lifecycle/inspection methods.

`trace.live: false` refines a still view; `trace.live: true` advances simulation and synchronizes world changes. A moving scene restarts accumulation and may be noisy. `step(count)` advances fixed ticks and paints once; `step(0)` paints while paused. Application-owned Three objects require explicit upstream update calls or `invalidateScene()` after content changes; they are not automatic core entities.

`npm run create-game -- <directory>` packages the built engine into an independent minimal application. It includes `vendor/engine.tgz`, scene data, movement/camera code, and local validation tools. It never merges into a nonempty destination and does not install project dependencies. The result has no dependency on the original checkout path.

Path tracing requires WebGPU and a secure context such as HTTPS or localhost. Failure is surfaced to the application. The separate raster mode is an explicit alternative, with different lighting behavior; a WebGL2 image must never be reported as a successful path-tracing frame. Progressive rendering benefits from a stationary camera and scene, and image noise falls as samples accumulate. Real-device tests are required before choosing resolution, bounce count, or sample budgets for a game.

## Raster rendering

`createBrowserRenderer({ canvas, world })` owns its Three renderer, scene, camera, default sky/environment, lighting, and generated primitive resources. `render()` copies ordinary entity transforms and paints one frame; simulation advancement remains the application's responsibility. The renderer uses Three's WebGPU backend when available, with WebGL2 support through the same TSL pipeline. `backend: 'webgl'` requests the latter explicitly.

The renderer shares primitive geometry/material resources and groups explicitly static `visual.batch` entities by resource, shadow setting, and spatial cell. Cell-level batches preserve useful culling granularity. Batched transforms are captured when the world view rebuilds; do not animate or mutate a batched entity in place. Remove/re-spawn it, or use an ordinary unbatched visual. Shape/material definitions are likewise captured at rebuild. Changing ordinary position/rotation/scale is synchronized each raster frame without rebuilding the world meshes. A transform event from `physics:teleport` rebuilds static batches so their instance matrices, spatial cells, and culling bounds follow the command; it preserves ordinary meshes when no static batch changed.

`setQuality()` changes pixel ratio, shadow resolution, and optional bloom. This is a configurable quality policy, not a measured device recommendation. `getObject()` and `getEntityId()` support picking, including instance IDs. `inspect()` exposes draw calls, triangles, resource counts, and batch counts. Application-added objects remain application-owned and need explicit cleanup.

## Physics and assets

The optional Rapier plugin supports fixed, dynamic, and character bodies with box, sphere, and capsule collision shapes. It registers `physics:move`, `physics:impulse`, and `physics:teleport`; examples are in [the AI guide](AI_GUIDE.md#physics-commands). Dynamic and character transforms are owned by physics. Edit them through commands. Collision shape changes require removal/re-spawn. The character controller uses Y-up movement, gravity, slope limits, stepping, and jumping; navigation, vehicles, joints, and multiplayer synchronization are not implemented by this adapter.

`AssetManager` deduplicates in-flight requests and gives every owner an independent reference-counted handle. Cancelling one acquisition does not cancel other owners; the last release aborts outstanding work and disposes late results. An `Actor` owns its cloned skeleton and animation mixer while the asset manager owns shared template geometry, materials, and textures.

The default GLB loader requires an embedded glTF 2 binary and supports the locally bundled Meshopt decoder. It rejects external buffer/image URLs rather than silently adding network dependencies. Draco and KTX2 require additional decoder integration and are not currently configured. `Actor.fromHandle()` transfers ownership of that handle to the actor; do not also treat the same handle as an independently owned lifetime.

## Validation, deployment, and extension

[The scene JSON Schema](scene.schema.json) supports editors and generation tools. `validateScene()` is authoritative: it also checks duplicate IDs across entities, quaternion length, shape dimension relationships, and JSON semantics that the schema cannot fully express. Unknown structural fields are rejected; `data` remains the extension point. Numeric limits prevent otherwise finite JavaScript values from overflowing or underflowing graphics/physics inputs.

The Vite build uses relative asset paths and produces a static directory. The export tool writes a manifest and ZIP. A generic browser platform adapter tolerates unavailable persistent storage and reports whether persistence succeeded. Specific Bilibili Toy/VibeHub SDKs, upload limits, iframe permissions, monetization, and account services must be checked against the chosen host; this repository does not claim certified host integration.

Future modules can add asset formats, interaction, navigation, audio, networking, streaming, or a more advanced tracing integrator without adding browser dependencies to the core. Prioritize an executable interface, ownership rules, and a small example over promises of complete features. Workstation validation covers logic, compilation, BVH behavior, and software-adapter rendering where available. Desktop/mobile GPU performance, power use, and sustained memory behavior require separate hardware measurements.
