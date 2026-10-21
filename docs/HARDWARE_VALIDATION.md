# Hardware graphics validation

This procedure checks Harbor on the GPU that the application actually uses. It is a test plan, not a record of a successful hardware run. Keep dated results and remaining limits in [VALIDATION.md](VALIDATION.md), with the tested commit, browser version, driver version, adapter evidence, settings, and artifacts.

## Windows setup

Use Node.js 22.12 or newer and an installed Chromium-based Edge or Chrome with WebGPU support. Run from the repository root in the approved execution environment for the GPU node. An installed GPU or a remote desktop connection alone does not establish that the browser can use it.

In PowerShell:

```powershell
npm ci
npm run build

$env:HARBOR_GPU_MODE = 'hardware'
$env:HARBOR_GPU_EXPECT = 'nvidia'
$env:HARBOR_GPU_POWER = 'high-performance'
$env:HARBOR_HEADLESS = '1'

# Optional: select an installed browser explicitly.
$env:CHROMIUM_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

npm run test:browser
npm run test:render
npm run test:quality
npm run bench:gpu
```

Check each command's exit status and preserve failures; running a later command does not make an earlier failure pass. `test:browser` needs the production `dist/` from `npm run build`. `test:quality` rebuilds the engine package before running its checks. The scripts start their own loopback servers; do not start another server on port 5194 while running the quality test.

If `CHROMIUM_PATH` is unset, the helper looks for installed Edge/Chrome in common Windows locations. Set it when a browser lives elsewhere or when comparing browser versions. The example path must exist on the target machine. The tests use an isolated browser profile and do not use a personal browser session.

`HARBOR_HEADLESS` defaults to `1`; only `0` and `1` are accepted. Set it to `0` for a visible browser when investigating graphics availability in an interactive Windows session, then record which setting produced the result. Hardware mode does not force SwiftShader or enable unsafe WebGPU flags. On Windows systems with integrated and discrete graphics, `HARBOR_GPU_POWER=high-performance` adds Chromium's `--force_high_performance_gpu` launch switch for this isolated test process. It does not change system graphics preferences. This option is accepted only in Windows hardware mode. Retain evidence of the original selection: a WebGPU `powerPreference` hint alone may still choose integrated graphics. See the [Dawn test documentation](https://dawn.googlesource.com/dawn/+/HEAD/webgpu-cts/) for Chromium's GPU selection switches.

## Adapter acceptance

`tests/browser-gpu.mjs` observes the WebGPU adapters and WebGL contexts requested by application code. Hardware acceptance rejects fallback adapters, recognized software implementations such as SwiftShader/WARP/llvmpipe, missing or generic-only identities, and any recorded adapter that does not match `HARBOR_GPU_EXPECT`. Matching is a case-insensitive substring check across the browser-reported vendor, architecture, device, and description.

The expectation matches only information the browser exposes. `GTX 1070` requires that exact model substring and fails when WebGPU reports only `nvidia` / `pascal`. The example uses a vendor expectation for that privacy-limited browser; that result alone identifies an NVIDIA adapter, not a specific model. For a device-specific report, also record Chromium's `SystemInfo.getInfo` active GPU, its driver, the application's WebGL renderer string where available, and the machine's GPU inventory. A host with one NVIDIA card and matching NVIDIA/Pascal application evidence supports attribution to that card; several matching cards require stronger evidence. Preserve the redacted WebGPU fields and explain this inference in the report. Never treat an operating-system listing alone, or a software-adapter pass, as application hardware validation.

The functional scripts default to `software` mode unless `HARBOR_GPU_MODE` is set. `bench:gpu` defaults to `hardware`. Set the mode explicitly in reproducible runs.

硬件脚本统一使用 `HARBOR_GPU_MODE=hardware`、`HARBOR_GPU_EXPECT=nvidia`；Windows 独显运行再设 `HARBOR_GPU_POWER=high-performance`。Harbor helper 不读取 `TEST_GPU`，该变量不能选择硬件模式。包装脚本必须显式传入这些变量，并在开始昂贵的场景准备或收敛前，断言实际测试页面记录的应用 adapter 满足硬件条件。误用软件模式的运行只作为诊断，不计入硬件验收。

Wrappers must set the `HARBOR_GPU_*` variables explicitly. The helper does not read `TEST_GPU`; that variable cannot select hardware mode. Assert hardware evidence from the actual test page before expensive scene preparation or convergence. A run accidentally using software mode is diagnostic evidence and cannot count as hardware acceptance.

## Functional checks

| Command | Scope | Evidence |
| --- | --- | --- |
| `npm run test:browser` | Built application: compact tracing at different bounce counts, geometry refit, quality facade and textured floor, camera/transform accumulation resets, WebGPU and WebGL2 raster gameplay, controls, bloom and screenshots | `tests/artifacts/browser-result.json` and screenshots |
| `npm run test:render` | Raster resource ownership, spawn/remove cycles, static batch teleport, failure cleanup, repeated facade disposal, resizing and hidden-canvas recovery | `tests/artifacts/render-lifecycle-result.json` |
| `npm run test:quality` | Native quality tracing with textures, normal map, HDR lighting and physical camera; resize/world updates; embedded Meshopt GLB and texture loading; borrowed-resource ownership and teardown with pending sample work | JSON diagnostics and graphics evidence on standard output; preserve the command log |

