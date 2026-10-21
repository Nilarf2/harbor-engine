# Harbor Engine · Harbor 游戏引擎

面向 AI 辅助开发的模块化 Web 3D 引擎。游戏在独立应用中编写，通过公开模块复用场景生命周期、模拟、资产与渲染。GPU 无关的逻辑可在 Node.js 开发和测试，图形在浏览器中运行。

A modular Web 3D engine for AI-assisted game development. Games live in independent applications and reuse public modules for lifecycle, simulation, assets and rendering. GPU-free logic runs in Node.js; graphics run in the browser.

**0.2.0 experimental alpha · 实验性版本。** 新增原生场景应用宿主、以秒为单位的应用时钟、可取消的异步切场景，以及兼容应用原始 JSON 存档的存储模块。`createGame()` 的固定步长语义保持不变。GPU 实测结果、适用版本与限制见 [验证记录 / validation](docs/VALIDATION.md)；此前 GTX 1070 记录不自动覆盖 0.2 新增功能。

Version 0.2 adds a native-scene application host, a seconds-based application clock, cancellable asynchronous scene switching and raw application saves. `createGame()` retains its fixed-tick semantics. Existing GTX 1070 results apply to the revision and checks recorded in the validation log; new features require their own acceptance.

## 快速开始 · Quick start

需要 Node.js 22.12+。Requires Node.js 22.12 or newer.

```sh
npm ci
npm run create-game -- ../my-game
cd ../my-game
npm install
npm run dev
```

生成的项目包含独立引擎包、场景、移动和跳跃、跟随相机、构建配置与许可说明，可以离开本仓库构建。游戏规则、输入、UI、剧情和平台适配属于应用。

The generated game contains its own engine tarball, scene, movement/jumping, camera, build configuration and notices. It builds independently of this checkout. Game rules, input, UI, story and host integration belong in the application.

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

`createGame()` 适合声明式 World 与固定步长游戏；已有 Three.js 场景、TSL 材质、后处理和剧情控制器的应用可使用 [`createApplication()`](docs/APPLICATION.md)，保留原有 Scene、Camera 和渲染管线。应用宿主不自动转换材质或碰撞规则。

Use `createGame()` for declarative Worlds with fixed ticks. Use [`createApplication()`](docs/APPLICATION.md) when an existing game owns native Three.js scenes, TSL materials, postprocessing and story controllers. It preserves those objects and does not automatically convert materials or collision rules.

## 公共模块 · Public modules

| Import | 职责 · Responsibility |
| --- | --- |
| `@harbor/engine` | 无 GPU 的固定步长 World、实体、验证、命令、插件与 Scope / GPU-free fixed-tick World, entities, validation, commands, plugins and Scope |
| `@harbor/engine/application` | 原生场景生命周期、异步切场景、应用时钟、可等待释放 / Native-scene lifecycle, asynchronous transitions, application clock, awaited disposal |
| `@harbor/engine/browser` | `createGame()`：声明式 World 与可选模拟、渲染模块 / Declarative World facade with optional simulation and views |
| `@harbor/engine/pathtracing` | 原生 WebGPU 路径追踪、Three 场景桥接与静态细化 / Native WebGPU tracing, Three scene bridge and static refinement |
| `@harbor/engine/raytrace` | 小型 WGSL 参考追踪器、CPU BVH 构建与 refit / Compact WGSL reference tracer and CPU BVH construction/refit |
| `@harbor/engine/render` | Three WebGPU/WebGL2 光栅视图与视觉效果 / Three WebGPU/WebGL2 raster view and effects |
| `@harbor/engine/physics` | 可选 Rapier 刚体、碰撞与角色移动 / Optional Rapier rigid bodies, collisions and character movement |
| `@harbor/engine/assets` | 共享加载、取消、资源所有权、GLB/Meshopt 与角色 / Shared loads, cancellation, ownership, GLB/Meshopt and actors |
| `@harbor/engine/platform` | 浏览器/iframe 基础接口、原始 JSON 存档和内存回退 / Browser/iframe baseline, raw JSON saves and memory fallback |
| `@harbor/engine/narrative` | 带稳定检查点的生成器剧情调度 / Generator stories with stable checkpoints |
| `@harbor/engine/spatial` | 旋转矩形的 CPU 空间粗筛 / CPU spatial broad phase for rotated rectangles |

根模块不依赖 Three.js 或 GPU；`Scope.listen()` 接受标准 EventTarget。场景应用模块可注入确定性 host，在 Node.js 测试生命周期与时间。新游戏请从 [AI 开发指南 / AI guide](docs/AI_GUIDE.md)、[应用合同 / application contract](docs/APPLICATION.md) 和 [AGENTS.md](AGENTS.md) 开始。

The root module has no Three.js or GPU dependency; `Scope.listen()` accepts standard EventTargets. The application module accepts a deterministic host for Node lifecycle/clock tests. Start with the linked contracts before extending engine internals.

## 渲染选择 · Rendering choices

