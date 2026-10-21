# Validation record · 验证记录

## 0.2 integration CPU acceptance · 0.2 集成 CPU 验收

2026-10-21：当前 0.2 集成工作树的 `npm run check` 通过 93 项 Node 测试、TypeScript、引擎声明构建与 Vite 生产构建。新增应用宿主测试覆盖 latest-load-wins、取消信号与晚到资源释放顺序、load/restore/enter 失败保留旧场景、禁止复用已管理实例、根异步释放、秒更新/RAF 限制与恢复，以及 Scope、原始存档、剧情与空间索引。完整帧 tile 规划还验证每个像素恰好覆盖一次、每次 dispatch 的活动像素不超预算，以及异常预算在渲染前失败。现有 fixed World 行为测试继续通过。

On 2026-10-21, `npm run check` passed 93 Node tests, TypeScript, package declarations and the Vite production build in the 0.2 integration tree. New runtime checks cover transition races, immediate cancellation/deferred cleanup, preparation/activation rollback, instance ownership, root async disposal, seconds/RAF clock behavior, Scope, raw saves, story and spatial indexing. Complete-frame tile plans cover every pixel exactly once within the active-pixel budget per dispatch, and reject unbounded work before rendering. Existing fixed-World tests continue to pass.

最终私有几何准备还验证 321 个有序材质组按 ≤128 组分片，保留 triangle/material 顺序与实例；嵌套非均匀变换、手动 world 矩阵、skin 世界顶点、共享私有 skeleton 一次释放、父级 visibility，以及空 LOD 的非渲染 scaffold 均有真实 CPU 回归。空 skin/instance 在 drawRange 恢复后，实际上游 material/TLAS packing 再次通过。最后的 Node 测试和 typecheck 日志分别为 `tests/artifacts/final-02-node.log` 与 `final-02-typecheck.log`；生产构建见 `final-02-build.log`。这些诊断文件不随包分发。

Final preparation checks cover ordered ≤128-group partitions, unchanged triangle/material order and instances, nested nonuniform transforms, manual world matrices, skinned world positions, exactly-once private skeleton release, inherited visibility and empty LOD scaffolds. Empty skin/instance draw ranges recover and pass actual upstream material/TLAS packing again. The named local logs retain the final CPU/type/build observations and are not distributed in the package.

`npm run check:consumer` 在 Linux 真实通过：在引擎工作区外创建独立游戏，只从 vendor tarball 安装；场景验证、180 tick 模拟、生产构建、公开 CPU 模块导入和全部 11 个 exports 目标通过。同源 OIDN 权重进入 dist，长度 7,698,439 字节、SHA-256 为 `08130cdc4f33b7a513d0073757f089ac830f900613bb5bad72ca42c52b934465`。生成器在包含空格的路径验收；未使用跨仓库源码导入。

The Linux independent consumer passed a tarball-only installation outside the checkout, validation, 180 simulation ticks, production build, public CPU imports and all 11 export targets. Its dist contains same-origin OIDN weights with the length/hash above. A path containing spaces was exercised; no cross-repository source import was used.

CI 已配置 Ubuntu/Windows CPU 矩阵和相同独立 consumer 检查；此处不把配置存在当成 Windows 实际通过。0.2 新渲染、降噪和 Dragon 应用的 GPU 验收另行记录，下方 0.1 GTX 1070 历史证据不自动覆盖新代码。

CI is configured for Ubuntu/Windows CPU checks and the same independent consumer. Configuration alone is not a recorded Windows pass. New rendering/denoising and Dragon GPU acceptance are tracked separately; the historical GTX 1070 evidence below applies to its recorded revision.

## 0.2 native quality software acceptance · 原生质量视图软件验收

