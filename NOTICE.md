# Notices and attribution

Harbor source and original example content are copyright © 2026 Nilarf2, released under the [MIT license](LICENSE).

## Upstream code and content

`src/assets/AssetManager.ts`, `src/assets/Actor.ts`, and `src/assets/disposeObject.ts` were adapted and extended from [Nilarf2/dragon-raja-grand-escape](https://github.com/Nilarf2/dragon-raja-grand-escape) at commit `658c1b4fb4f6f3fa41ce6b246c7700fc5f409894`. Original code copyright © 2026 Nilarf2, MIT. `public/models/mannequin.glb` is that project's original procedural MIT test model. No novel text, real-world map database, GSI elevation or other location content is included.

[dgreenheck/tidewater](https://github.com/dgreenheck/tidewater) was studied for architectural and visual-technique comparisons. No Tidewater source, shader or third-party art was copied into this implementation. See [RESEARCH.md](docs/RESEARCH.md) for other researched projects; a reference does not imply an incorporated dependency.

## Runtime packages

- **Three.js 0.186.1**, MIT, copyright the Three.js authors. Full notice: `public/licenses/three.txt`.
- **three-gpu-pathtracer 0.0.27**, MIT, copyright © 2021 Garrett Johnson. The quality renderer reuses its native WebGPU path tracer, material/camera support, and integration APIs. Full notice: `public/licenses/three-gpu-pathtracer.txt`.
- **three-mesh-bvh 0.9.15**, MIT, copyright © 2018 Garrett Johnson. Acceleration-structure dependency of the quality renderer. Full notice: `public/licenses/three-mesh-bvh.txt`.
- **xatlas-web 0.1.0**, MIT. Its distributed license credits © 2018–2020 Jonathan Young; the npm WebAssembly wrapper is maintained by Mozilla Reality. Required upstream package dependency; Harbor does not claim an implemented UV-authoring or light-baking workflow. Full distributed notice: `public/licenses/xatlas-web.txt`.
- **Rapier JavaScript compat 0.21.0**, Apache-2.0, Dimforge and contributors. Full license: `public/licenses/rapier.txt`. Optional runtime physics dependency; its compat JavaScript includes the WebAssembly payload.
- **Meshoptimizer decoder**, MIT, copyright Arseny Kapoulkine. Distributed through Three.js's addon decoder. Full notice: `public/licenses/meshoptimizer.txt`.
- **TypeScript definitions** (`@types/three`, MIT, DefinitelyTyped contributors; `@webgpu/types`, BSD-3-Clause, the W3C GPU for the Web Community Group): development/editor contracts distributed as package dependencies so downstream projects retain their public types. Their notices ship with the respective npm packages.

Bundled website exports include the `licenses/` directory. The independent game generator copies these notices into the generated application's `public/licenses/`, so they also accompany its static build. Keep them when repackaging or deploying a game.

## Offline development tools

- **glTF Transform core/extensions 4.5.1**, MIT, copyright © 2024 Don McCurdy. Used by the offline GLB pipeline. Full notice: `public/licenses/gltf-transform.txt`.
- **meshoptimizer 1.3.0**, MIT, copyright © 2016–2026 Arseny Kapoulkine. CPU/WebAssembly encoding and decoding for the offline GLB pipeline. Full notice: `public/licenses/meshoptimizer.txt`.
- **Khronos glTF Validator 2.0.0-dev.3.10**, Apache-2.0, The Khronos Group Inc. The npm distribution includes additional Dart and third-party notices. Preserved in `public/licenses/gltf-validator.txt` and `public/licenses/gltf-validator-notices.txt`.

These tools are development dependencies, not game content. Vite, TypeScript, tsx, Playwright and other tooling retain their distributed package licenses. Research references such as MuTracer, Recast Navigation, KTX-Software and Basis Universal are not bundled dependencies. No optional OIDN model weights or researched gallery assets are included.

## Collaboration

Nilarf2 directed the project. Codex (OpenAI) contributed as an AI programming collaborator. This attribution describes assistance; it does not claim sponsorship or endorsement by OpenAI or the authors of researched projects.
