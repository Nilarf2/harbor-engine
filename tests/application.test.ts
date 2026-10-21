import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication, FrameLoop, SceneManager, type ApplicationHost, type ApplicationScene, type SceneFactory, type SceneLoadContext } from '../src/application/index.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Host implements ApplicationHost {
  width = 800; height = 600; hidden = false; milliseconds = 0;
  private serial = 0;
  frames = new Map<number, (time: number) => void>();
  events = new Map<string, Set<() => void>>();
  now = () => this.milliseconds;
  request = (callback: (time: number) => void) => { const id = ++this.serial; this.frames.set(id, callback); return id; };
  cancel = (id: number) => { this.frames.delete(id); };
  listen(type: string, callback: () => void) {
    let set = this.events.get(type); if (!set) this.events.set(type, set = new Set()); set.add(callback);
    return () => { set!.delete(callback); };
  }
  emit(type: string) { for (const callback of this.events.get(type) ?? []) callback(); }
  tick(milliseconds: number) {
    this.milliseconds += milliseconds;
    const frames = [...this.frames.values()]; this.frames.clear();
    for (const callback of frames) callback(this.milliseconds);
  }
}
type State = { value: number };
function scene(id: string, events: string[] = [], overrides: Partial<ApplicationScene<State>> = {}): ApplicationScene<State> {
  let state = { value: 0 };
  return {
    id,
    enter() { events.push(`${id}:enter`); },
    update(dt) { events.push(`${id}:update:${dt}`); },
    render() { events.push(`${id}:render`); },
    resize(w, h) { events.push(`${id}:resize:${w}x${h}`); },
    snapshot() { return { ...state }; },
    restore(next) { state = { ...next }; events.push(`${id}:restore`); },
    diagnostics() { return { id }; },
    dispose() { events.push(`${id}:dispose`); },
    ...overrides,
  };
}
function factory(id: string, load: (context: SceneLoadContext) => Promise<ApplicationScene<State>>): SceneFactory<object, State> {
  return { manifest: { id }, load };
}

test('application step uses seconds exactly once, while RAF clamps and visibility resets its clock', async () => {
  const host = new Host(), updates: number[] = [], renders: number[] = [];
  const app = createApplication<object, State>({ services: {}, host, autoStart: false,
    scenes: [factory('A', async () => scene('A', [], { update: dt => { updates.push(dt); }, render: t => { renders.push(t); } }))],
  });
  await app.switchScene('A'); updates.length = 0; renders.length = 0;
  app.step(1); assert.deepEqual(updates, [1]); assert.equal(renders.length, 1);
  app.step(0.25, false); assert.deepEqual(updates, [1, 0.25]); assert.equal(renders.length, 1);
  app.start(); host.tick(1000); assert.equal(updates.at(-1), 0.1);
  host.hidden = true; host.emit('visibilitychange'); assert.equal(host.frames.size, 0);
  host.tick(60_000); host.hidden = false; host.emit('visibilitychange'); host.tick(16);
  assert.equal(updates.at(-1), 0.016); assert.equal(app.running, true);
  await app.dispose(); assert.equal(host.frames.size, 0);
  assert.equal([...host.events.values()].reduce((sum, set) => sum + set.size, 0), 0);
  assert.throws(() => app.step(1), /disposed/);
});

test('frame loop errors stop RAF; manual errors and invalid/reentrant seconds remain observable', () => {
  const host = new Host(), failures: Error[] = [], loop = new FrameLoop({ scheduler: host, onError: error => { failures.push(error); } });
  loop.add(() => { throw new Error('update failed'); });
  assert.throws(() => loop.step(0), /update failed/);
  assert.throws(() => loop.step(-1), /Timestep/);
  loop.start(); host.tick(16); assert.equal(loop.running, false); assert.equal(failures[0].message, 'update failed');
  const other = new FrameLoop(); other.add(() => other.step(0)); assert.throws(() => other.step(1), /not reentrant/);
  loop.dispose(); other.dispose();
});