`npm run test:quality:view` 在 SwiftShader WebGPU 适配器上真实通过，日志为 `tests/artifacts/quality-view-complete-frame-software.log`。32 × 24 原生借用视图达到 minimum 64 spp，使用同源 OIDN large FP32 模型完成 HDR 降噪；raw 与 denoised 输出保留大于 1 的线性值，上下方向与 raster 基线一致，没有非有限读回值或收集到的错误。三轮创建/释放保留来源 BVH、index、材质和纹理，来源资源未被释放。

The borrowed native view passed `npm run test:quality:view` on a SwiftShader WebGPU adapter: minimum 64 spp at 32 × 24, same-origin OIDN large FP32 denoising, linear HDR values above 1, matching raster orientation, finite readbacks and no collected errors. Three create/dispose cycles preserved source BVH/index and caller-owned resources. This establishes functionality in the fixture, without a hardware-performance claim.

新的 `createPathTracingView()` 默认每次 `render()` 完成一个完整分辨率样本，通过有上界的 megakernel tile 循环执行；`frameBudget` 限制每个 dispatch 的活动像素数，不通过降低输出分辨率达到预算。`samplingMode: 'progressive'` 显式选择每次一个 tile。旧的 `createPathTracingRenderer()` / `createGame()` quality facade 仍使用其已有调度，历史 wavefront benchmark 不能被解释为新视图的帧率。

`createPathTracingView()` completes one full-resolution sample per `render()` by default through a finite megakernel tile cycle. `frameBudget` bounds active pixels per dispatch while retaining output resolution; explicit `samplingMode: 'progressive'` advances one tile. The existing quality renderer/facade keeps its established scheduling. Its historical wavefront measurements do not describe the new view's frame rate.

## 0.2 native quality GTX 1070 acceptance · 原生质量视图显卡验收

2026-10-21，Windows 节点上的独立 Edge 进程以硬件模式通过原生借用视图测试（exit 0，整次运行 24.481 秒）。适配器报告 NVIDIA/Pascal、`isFallbackAdapter: false`；节点 GTX 1070 的归属依据与同步包、源码/编译文件 SHA-256 见[独立结构化记录](validation/native-quality-gtx1070-2026-10-21.json)。运行前 Windows 校验两个同步 ZIP 的 SHA-256，再解包；代码补丁内全部 34 项也与中心验收树逐字节一致。此记录不声称本轮逐一重新读取远端解包文件 hash。

The isolated Edge hardware run passed with exit 0 in 24.481 seconds. The adapter reported NVIDIA/Pascal and no fallback. The linked record distinguishes node attribution, verified transfer archives and exact code hashes. Both archive hashes were checked on Windows before extraction; all 34 code-patch entries also match the accepted build checkout. This is archive-identity evidence rather than a separate remote hash of each extracted file.

| 检查 · Check | 实测结果 · Recorded result |
| --- | --- |
| 静帧 / Static refinement | 32 × 24、2 meshes、24 triangles、2 bounces；minimum/maximum/average 64 spp；OIDN large FP32 完成；设备未请求 `shader-f16` / Completed at 64 spp without requiring optional FP16 |
| 线性图像与 guides / HDR and guides | Raw max 2，denoised max 2.126953125；非有限值 0；raw、denoised、albedo、normal 与 raster 上下方向一致 / Finite HDR values and matching orientation |
| 动态完整帧 / Dynamic complete frame | 连续 3 次改变相机、变换和环境后，每次一次 render 得到 min/max/avg 1 spp；每帧 3 × 3 tiles，最大 88 活动像素 ≤ 128 预算，读回有限且非黑 / One complete sample after each dirty frame within tile budget |
| 生命周期 / Lifecycle | 三轮释放通过；调用者来源 BVH/index 保留、来源资源未释放；陈旧降噪立即回到 raw；错误集合为空 / Three cycles, retained borrowed resources, stale-result fallback and no collected errors |

OIDN 单次 32 × 24 推理观测为 95.2 ms；它不包含整个初始化，不能推断 1280 × 720 延迟或全城帧率。此处只验收小场景功能。Dragon 的完整城市、交互、冻结细化、容量与发布另行验收，未由本记录替代。

