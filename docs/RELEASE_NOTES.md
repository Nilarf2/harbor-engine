# v0.1.0-alpha

Harbor's first alpha establishes a reusable browser-game foundation that can be developed on a computer without a dedicated GPU. Game simulation runs separately from rendering; a new project receives its own engine package, scene, controls, camera, build configuration, and notices.

## Included

- Strict scene data, stable entity IDs, seeded randomness, fixed simulation ticks, commands, and scoped plugins.
- Optional Rapier rigid-body physics and a character controller with movement, stairs, gravity, and jumping.
- A default native WebGPU quality path-tracing adapter reusing `three-gpu-pathtracer`, with full Three scene access for textured assets, HDR lighting, physical materials, and camera controls.
- An explicit compact WGSL reference tracer and a separate Three WebGPU/WebGL2 raster view.
- Shared asset ownership, embedded GLB/Meshopt loading, skeletal actor instances, and portable game generation.
- Offline GLB inspection and lossless Meshopt optimization, with metadata preservation, validation, delivery-size reports, and no source overwrites.
- Browser storage fallback, static build/export tooling, English AI documentation, and a CPU-oriented GitHub check/build workflow.

## Scope and evidence

This is an experimental alpha. Acceptance includes 58 Node tests, 49 lifecycle assertions, a complete extracted-demo browser run, and an independently generated game running both quality WebGPU tracing and WebGL2. Embedded textured Meshopt GLB loading, physical camera controls, resource ownership, responsive canvases, and shutdown with pending GPU reads were checked. Detailed scope is recorded in [VALIDATION.md](VALIDATION.md). Software graphics checks are not real-device performance measurements.

The quality renderer's upstream API is broader than Harbor's tested feature set. Its BVH preparation may block the CPU, moving content resets accumulation, and imported animated deformation requires explicit synchronization. Optional denoising/upscaling hooks do not include model weights or a validated denoising mode. The compact backend has narrower constant-material/static-conversion support, documented separately.

Bilibili Toy and VibeHub publishing/SDK integration, VRM/retargeting/IK, navigation, automatic LOD/streaming, KTX2 decoder packaging, and real desktop/mobile performance acceptance are not included in this alpha. No Tidewater visual or performance parity is claimed.

## Distribution

The release provides source, a static demo ZIP, a compiled engine tarball, and an external SHA-256 checksum file. The package manifest identifies `@harbor/engine` version `0.1.0`; this release's alpha status is explicit in its tag and documentation. Blender-authored models enter through embedded GLB exports; the included guide covers materials, scale, loading, and separately declared gameplay colliders.

Nilarf2 is the project owner. Codex (OpenAI) contributed as an AI programming collaborator. Harbor uses MIT; reused packages and assets retain the notices listed in [NOTICE.md](../NOTICE.md).