test('A → slow B → C commits only C; cancellation is immediate and late resources drain in order', async () => {
  const events: string[] = [], loaded = deferred<ApplicationScene<State>>(), drained = deferred();
  let bContext!: SceneLoadContext;
  const manager = new SceneManager<object, State>({});
  manager.register(factory('A', async () => scene('A', events)));
  manager.register(factory('B', async context => {
    bContext = context; context.scope.defer(() => { events.push('B:assets'); }); return loaded.promise;
  }));
  manager.register(factory('C', async () => scene('C', events)));
  await manager.switchTo('A');
  const b = manager.switchTo('B'), c = manager.switchTo('C');
  assert.equal(bContext.signal, bContext.scope.signal); assert.equal(bContext.signal.aborted, true);
  assert.equal(bContext.scope.disposed, false); assert.equal(events.includes('B:assets'), false);
  assert.equal(await c, true); assert.equal(manager.current?.id, 'C');
  loaded.resolve(scene('B', events, { async dispose() { events.push('B:drain'); await drained.promise; events.push('B:dispose'); } }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.includes('B:enter'), false); assert.equal(events.includes('B:assets'), false);
  drained.resolve(); assert.equal(await b, false);
  assert.deepEqual(events.filter(x => x.startsWith('B:')), ['B:drain', 'B:dispose', 'B:assets']);
  assert.equal(manager.current?.id, 'C'); assert.equal(events.filter(x => x === 'A:dispose').length, 1);
  await manager.dispose();
});

test('load, restore and enter failures keep the previous scene and shared canvas usable', async () => {
  const events: string[] = [], canvas = { live: true }, manager = new SceneManager<object, State>({});
  manager.register(factory('A', async () => scene('A', events, { render() { assert.equal(canvas.live, true); events.push('A:render'); } })));
  manager.register(factory('load', async context => { context.scope.defer(() => { events.push('load:assets'); }); throw new Error('load failed'); }));
  manager.register(factory('restore', async () => scene('restore', events, { restore() { throw new Error('restore failed'); } })));
  manager.register(factory('enter', async () => scene('enter', events, { enter() { throw new Error('enter failed'); } })));
  await manager.switchTo('A'); const previous = manager.current;
  for (const id of ['load', 'restore', 'enter']) {
    await assert.rejects(manager.switchTo(id, { value: 42 }), new RegExp(`${id} failed`));
    assert.equal(manager.current, previous); assert.equal(manager.loading, false); previous!.render(0);
  }
  assert.equal(events.includes('A:dispose'), false);
  assert.equal(events.filter(x => x === 'restore:dispose').length, 1);
  assert.equal(events.filter(x => x === 'enter:dispose').length, 1);
  assert.ok(events.includes('load:assets'));
  await manager.dispose();
});

test('factories cannot borrow the current scene or reuse a disposed instance', async () => {
  const events: string[] = [], a = scene('A', events), manager = new SceneManager<object, State>({});
  manager.register(factory('A', async () => a));
  manager.register(factory('B', async () => scene('B', events)));
  await manager.switchTo('A');
  await assert.rejects(manager.switchTo('A'), /fresh instance/);
  assert.equal(manager.current, a); assert.equal(events.includes('A:dispose'), false);
  await manager.switchTo('B'); await assert.rejects(manager.switchTo('A'), /fresh instance/);
  assert.equal(manager.current?.id, 'B'); assert.equal(events.filter(x => x === 'A:dispose').length, 1);
  await manager.dispose();
});

test('preparation and cleanup failures are both retained and never leave loading stuck', async () => {
  const manager = new SceneManager<object, State>({});
  manager.register(factory('A', async () => scene('A')));
  manager.register(factory('broken', async () => scene('broken', [], {
    enter() { throw new Error('activation failed'); }, dispose() { throw new Error('cleanup failed'); },
  })));
  await manager.switchTo('A');
  await assert.rejects(manager.switchTo('broken'), error => {
    assert.ok(error instanceof AggregateError); assert.match(String(error.errors[0]), /activation failed/);
    assert.ok(error.errors[1] instanceof AggregateError); return true;
  });
  assert.equal(manager.loading, false); assert.equal(manager.current?.id, 'A'); await manager.dispose();
});

test('a synchronous replacement requested by enter prevents that candidate from committing', async () => {
  const events: string[] = [], manager = new SceneManager<object, State>({}); let replacement!: Promise<boolean>;
  manager.register(factory('A', async () => scene('A', events)));
  manager.register(factory('B', async () => scene('B', events, { enter() { replacement = manager.switchTo('C'); } })));
  manager.register(factory('C', async () => scene('C', events)));
  await manager.switchTo('A'); assert.equal(await manager.switchTo('B'), false); assert.equal(await replacement, true);
  assert.equal(manager.current?.id, 'C'); assert.equal(events.filter(x => x === 'B:dispose').length, 1); await manager.dispose();
});

test('root dispose drains pending candidates before services and prevents late enter/render', async () => {
  const events: string[] = [], loaded = deferred<ApplicationScene<State>>(), drained = deferred();
  const host = new Host(); let context!: SceneLoadContext;
  const app = createApplication<object, State>({ services: {}, host,
    scenes: [factory('A', async () => scene('A', events)), factory('B', async value => {
      context = value; value.scope.defer(() => { events.push('B:assets'); }); return loaded.promise;
    })],
    disposeServices() { events.push('services:dispose'); },
  });
  await app.switchScene('A'); const pending = app.switchScene('B');
  const disposing = app.dispose(); assert.equal(disposing, app.dispose()); assert.equal(context.signal.aborted, true);
  loaded.resolve(scene('B', events, { async dispose() { events.push('B:drain'); await drained.promise; events.push('B:dispose'); } }));
  await Promise.resolve(); await Promise.resolve(); host.tick(1000);
  assert.equal(events.includes('services:dispose'), false); assert.equal(events.includes('B:enter'), false); assert.equal(events.includes('B:render'), false);
  drained.resolve(); assert.equal(await pending, false); await disposing;
  assert.deepEqual(events.slice(-5), ['B:drain', 'B:dispose', 'B:assets', 'A:dispose', 'services:dispose']);
  assert.equal(app.current, undefined);
});

test('scene teardown attempts view, deferred resources and shared services even when each fails', async () => {
  const events: string[] = [], app = createApplication<object, State>({ services: {}, host: new Host(), autoStart: false,
    scenes: [factory('A', async context => {
      context.scope.defer(() => { events.push('assets'); throw new Error('asset failed'); });
      return scene('A', events, { dispose() { events.push('view'); throw new Error('view failed'); } });
    })], disposeServices() { events.push('services'); throw new Error('service failed'); },
  });
  await app.switchScene('A'); await assert.rejects(app.dispose(), AggregateError);
  assert.deepEqual(events.slice(-3), ['view', 'assets', 'services']);
});