The observed OIDN invocation took 95.2 ms at 32 × 24 after setup. It does not establish 1280 × 720 denoising latency or full-city FPS. Dragon city capacity, interaction, frozen refinement and publication require their own acceptance.

The following 0.1 records are retained from 2026-10-21 and 2026-10-18. They cover their original CPU/build, native graphics, short measurements and independent-game checks. They do not substitute for the 0.2 records above or Dragon application acceptance. Each record establishes its stated scope; a short run on one desktop GPU does not establish mobile or general game performance.

## 0.1 CPU and build checks · 历史记录

| Check | Recorded result | Scope |
| --- | --- | --- |
| `npm test` | 61 tests passed on 2026-10-21 as part of `npm run check`; 58 passed in the 2026-10-18 integration snapshot | Core validation/fixed ticks/plugins, real Rapier behavior, asset ownership, compact geometry/BVH conversion, quality world bridge, portable generator, offline asset tools, and hardware-test adapter validation |
| `npm run build` | Passed on 2026-10-21 as part of `npm run check`; also passed in the 2026-10-18 snapshot | TypeScript checks, package JavaScript/declarations, Vite production build |
| Offline asset tools | 6 focused tests passed in the 2026-10-18 record | Exact decoded geometry/index/morph data, skin/animation preservation, metadata/image preservation, Three Meshopt loader compatibility, no overwrite/concurrent publish, external-resource rejection, CLI error status |

The latest complete CPU/build log is `tests/artifacts/final-check.log`. Test artifacts are local diagnostics and are not bundled into the published engine package.

The GLB test model's lossless candidate changed raw size from 38,088 to 17,188 bytes, while gzip changed from 3,082 to 3,804 bytes and Brotli from 2,425 to 3,051 bytes. The tool reports this regression explicitly; the bundled original was not replaced. These are one asset's results, not an expected compression ratio for other content.

## 0.1 GTX 1070 hardware checks · 2026-10-21 历史记录

Configuration: Windows 11 x64, Core i7-8700, 8 GiB system RAM, GTX 1070 with 8 GiB VRAM, NVIDIA driver 31.0.15.5222 (552.22), Node 24.22.0, and headless Microsoft Edge 155.0.4283.62. Tests ran sequentially. The [machine-readable record](validation/gtx1070-2026-10-21.json) contains settings, observed adapters, readbacks, lifecycle results, benchmark data, the base commit, and SHA-256 values for the changed source/test files. The synchronized Windows files matched those hashes before execution. The final benchmark runner was separately synchronized and verified after extending its measurement window.

The Windows runner invoked the quality suite as `node tests/pathtracing.mjs`, using precompiled asset modules from the build workstation, and invoked the other browser scripts directly. Full TypeScript/package compilation passed on the build workstation through `npm run check`; the production Vite build also ran on Windows. The npm script names below identify the corresponding suites, without implying a second Windows TypeScript compilation.

The application's WebGPU adapters reported `nvidia` / `pascal`, `isFallbackAdapter: false`, with model fields redacted. The benchmark browser's own GPU diagnostics and the production application's WebGL renderer named GTX 1070; the inventory had one NVIDIA card. This combination supports attribution to that card. Without `HARBOR_GPU_POWER=high-performance`, the same machine selected Intel UHD 630 despite a WebGPU power preference hint. The accepted Windows runs used `--force_high_performance_gpu` on isolated test processes. No software-adapter forcing flags were used.

