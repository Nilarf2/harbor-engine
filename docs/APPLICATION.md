# Native application contract · 原生应用合同

`@harbor/engine/application` 管理已有游戏的生命周期、时钟与异步场景切换。它不创建 World、不替换原生 Three.js Scene/Camera、不重写材质或碰撞，也不决定画面后处理。游戏通过 services 显式传入共享渲染器、UI、输入与资产。

`@harbor/engine/application` manages lifecycle, clocks and asynchronous transitions for an existing game. It does not create a World, replace native Three.js scenes/cameras, convert materials/collisions or choose postprocessing. Pass shared renderers, UI, input and assets explicitly through services.

## Integration · 接入

```ts
import { createApplication, type SceneFactory } from '@harbor/engine/application';
import { Scope } from '@harbor/engine';

interface Services { renderer: MyRenderer; ui: MyUI }
interface Save { schema: 1; checkpoint: string }
interface Manifest { id: string; title: string }

const sceneFactory: SceneFactory<Services, Save, Manifest> = {
  manifest: { id: 'harbor', title: 'Harbor' },
  async load({ renderer, ui, signal, scope }) {
    const model = await loadModel({ signal });
    scope.defer(() => model.release());
    const view = await createNativeView({ renderer, model });
    // load does not replace the active canvas/UI. enter is synchronous.
    return {
      id: 'harbor',
      enter() { ui.activate('harbor'); },
      update(dt, time) { updateGame(dt, time); },
      render(time) { view.render(time); },
      resize(width, height) { view.resize(width, height); },
      snapshot() { return { schema: 1 as const, checkpoint: 'arrival' }; },
      restore(save) { restoreCheckpoint(save.checkpoint); },
      diagnostics() { return { location: 'harbor' }; },
      async dispose() { await view.dispose(); },
    };
  },
};

const app = createApplication<Services, Save, Manifest>({
  services: { renderer, ui },
  scenes: [sceneFactory],
  autoStart: false,
  resizeServices: (width, height) => renderer.setSize(width, height),
  disposeServices: async () => { await renderer.dispose(); ui.dispose(); },
});
await app.switchScene('harbor', oldSave);
app.start();
// Shutdown awaits pending loads, views, scene assets, then shared services.
await app.dispose();
```

示例的 MyRenderer/MyUI/loadModel/createNativeView 等由应用实现。SceneFactory 的 manifest 由应用扩展，只有非空 id 为引擎必需。每次 load 返回全新实例，禁止返回 active 或已管理/已释放的实例。

The example's renderer/UI/loaders are application-owned. Manifest fields are extensible; the engine requires a nonempty ID. Every load returns a fresh scene instance. Returning the active or any previously managed/disposed scene is rejected without disposing the borrowed instance.

## Time · 时间

- `app.step(seconds, render = true)` 一次调用一次 `update(seconds,time)`，不拆分、不截断；`step(1)` 是一秒。`render=false` 只更新。 / One update with exact seconds, optionally one render; no splitting or clamping.
- RAF 的 dt 默认为最多 0.1 秒，可用 `maxFrameDelta` 调整；隐藏暂停与恢复重置墙钟基线。 / RAF dt defaults to a 0.1-second cap; visibility changes reset its wall-clock baseline.
- `createGame().step(count)` 与 `World.step(count)` 仍是固定 tick 数；`World.advance(seconds)` 保留其累积/最大子步合同。 / The existing browser facade and World retain their fixed-tick contracts.
- 应用宿主加载场景期间暂停当前 update/render，时钟继续按调用累计；旧场景资源仍保留以便失败回退。 / Update/render pause during loading; explicit/RAF clock time still advances, and old resources remain available for rollback.
- 手动 step 的错误直接抛出；RAF 错误停止循环并交给 `onError`。 / Manual errors throw; RAF errors stop the loop and call `onError`.

## Transitions and cancellation · 切场景与取消

`switchScene(id, state?)` 返回 `Promise<boolean>`。只有最新请求能提交；被后续请求取消的候选返回 false。未知 ID 和活动请求的 load/restore/enter 错误会拒绝 Promise。旧场景先保持活动，新候选在独立 load 中准备，restore 在 enter 前调用；enter 成功后提交，然后等待旧场景释放。

`switchScene(id, state?)` resolves true only for a committed request. Superseded candidates resolve false. Unknown IDs and active-request load/restore/enter errors reject. The previous scene remains alive while the candidate loads independently. Optional restore precedes enter; successful enter commits the candidate before awaiting previous-scene teardown.

`enter()` 必须同步。异步初始化属于 load；restore 应同步验证并恢复应用状态。旧场景存续保证不等于任意 UI 副作用可自动回滚：load/restore 不应破坏当前画面，enter 的部分 UI 变更必须能由候选 dispose 撤销，而且不能清理其他场景的 UI/canvas。

`enter()` is synchronous. Put async preparation in load and synchronous validation/state restoration in restore. Keeping the old scene alive cannot automatically reverse arbitrary UI mutations: load/restore must preserve the active presentation, and candidate disposal must undo partial enter side effects without clearing another scene's UI/canvas.

传入 load 的 `signal === scope.signal`。后续切换或根释放会立即 abort 信号；这不会立即运行 defer。候选即使忽略取消且晚到，宿主也会等待其 dispose，再逆序运行 scope.defer。GPU 资源不应在仍使用它的 view 完成释放前删除。

