# Validation record

Date: 2026-10-18. Status: experimental alpha. CPU, software-graphics, extracted-demo, and independent-game functional acceptance passed for this release. These checks establish only their stated scope; player-device performance remains unmeasured.

## CPU and build checks

| Check | Recorded result | Scope |
| --- | --- | --- |
| `npm test` | 58 tests passed in the integrated source snapshot | Core validation/fixed ticks/plugins, real Rapier behavior, asset ownership, compact geometry/BVH conversion, quality world bridge, portable generator and offline asset tools |
| `npm run build` | Passed in the same integration snapshot | TypeScript checks, package JavaScript/declarations, Vite production build |
| Offline asset tools | 6 focused tests passed | Exact decoded geometry/index/morph data, skin/animation preservation, metadata/image preservation, Three Meshopt loader compatibility, no overwrite/concurrent publish, external-resource rejection, CLI error status |

The GLB test model's lossless candidate changed raw size from 38,088 to 17,188 bytes, while gzip changed from 3,082 to 3,804 bytes and Brotli from 2,425 to 3,051 bytes. The tool reports this regression explicitly; the bundled original was not replaced. These are one asset's results, not an expected compression ratio for other content.

## Graphics evidence

The available development environment has no dedicated GPU. Graphics checks use Chromium with a software Vulkan/SwiftShader adapter; they validate functionality, not hardware throughput.

| Check | Recorded result | Limit |
| --- | --- | --- |
| Minimal upstream native WebGPU quality scene | 32 × 24, minimum 4 samples per pixel, finite non-black readback; mean linear RGB 0.497428656, maximum 2.9160237; no collected GPU/console errors | Preliminary upstream integration check, not acceptance of every Harbor adapter/facade path |
| Raster/facade lifecycle regression | 49 assertions passed, including DPR 2, a bare canvas, and an initially hidden responsive canvas | Renderer lifecycle/resize behavior; no real-device performance conclusion |
| Complete quality adapter (`npm run test:quality`) | Passed: 32 × 24, 180 triangles, 4 bounces, minimum 4 samples per pixel, 2 texture-atlas pages; linear mean 0.5014828917, maximum 3.7975871563, zero non-finite values and no collected errors | Checker/normal maps, Float32 nearest HDR normalization, physical glass/clearcoat/iridescence, DOF; broader upstream materials remain separately unverified |
| Public asset loader → textured GLB → quality scene | Passed: a self-contained 2,724-byte Meshopt GLB with an embedded 2 × 2 sRGB image, 12 triangles, 1 atlas page; 16 × 16, 2 bounces, minimum 2 samples per pixel; final-run mean linear RGB 0.145217514, maximum 1.158042192, zero non-finite values and no collected errors | The original checker fixture produced both red and cyan pixels; no Blender installation or animated-deformation acceptance is implied |
| Extracted production ZIP (`npm run test:browser`) | Passed in one complete run: 6 checks, no collected errors; compact 1/8-bounce rendering, BVH refit, quality facade, playable WebGL2 and WebGPU raster views | Served under `/nested/`; five presented canvases were non-black and retained their responsive 900 × 600 CSS size |
| Independent generated game CPU checks | The generated application installed its local engine tarball, validated 5 entities, simulated 180 ticks, and built successfully; after the final rendering fixes, a fresh independent package was installed and rebuilt | Final compiled engine modules matched the accepted checkout byte for byte |
| Final independent generated game browser checks | Passed: default quality WebGPU at 32 × 24 and measured 2 samples per pixel, plus explicit WebGL2 at 720 × 480; both advanced 336 ticks with 5 entities | Verified movement, jumping, non-black canvas output, repeated awaited disposal, and no collected errors; served under `/nested/` |

The complete adapter run also verified camera/DOF reset, resizing, restoration of the caller's original HDR texture, retention of samples for an unchanged world, reset on movement, rebuild after entity addition/removal, and repeated awaited disposal. The software device exposed 1 GiB buffer/storage limits in this run; that value is not a portable hardware maximum or a performance result.

The GLB integration run used the public asset manager and GLTFLoader/Meshopt decoder, added the imported model to a caller-owned scene, and rebuilt through `invalidateScene()`. A native transform update plus reset converged again. Disposing the quality view left borrowed geometry/material/texture resources intact; releasing the model handle then disposed each exactly once and emptied the manager. This exercises the static model ownership/update recipe in the AI guide.

An immediate-stop regression reproduced cancellation of an in-flight GPU buffer read. The accepted cleanup now stops synchronously, drains submitted GPU work, and only then releases owned GPU resources. The regression passed with internal and explicit sample reads still pending, including late error observation with no collected errors. Previously requested reads may settle after stop; they do not refresh disposed inspection state. Await `game.pathtracing.dispose()` after `game.dispose()` when complete cleanup is required.

The final 2,053,382-byte static demo ZIP was extracted and served under a nested path for the complete production browser run. Its 23 manifest files matched their recorded lengths and SHA-256 values. The playable views verified movement, jumping, collection, quality switching, and cleanup on both raster backends; the quality view verified physical camera controls, real sample counts, texture use, and motion invalidation. Release artifact hashes are recorded in an external checksum file to avoid a package containing its own changing hash.

A separate visual inspection of the quality lighting study confirmed full 900 × 600 presentation with its intended scene and controls. The render used 192 × 128 internal pixels, 8 bounces, and 4 samples per pixel; the noisy result had finite readback and no collected errors. This is a functional visual check, not a denoising or image-quality benchmark.

The independent package audit found all 8 export entries with their targets, 24 declaration files, runtime Three/WebGPU type dependencies, root AI instructions, the Blender guide, and copied license texts, with no private absolute workstation paths. All 10 license files and the attribution notice reached the generated application's static build. The production build emitted upstream `three-mesh-bvh` duplicate-export and large optional physics-chunk warnings; it completed successfully. Browser checks also recorded an upstream `THREE.Source` rename warning; error collections were empty.

The quality backend's `render()` call advances a wavefront budget, not one full sample per pixel. Use its asynchronous sample counter when reporting convergence. Compact-backend counters describe a different scheduler and must not be compared as frame counts.

## Reproduce the checks

```sh
npm ci
npm test
npm run build
npm run assets -- inspect public/models/mannequin.glb
npm run scene -- validate demo/scene.json
npm run scene -- simulate demo/scene.json --steps 180
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
CHROMIUM_PATH=/usr/bin/chromium npm run test:render
CHROMIUM_PATH=/usr/bin/chromium npm run test:quality
```

The browser scripts launch their own Chromium process, disable proxy/background networking, and allow only local application requests. Keep rendering errors and readback results; a screenshot or shader compilation alone does not establish correct rendering. Software-adapter launch flags are environment-specific and should not be copied into a player's browser instructions.

The GitHub workflow repeats locked installation, Node tests, build, and model inspection, then uploads artifacts. Consult the repository's Actions results for each published revision. It does not run GPU tests on an assumed-capable hosted runner.

## Release and hardware acceptance

The release record identifies the accepted source commit and includes downloadable artifacts with an external SHA-256 checksum file. Final engine packaging may update documentation after the independent-game run; compiled modules are compared byte for byte with that accepted package. No generated dependencies, local diagnostics, or private workstation configuration belong in the source release.

Real laptop/desktop/mobile GPU frame rates, sustained memory/power use, large-scene budgets, temporal denoising, continuous skinning/morph tracing, target-host acceptance, and Tidewater visual parity remain unmeasured. Future hardware records should include browser/version, adapter, resolution, geometry/material/texture counts, bounce/frame budgets, measured samples, elapsed time, error/device-loss behavior, and motion/noise conditions.