These are focused correctness checks, not performance measurements. Keep the complete default browser cases for acceptance. A filtered run using `HARBOR_BROWSER_CASES` proves only the selected cases.

Artifacts use fixed names and can be overwritten by later runs. Copy them to a dated run directory before changing the GPU mode, browser, or code. Keep machine addresses, credentials, and private host configuration out of committed reports.

## Quality tracing benchmark

`npm run bench:gpu` exercises a small static quality scene with a floor, glass sphere, and metal sphere. Its default hardware matrix is:

| Internal resolution | Maximum bounces | Path slots per render call (`frameBudget`) |
| --- | --- | --- |
| 320 × 180 | 4 | 8,192 |
| 320 × 180 | 4 | 32,768 |
| 320 × 180 | 4 | 57,600 |
| 640 × 360 | 8 | 131,072 |

Each case initializes the renderer, validates the observed application adapter, warms up until a complete sample is measurable, resets accumulation, and measures up to 10,000 serial render calls or approximately 10 seconds. A single call can extend the loop beyond that duration; per-operation deadlines bound stalled GPU work. The benchmark also checks finite/nonblack radiance, measurable sample progress, and accumulation reset/recovery after camera movement. Initialization and warmup are outside the measured dispatch loop. Radiance/sample readbacks and the camera-motion check run outside that loop as well. The report also retains the benchmark browser process's GPU inventory and renderer from Chromium's diagnostics, without profile paths or command lines.

The JSON report defaults to `tests/artifacts/gpu-benchmark.json`. Override it when preserving several runs:

```powershell
$env:HARBOR_BENCH_RESULT = 'tests/artifacts/gtx1070-benchmark.json'
npm run bench:gpu
```

The report includes the mode, purpose, timestamp, browser, observed adapters, case configurations, initialization time, dispatch timing distribution, sample measurements, radiance checks, and errors. A failed run writes a diagnostic report when the runner reaches its cleanup path; inspect `ok` and `failure` before using any partial case results.

`dispatchMs` measures wall-clock time around JavaScript `render()` submission followed by `device.queue.onSubmittedWorkDone()`. Submission and completion are serialized for every measured call. The figures include JavaScript/backend overhead and GPU queue completion latency; they are not GPU timestamp-query measurements. They also are not player frame rates: there is no ordinary RAF loop, concurrent game workload, input handling, or real presentation cadence in this measurement.

A quality render call advances a wavefront scheduler and is not one sample per pixel. Use the report's explicit sample readback and `averageSamplesPerSecond` alongside resolution, bounce count, and path budget. A smaller dispatch time by itself does not prove faster image convergence. Compare runs only with the same code/dependencies, scene, settings, browser, GPU, and timing procedure. Record background load and power settings when making a performance comparison.

## Explicit software smoke run

Use a software adapter to check the benchmark runner on a machine without usable hardware WebGPU:

```powershell
$env:HARBOR_GPU_MODE = 'software'
$env:HARBOR_GPU_POWER = 'default'
Remove-Item Env:HARBOR_GPU_EXPECT -ErrorAction SilentlyContinue
$env:HARBOR_BENCH_RESULT = 'tests/artifacts/gpu-benchmark-software-smoke.json'
npm run bench:gpu -- --smoke
```

On Linux, for example:

```sh
HARBOR_GPU_MODE=software HARBOR_GPU_POWER=default CHROMIUM_PATH=/usr/bin/chromium \
  HARBOR_BENCH_RESULT=tests/artifacts/gpu-benchmark-software-smoke.json \
  npm run bench:gpu -- --smoke
```

Smoke mode uses 32 × 24, four bounces, a 2,048 path-slot budget, and up to four measured calls or approximately one second. `--smoke` alone does not select a software adapter: set `HARBOR_GPU_MODE=software` explicitly. The report labels smoke runs as `functional-smoke`, including when `--smoke` is used with hardware. Software timings establish neither GPU speed nor suitable player-device settings. Restore hardware mode, the intended adapter expectation, and the Windows GPU preference before a hardware acceptance run.

## Limits that require separate evidence

A pass applies to the tested adapter, cases, and browser configuration. This short benchmark does not establish sustained thermals, power use, VRAM pressure/leak behavior, long-session stability, device-loss recovery, or performance under a complete game's workload. It does not validate other desktop/mobile GPUs, browsers, or headless/headed session configurations.

The broader quality backend still needs separate tests for continuous skinning/morph updates, large imported scenes and texture residency, CPU BVH preparation budgets, denoising/upscaling integration, motion stability, and production game image quality. Optional OIDN/FSR exports do not establish installed or tested denoising. Compact tracing has its own narrower material/asset contract; quality results do not extend it. Neither backend claims a standard hardware RT-core API.

Platform-specific iframe permissions, storage, input/audio activation, packaging limits, and publishing acceptance also need their own verification. Record these as untested or blocked when appropriate rather than treating a hardware smoke/benchmark pass as complete engine certification.
