import { Scope } from './Scope.js';
import { EventBus } from './events.js';
import { cloneJson, validateEntity, validateFixedDelta, validateId, validateScene, validateSeed } from './validation.js';
import type { Command, Disposer, Entity, EntityDefinition, SceneDefinition, WorldSnapshot } from './types.js';

export type SystemPhase = 'beforePhysics' | 'physics' | 'afterPhysics';
export interface System { id: string; phase?: SystemPhase; order?: number; update(world: World, dt: number): void }
export interface Plugin { id: string; requires?: string[]; setup(world: World, scope: Scope): void }
export interface WorldOptions { seed?: number; fixedDelta?: number; maxSubSteps?: number }
type InstalledSystem = { system: System; sequence: number };
const phases: Record<SystemPhase, number> = { beforePhysics: 0, physics: 1, afterPhysics: 2 };

/** Fixed-step simulation. Importing or running this module never requires a browser or GPU. */
export class World {
  readonly entities = new Map<string, Entity>();
  readonly events = new EventBus();
  readonly services = new Map<string, unknown>();
  readonly fixedDelta: number;
  readonly maxSubSteps: number;
  private systems = new Map<string, InstalledSystem>();
  private systemOrder?: InstalledSystem[];
  private commands = new Map<string, (command: Command) => unknown>();
  private plugins = new Map<string, Scope>();
  private installingPlugins = new Set<string>();
  private sequence = 0;
  private ticks = 0;
  private remainder = 0;
  private randomState: number;
  private stepping = false;
  private closed = false;

  constructor(options: WorldOptions = {}) {
    this.fixedDelta = validateFixedDelta(options.fixedDelta ?? 1 / 60);
    this.maxSubSteps = options.maxSubSteps ?? 8;
    if (!Number.isSafeInteger(this.maxSubSteps) || this.maxSubSteps < 1 || this.maxSubSteps > 1000) throw new TypeError('maxSubSteps must be an integer in [1, 1000]');
    this.randomState = validateSeed(options.seed ?? 1);
  }
  get tick(): number { return this.ticks; }
  get time(): number { return this.ticks * this.fixedDelta; }
  get disposed(): boolean { return this.closed; }
  private assertOpen(): void { if (this.closed) throw new Error('World disposed'); }

