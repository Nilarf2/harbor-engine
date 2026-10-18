import type { Body, Entity, Json, Quat, SceneDefinition, Vec3, Visual } from './types.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const colorPattern = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function fail(path: string, message: string): never { throw new TypeError(`${path}: ${message}`); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'expected an object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected a plain object');
  return input as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
}
function numeric(input: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) {
    fail(path, `expected a finite number in [${min}, ${max}]`);
  }
  return input;
}
function bool(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') fail(path, 'expected a boolean');
  return input;
}
function tuple(input: unknown, length: number, path: string): number[] {
  if (!Array.isArray(input) || input.length !== length) fail(path, `expected ${length} numbers`);
  return Array.from(input, (value, index) => numeric(value, `${path}[${index}]`));
}
function positiveSize(input: unknown, path: string): Vec3 {
  const result = tuple(input, 3, path) as Vec3;
  if (result.some(value => value < 1e-4 || value > 1e6)) fail(path, 'all dimensions must be in [0.0001, 1000000]');
  return result;
}
function color(input: unknown, path: string): string {
  if (typeof input !== 'string' || !colorPattern.test(input)) fail(path, 'expected #RGB or #RRGGBB');
  return input;
}
export function validateId(input: unknown, path = 'id'): string {
  if (typeof input !== 'string' || !idPattern.test(input)) fail(path, 'expected 1–128 ASCII letters, digits, _, ., :, / or -; first character must be alphanumeric');
  return input;
}
export function validateSeed(input: unknown, path = 'seed'): number {
  const value = numeric(input, path, 0, 0xffffffff);
  if (!Number.isInteger(value)) fail(path, 'expected an unsigned 32-bit integer');
  return value;
}
export function validateFixedDelta(input: unknown, path = 'fixedDelta'): number {
  return numeric(input, path, 0.000001, 1);
}