The load context's signal and scope.signal are the same object. A newer request or root disposal aborts it immediately without running deferred cleanup. Even a loader that ignores cancellation has its late result disposed and awaited before reverse scope cleanup. Keep assets alive until their view/GPU work has drained.

返回实例之前失败的 factory 必须把已获得资源注册到 scope，或自行清理无法移交的部分 view；宿主无法释放尚未返回且未注册的资源。Scope.defer 为同步 cleanup，异步 GPU 清理放入 scene.dispose。

Factories that fail before returning must register acquired resources with scope or explicitly dispose partial views they cannot return. The host cannot clean up an unregistered, unreturned object. Scope.defer owns synchronous cleanup; async GPU teardown belongs in scene.dispose.

## Ownership and root disposal · 所有权与根释放

顺序：立即停止 RAF/监听 → abort pending → 等待所有 pending 候选完成并释放 → 释放 active scene → `disposeServices()`。scene.dispose 完成后才运行对应 scope。每个已管理实例只释放一次，重复 root dispose 返回同一个 Promise。清理错误聚合后抛出，其他清理仍会尝试。

Order: stop RAF/listeners immediately → abort pending loads → await and dispose late candidates → dispose the active scene → dispose shared services. Each scene's scope runs after its async dispose. Managed instances clean up once, repeated root disposal returns the same Promise, and cleanup errors aggregate without skipping remaining cleanup.

不要把 shared renderer 加入某个候选 scope；它属于 disposeServices。使用借用渲染器的路径追踪 view 时，view 不拥有 renderer/device/原始资产；最终 tone mapping 与 sRGB 输出属于应用最终管线。切换失败后共享 canvas 必须仍可使用。

Keep shared renderers in disposeServices rather than a candidate scope. A tracing view that borrows the renderer does not own its renderer/device/source assets. Final tone mapping and sRGB presentation belong in the application's final pipeline. Failed transitions must leave the shared canvas usable.

`Scope(parentSignal?)` 仍是同步逆序一次性清理器；`add` 与 `defer` 等价。`listen` 自动注册并释放 EventTarget listener。父信号取消只更新 signal，dispose 才执行 defer；已释放后添加 cleanup 会立即执行。

Scope remains a synchronous reverse-order one-shot cleanup owner. add and defer are equivalent; listen owns an EventTarget listener. Parent cancellation aborts the signal while disposal runs deferred cleanup. Adding cleanup after disposal executes it immediately.

## Legacy saves · 旧档兼容

```ts
import { SaveStore } from '@harbor/engine/platform';
const saves = new SaveStore<Save>({
  key: 'dragon-raja.save.v1',
  validate: parseSchema1,
  get storage() { return window.localStorage; },
});
saves.write(snapshot);
const restored = saves.read();
console.log(saves.persistent);
```

SaveStore 使用精确 key 与原始 JSON，不增加 namespace/version/data 包装。validator 由应用提供，应验证完整 schema 并返回独立数据。读取损坏 JSON/schema 会抛内容错误；访问 storage/getItem/setItem 失败会关闭持久化并保留可用内存。persistent 反映是否仍可访问 storage，不保证浏览器将永久保留数据。

SaveStore preserves the exact key and raw JSON without an envelope. Supply an application schema validator that returns detached data. Corrupt JSON/schema throws a content error. Denied storage/getItem/setItem access disables persistence while retaining usable memory. persistent reports the storage capability, not a promise of indefinite browser retention.

现有 `createBrowserPlatform` 的 namespaced save API 仍适用于新档格式；迁移时不要无意替换旧 raw key。 / The existing namespaced browser-platform save API remains available for new formats; avoid silently changing legacy raw keys during migration.

## Story and collision · 剧情与碰撞

`StoryRunner` 使用稳定 beat.id、数值等待与条件谓词，每次 update 最多推进一个生成器 yield。next/stop 关闭旧生成器，执行其 finally。检查点、指令的实际含义与完整存档属于游戏。

StoryRunner uses stable beat IDs, waits in seconds and predicates, advancing at most one generator yield per update. next/stop closes the previous generator and runs finally. Checkpoint meaning, commands and full persistence belong to the game.

`SpatialIndex<Rect>` 仅将旋转矩形分配到 CPU 网格并返回候选集合；它不决定精确碰撞、地面高度、台阶、水域、座位和剧情移动。位置或尺寸变化后重新 add；remove/clear 解除索引。不要仅因迁移而把已验收角色控制换成 Rapier。

SpatialIndex stores rotated-rectangle bounds in a CPU grid and returns broad-phase candidates. Exact collision, floor height, steps, water, seats and scripted movement remain game rules. Re-add moved/resized bounds and remove/clear retired ones. Migrating an application does not itself justify replacing an accepted controller with Rapier.

## Node acceptance · Node 验收

可注入 `ApplicationHost` 的 now/request/cancel、width/height/hidden 与 listen，测试时间与事件而不创建浏览器/GPU。运行 `npm test`。新增测试覆盖 latest-load-wins、错误回退、取消、晚到清理、根释放、时钟、存储权限、剧情与空间查询；图形能力仍需独立真实设备验收。

Inject an ApplicationHost scheduler, dimensions, visibility and listeners to test clocks/events without a browser or GPU. Run npm test. Behavior tests cover races, rollback, cancellation, late cleanup, root disposal, clocks, storage permissions, story and spatial queries. Graphics capabilities still require independent device acceptance.