| Check | Recorded result | Scope |
| --- | --- | --- |
| `npm run test:quality` | Passed: 32 × 24, 180 triangles, 4 bounces, minimum 4 spp; mean linear RGB 0.4964245800, maximum 1.8712048531, zero non-finite values and collected errors | Native adapter/facade, textures, normal map, HDR, glass, physical camera, resize/world updates, BVH caching, and cleanup with pending reads |
| Embedded textured GLB within the quality suite | Passed: 2,724 bytes, 12 triangles, 16 × 16, 2 bounces, minimum 2 spp; mean linear RGB 0.1424091013, zero non-finite values and collected errors | Meshopt decoding, sRGB texture, transform updates, borrowed-resource ownership and exact final release |
| `npm run test:render` | Passed on WebGL2 and WebGPU | Stable resource counts through 40 total spawn/remove cycles, ordinary mesh retention after physics teleport, static-batch matrices/culling bounds, real subscription cleanup, DPR 2 and hidden-canvas recovery |
| `npm run test:browser` after a native Windows Vite build | All 6 checks passed, zero collected errors; five non-black canvases with 900 × 600 CSS presentation | Compact tracing at 1/8 bounces and refit; quality facade with measured 2 spp; WebGL2/WebGPU gameplay with movement, jump, collection, quality switching and cleanup, served under `/nested/` |
| `npm run bench:gpu` | All four cases passed; finite/non-black readback, sample progress, camera reset and recovery, zero collected errors | Static quality scene with 3 meshes, 1,932 triangles and one atlas page; about 10 seconds per measured case |

The retained optimizations avoid replacing ordinary raster meshes after transform-only physics commands and preserve unchanged quality geometry BVHs during scene additions/removals or material changes. Both adapter and facade regressions verify cache identity. Explicit vertex changes followed by `invalidateScene()` still replace the BVH: moving the emissive test box outside view changed center red radiance from 3 to 0, with zero non-finite values. These checks demonstrate avoided rebuilds and preserved correctness; no before/after frame-rate claim is made.

| Internal pixels | Bounces | Path budget per call | Calls | Mean / p95 submission-to-completion (ms) | Average spp per second |
| --- | --- | --- | --- | --- | --- |
| 320 × 180 | 4 | 8,192 | 2,361 | 4.23 / 5.90 | 20.24 |
| 320 × 180 | 4 | 32,768 | 2,356 | 4.24 / 5.90 | 87.30 |
| 320 × 180 | 4 | 57,600 | 2,372 | 4.21 / 5.80 | 166.19 |
| 640 × 360 | 8 | 131,072 | 1,741 | 5.74 / 6.90 | 64.19 |

Each measurement reset accumulation after warmup. Timing serializes JavaScript submission and GPU queue completion for every call; it excludes initialization and readbacks. A call advances a wavefront budget, so these are neither GPU timestamp timings nor game FPS. Sample rates use explicit average sample counts divided by the measured window. For this small stationary 320 × 180 scene on this card, 57,600 is a better starting budget than 8,192: it completed more samples within similar per-call latency. Recheck the budget for other content, resolutions, moving scenes and presentation loops. Engine-wide defaults were not inferred from this one scene.

Power settings, background load, thermals and power draw were not controlled or recorded. Sustained memory/thermal behavior, mobile support, full-game frame rates, denoising and animated deformation need separate evidence. The independent generated-game browser checks below remain historical software results. Use [the hardware procedure](HARDWARE_VALIDATION.md) to reproduce adapter validation and the benchmark matrix. The production browser recorded upstream warnings about the ignored Windows power preference hint and the `THREE.Source` rename; its error collection was empty.

## 2026-10-18 software graphics and portable-game evidence

The development environment used for this historical record had no dedicated GPU. These graphics checks used Chromium with a software Vulkan/SwiftShader adapter; they established functionality within the stated cases, without measuring hardware throughput. All figures and package sizes in this section belong to the 2026-10-18 snapshot.

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

The GTX 1070 results above cover only their recorded checks. General laptop/desktop/mobile game frame rates, sustained memory/power use, large-scene budgets, temporal denoising, continuous skinning/morph tracing, target-host acceptance, and Tidewater visual parity require separate evidence. Hardware records should include browser/version, adapter, resolution, geometry/material/texture counts, bounce/frame budgets, measured samples, elapsed time, error/device-loss behavior, and motion/noise conditions.