/** Validate and copy JSON without sharing references or accepting cyclic/non-JSON values. */
export function cloneJson(input: unknown, path = 'data', parents = new Set<object>(), depth = 0): Json {
  if (depth > 64) fail(path, 'JSON nesting exceeds 64 levels');
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') return numeric(input, path);
  if (typeof input !== 'object' || !input) fail(path, 'expected JSON data');
  if (parents.has(input)) fail(path, 'cyclic JSON data');
  parents.add(input);
  try {
    if (Array.isArray(input)) return Array.from(input, (value, index) => cloneJson(value, `${path}[${index}]`, parents, depth + 1));
    const value = object(input, path);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${path}.${key}`, parents, depth + 1)]));
  } finally { parents.delete(input); }
}

function dimensions(shape: string, size: Vec3, path: string): void {
  if (shape === 'sphere' && (size[0] !== size[1] || size[1] !== size[2])) fail(path, 'sphere dimensions must be equal');
  if ((shape === 'capsule' || shape === 'cylinder' || shape === 'cone') && size[0] !== size[2]) fail(path, `${shape} width and depth must be equal`);
  if (shape === 'capsule' && size[1] < size[0]) fail(path, 'capsule height must be at least its diameter');
}

function visual(input: unknown, path: string): Visual {
  const value = object(input, path);
  keys(value, ['shape', 'size', 'color', 'roughness', 'metalness', 'transmission', 'ior', 'emissive', 'emissiveIntensity', 'batch', 'castShadow'], path);
  if (!['box', 'sphere', 'capsule', 'cylinder', 'cone'].includes(value.shape as string)) fail(`${path}.shape`, 'unknown visual shape');
  const result: Visual = { shape: value.shape as Visual['shape'], size: positiveSize(value.size, `${path}.size`) };
  dimensions(result.shape, result.size, `${path}.size`);
  if (own(value, 'color')) result.color = color(value.color, `${path}.color`);
  if (own(value, 'emissive')) result.emissive = color(value.emissive, `${path}.emissive`);
  if (own(value, 'roughness')) result.roughness = numeric(value.roughness, `${path}.roughness`, 0, 1);
  if (own(value, 'metalness')) result.metalness = numeric(value.metalness, `${path}.metalness`, 0, 1);
  if (own(value, 'transmission')) result.transmission = numeric(value.transmission, `${path}.transmission`, 0, 1);
  if (own(value, 'ior')) result.ior = numeric(value.ior, `${path}.ior`, 1, 3);
  if (own(value, 'emissiveIntensity')) result.emissiveIntensity = numeric(value.emissiveIntensity, `${path}.emissiveIntensity`, 0, 1e6);
  if (own(value, 'batch')) result.batch = bool(value.batch, `${path}.batch`);
  if (own(value, 'castShadow')) result.castShadow = bool(value.castShadow, `${path}.castShadow`);
  return result;
}

function body(input: unknown, path: string): Body {
  const value = object(input, path);
  keys(value, ['type', 'shape', 'size', 'friction', 'restitution', 'mass'], path);
  if (!['fixed', 'dynamic', 'character'].includes(value.type as string)) fail(`${path}.type`, 'unknown body type');
  if (!['box', 'sphere', 'capsule'].includes(value.shape as string)) fail(`${path}.shape`, 'unknown collision shape');
  const result: Body = { type: value.type as Body['type'], shape: value.shape as Body['shape'], size: positiveSize(value.size, `${path}.size`) };
  dimensions(result.shape, result.size, `${path}.size`);
  if (own(value, 'friction')) result.friction = numeric(value.friction, `${path}.friction`, 0, 1e6);
  if (own(value, 'restitution')) result.restitution = numeric(value.restitution, `${path}.restitution`, 0, 1);
  if (own(value, 'mass')) {
    result.mass = numeric(value.mass, `${path}.mass`, 1e-6, 1e6);
    if (result.type !== 'dynamic') fail(`${path}.mass`, 'mass applies only to dynamic bodies');
  }
  return result;
}

export function validateEntity(input: unknown, path = 'entity'): Entity {
  const value = object(input, path);
  keys(value, ['id', 'position', 'rotation', 'scale', 'visual', 'body', 'tags', 'data'], path);
  const result: Entity = {
    id: validateId(value.id, `${path}.id`),
    position: own(value, 'position') ? tuple(value.position, 3, `${path}.position`) as Vec3 : [0, 0, 0],
    rotation: own(value, 'rotation') ? tuple(value.rotation, 4, `${path}.rotation`) as Quat : [0, 0, 0, 1],
    scale: own(value, 'scale') ? positiveSize(value.scale, `${path}.scale`) : [1, 1, 1],
    tags: [], data: {},
  };
  if (result.position.some(axis => Math.abs(axis) > 1e6)) fail(`${path}.position`, 'coordinates must be in [-1000000, 1000000]');
  if (Math.abs(Math.hypot(...result.rotation) - 1) > 0.0001) fail(`${path}.rotation`, 'expected a normalized quaternion');
  if (own(value, 'visual')) result.visual = visual(value.visual, `${path}.visual`);
  if (own(value, 'body')) result.body = body(value.body, `${path}.body`);
  if (result.body && result.scale.some(axis => axis !== 1)) fail(`${path}.scale`, 'physics bodies require unit scale; set body.size explicitly');
  if (result.visual?.batch && result.body && result.body.type !== 'fixed') fail(`${path}.visual.batch`, 'only static entities may be batched');
  if (own(value, 'tags')) {
    if (!Array.isArray(value.tags)) fail(`${path}.tags`, 'expected an array');
    result.tags = Array.from(value.tags, (tag, index) => validateId(tag, `${path}.tags[${index}]`));
    if (new Set(result.tags).size !== result.tags.length) fail(`${path}.tags`, 'duplicate tag');
  }
  if (own(value, 'data')) result.data = cloneJson(object(value.data, `${path}.data`), `${path}.data`) as Record<string, Json>;
  return result;
}

/** A strict, detached scene definition. Validation finishes before a world is created. */
export function validateScene(input: unknown): SceneDefinition {
  const value = object(input, 'scene');
  keys(value, ['version', 'name', 'seed', 'fixedDelta', 'entities'], 'scene');
  if (value.version !== 1) fail('scene.version', 'expected version 1');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) fail('scene.name', 'expected a nonempty name of at most 160 characters');
  if (!Array.isArray(value.entities)) fail('scene.entities', 'expected an array');
  const seen = new Set<string>();
  const entities = Array.from(value.entities, (entity, index) => {
    const result = validateEntity(entity, `scene.entities[${index}]`);
    if (seen.has(result.id)) fail(`scene.entities[${index}].id`, `duplicate entity ID ${result.id}`);
    seen.add(result.id); return result;
  });
  const result: SceneDefinition = { version: 1, name: value.name, entities };
  if (own(value, 'seed')) result.seed = validateSeed(value.seed, 'scene.seed');
  if (own(value, 'fixedDelta')) result.fixedDelta = validateFixedDelta(value.fixedDelta, 'scene.fixedDelta');
  return result;
}