| Choice | 用途与边界 · Purpose and boundaries |
| --- | --- |
| `pathtrace` / `quality` | 基于 [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) 的 WebGPU 实现；支持其材质模型内的贴图、物理材质与 HDR / Native WebGPU integration with textures, physical materials and HDR within the upstream material model |
| `pathtrace` / `compact` | 常量材质、静态三角形、CPU BVH/refit 的参考实现 / Reference implementation with constant materials, static triangles and CPU BVH/refit |
| `raster` | Three WebGPU 光栅渲染，可显式选择 WebGL2 兼容后端 / Three WebGPU raster rendering with an explicit WebGL2 compatibility backend |

省略 mode 使用 raster；pathtrace 的默认后端为 quality。路径追踪需要 HTTPS 或 localhost 上的 WebGPU。两种追踪器都不宣称标准硬件 RT-core 接口。上游能力不等于本仓库已全部验证；自定义 TSL、MToon、连续变形与动态几何需要明确的转换、同步和验收。交互画面与静态细化有不同采样预算。

Omitting mode selects raster; pathtrace defaults to quality. Tracing requires WebGPU on HTTPS or localhost. Neither tracer claims a standard hardware RT-core API. Upstream features are broader than the tested subset; custom TSL/MToon materials, deformation and dynamic geometry need explicit conversion, synchronization and validation. Interactive rendering and static refinement use different sample budgets.

OIDN 权重与许可在包内同源提供；应用负责复制和配置资源 URL。是否成功降噪以当前设备和测试记录为准。Blender 资产请看 [Blender workflow](docs/BLENDER.md)，渲染和所有权细节请看 [Architecture](docs/ARCHITECTURE.md)。

OIDN weights and notices are packaged for same-origin use; applications copy them and configure their URLs. Denoising acceptance is device- and test-specific. See the linked Blender and architecture guides for asset and ownership details.

## 无 GPU 开发与验收 · GPU-free development and validation

```sh
npm test
npm run build
npm run scene -- validate demo/scene.json
npm run scene -- simulate demo/scene.json --steps 180
npm run assets -- inspect path/to/source.glb
npm run assets -- optimize path/to/source.glb path/to/new-output.glb
```

资产工具不覆盖源文件或已有产物，报告原始、gzip 与 Brotli 大小；压缩不保证交付体积更小。纹理转码、KTX2 输出与导航烘焙不在此命令中。

Asset tools preserve sources and existing outputs and report raw/gzip/Brotli sizes. Compression can increase delivery size. Texture transcoding, KTX2 output and navigation baking are outside this command.

```sh
npm run dev
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
CHROMIUM_PATH=/usr/bin/chromium npm run test:render
CHROMIUM_PATH=/usr/bin/chromium npm run test:quality
HARBOR_GPU_MODE=hardware npm run bench:gpu
```

默认示例为光照研究；`?scene=island&mode=play` 为角色、物理与交互示例。浏览器测试需要可用图形适配器。CI 检查锁定安装、Node 测试与构建，不假设托管 runner 有 GPU。软件适配器只能证明测试路径功能，不能证明实际显卡性能。硬件步骤见 [Hardware validation](docs/HARDWARE_VALIDATION.md)。

The default example is a lighting study; `?scene=island&mode=play` exercises characters, physics and interaction. Browser checks require a functioning adapter. CI installs locked dependencies, runs Node tests and builds without assuming a hosted GPU. Software-adapter results establish functionality only. Follow the hardware procedure for device acceptance.

## 打包与发布 · Packaging and distribution

```sh
npm run export
```

示例导出至 `deliverables/harbor-demo-web.zip`，包含相对 URL、许可和 SHA-256 资源清单。独立应用构建自己的 `dist/`。部署使用 HTTP/HTTPS；平台 iframe 权限、持久化、下载和 SDK 限制需在实际目标验收。引擎提供浏览器适配基础，不代表已获 Bilibili Toy 或 VibeHub 认证。

The demo ZIP includes relative URLs, notices and a SHA-256 manifest. Independent applications build their own `dist/`. Deploy over HTTP/HTTPS and verify iframe permissions, persistence, downloads and SDK restrictions on each host. Browser adapter support does not imply Bilibili Toy or VibeHub certification.

版本变化见 [Release notes](docs/RELEASE_NOTES.md)，当前边界和研究候选见 [Research](docs/RESEARCH.md)。画质、交互与资源正确性先通过真实场景验收，再据测量优化。

See the release notes for changes and research notes for remaining candidates. Validate image quality, interaction and resource correctness in real applications before optimizing from measurements.

## 贡献与许可 · Contributors and license

- **Nilarf2** — 项目所有者、产品方向与需求 / Project owner, product direction and requirements.
- **Codex (OpenAI)** — AI 编程协作者，参与实现、集成、工具、文档和验证 / AI programming collaborator for implementation, integration, tooling, documentation and validation.

Harbor 原创代码与示例使用 MIT。复用依赖和资源保留各自许可。角色模型、资产帮助模块、剧情调度与空间粗筛来自 Nilarf2 的 MIT Dragon Raja 项目；小说、地图和地点内容不作为通用引擎资产分发。未复制 Tidewater 的游戏代码或美术。详见 [NOTICE.md](NOTICE.md)。

Original Harbor code/examples use MIT. Reused packages and assets retain their licenses. Actor/asset utilities, story scheduling and spatial broad phase derive from Nilarf2's MIT Dragon Raja project; its novel, map and location content are not generic engine assets. Tidewater code/art were not copied. See the notices.