  spawn(definition: EntityDefinition): Entity {
    this.assertOpen();
    const entity = validateEntity(definition);
    if (this.entities.has(entity.id)) throw new Error(`Duplicate entity: ${entity.id}`);
    this.entities.set(entity.id, entity);
    try { this.events.emit('entity:spawn', entity); }
    catch (error) {
      this.entities.delete(entity.id);
      // Undo resources allocated by listeners before one of them rejected the entity.
      try { this.events.emit('entity:remove', entity); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Entity ${entity.id} spawn and rollback failed`);
      }
      throw error;
    }
    return entity;
  }

  remove(id: string): boolean {
    this.assertOpen();
    const entity = this.entities.get(id);
    if (!entity) return false;
    this.entities.delete(id);
    this.events.emit('entity:remove', entity);
    return true;
  }
  get(id: string): Entity | undefined { return this.entities.get(id); }
  query(tag: string): Entity[] { return [...this.entities.values()].filter(entity => entity.tags.includes(tag)); }

  addSystem(system: System): Disposer {
    this.assertOpen();
    validateId(system.id, 'system.id');
    if (this.systems.has(system.id)) throw new Error(`Duplicate system: ${system.id}`);
    if (system.phase !== undefined && !Object.prototype.hasOwnProperty.call(phases, system.phase)) throw new TypeError(`Unknown system phase: ${system.phase}`);
    if (system.order !== undefined && !Number.isFinite(system.order)) throw new TypeError('System order must be finite');
    if (typeof system.update !== 'function') throw new TypeError('System update must be a function');
    const installed = { system: { ...system }, sequence: this.sequence++ };
    this.systems.set(system.id, installed);
    this.systemOrder = undefined;
    return () => {
      if (this.systems.get(installed.system.id) === installed) {
        this.systems.delete(installed.system.id); this.systemOrder = undefined;
      }
    };
  }

  install(plugin: Plugin): void {
    this.assertOpen();
    validateId(plugin.id, 'plugin.id');
    const id = plugin.id;
    if (this.plugins.has(id) || this.installingPlugins.has(id)) throw new Error(`Duplicate plugin: ${id}`);
    if (typeof plugin.setup !== 'function') throw new TypeError('Plugin setup must be a function');
    if (plugin.requires !== undefined && !Array.isArray(plugin.requires)) throw new TypeError('Plugin requires must be an array');
    for (const dependency of plugin.requires ?? []) {
      validateId(dependency, 'plugin.requires');
      if (!this.plugins.has(dependency)) throw new Error(`Plugin ${plugin.id} requires ${dependency}`);
    }
    const scope = new Scope();
    this.installingPlugins.add(id);
    try {
      const result: unknown = plugin.setup(this, scope);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new TypeError('Plugin setup must be synchronous; await asset or WASM initialization before install');
      this.assertOpen();
    }
    catch (error) {
      try { scope.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Plugin ${plugin.id} setup and cleanup failed`); }
      throw error;
    } finally { this.installingPlugins.delete(id); }
    this.plugins.set(id, scope);
  }

  registerCommand(type: string, handler: (command: Command) => unknown): Disposer {
    this.assertOpen(); validateId(type, 'command.type');
    if (this.commands.has(type)) throw new Error(`Duplicate command: ${type}`);
    if (typeof handler !== 'function') throw new TypeError('Command handler must be a function');
    this.commands.set(type, handler);
    return () => { if (this.commands.get(type) === handler) this.commands.delete(type); };
  }
  command(command: Command): unknown {
    this.assertOpen();
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('Expected a command object');
    validateId(command.type, 'command.type');
    const handler = this.commands.get(command.type);
    if (!handler) throw new Error(`Unknown command: ${command.type}`);
    return handler(command);
  }

  step(count = 1): void {
    this.assertOpen();
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(this.ticks + count)) throw new TypeError('Step count must be a nonnegative safe integer');
    if (this.stepping) throw new Error('World stepping is not reentrant');
    this.stepping = true;
    try {
      for (let tick = 0; tick < count; tick++) {
        this.ticks++;
        const ordered = this.systemOrder ??= [...this.systems.values()].sort((a, b) =>
          phases[a.system.phase ?? 'beforePhysics'] - phases[b.system.phase ?? 'beforePhysics'] ||
          (a.system.order ?? 0) - (b.system.order ?? 0) || a.sequence - b.sequence);
        for (const installed of ordered) {
          if (this.systems.get(installed.system.id) === installed) installed.system.update(this, this.fixedDelta);
          if (this.closed) return;
        }
      }
    } finally { this.stepping = false; }
  }

  advance(seconds: number): { steps: number; alpha: number; droppedTime: number } {
    this.assertOpen();
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new TypeError('Elapsed seconds must be finite and nonnegative');
    if (this.stepping) throw new Error('World stepping is not reentrant');
    const total = this.remainder + seconds;
    const available = Math.floor((total + this.fixedDelta * 1e-9) / this.fixedDelta);
    if (!Number.isSafeInteger(available)) throw new TypeError('Elapsed seconds exceed safe tick precision');
    const steps = Math.min(available, this.maxSubSteps);
    this.remainder = Math.max(0, total - available * this.fixedDelta);
    this.step(steps);
    return { steps, alpha: Math.min(this.remainder / this.fixedDelta, 1), droppedTime: (available - steps) * this.fixedDelta };
  }

  random(): number {
    this.assertOpen();
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }

  snapshot(): WorldSnapshot {
    return { version: 1, tick: this.tick, time: this.time,
      entities: [...this.entities.values()].map(entity => cloneJson(entity, `entity.${entity.id}`) as unknown as Entity) };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    // Removal events run while dependent plugin services still exist.
    for (const entity of [...this.entities.values()].reverse()) {
      this.entities.delete(entity.id);
      try { this.events.emit('entity:remove', entity); } catch (error) { errors.push(error); }
    }
    for (const scope of [...this.plugins.values()].reverse()) {
      try { scope.dispose(); } catch (error) { errors.push(error); }
    }
    this.plugins.clear(); this.systems.clear(); this.systemOrder = undefined; this.commands.clear(); this.services.clear(); this.events.dispose();
    if (errors.length) throw new AggregateError(errors, 'World cleanup failed');
  }
}

export function createWorld(scene: SceneDefinition): World {
  const validated = validateScene(scene);
  const world = new World({ seed: validated.seed, fixedDelta: validated.fixedDelta });
  for (const definition of validated.entities) world.spawn(definition);
  return world;
}
