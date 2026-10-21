import {
  BufferAttribute, BufferGeometry, Float16BufferAttribute, InstancedMesh, Mesh,
  Scene, SkinnedMesh, type InstancedBufferAttribute, type InterleavedBufferAttribute, type Material, type Object3D,
} from 'three/webgpu';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

type Attribute = BufferAttribute | InterleavedBufferAttribute;
export interface GeometryCompaction {
  readonly geometry: BufferGeometry;
  readonly sourceVertices: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly bytes: number;
  /** New vertex index -> original vertex index. Also used for deformation refreshes. */
  readonly sourceIndices: Uint32Array;
}
type CacheEntry = GeometryCompaction & { signature: string; source: BufferGeometry; morphOwner?: Mesh; groupStart?: number; groupCount?: number };

function copyAttribute(source: Attribute, vertices: Uint32Array): BufferAttribute {
  const interleaved = 'isInterleavedBufferAttribute' in source && source.isInterleavedBufferAttribute;
  const array = interleaved ? source.data.array : (source as BufferAttribute).array;
  const stride = interleaved ? source.data.stride : source.itemSize;
  const offset = interleaved ? source.offset : 0;
  const ArrayType = array.constructor as new (length: number) => typeof array;
  const output = new ArrayType(vertices.length * source.itemSize);
  for (let i = 0; i < vertices.length; i++) {
    const from = vertices[i] * stride + offset;
    for (let component = 0; component < source.itemSize; component++) output[i * source.itemSize + component] = array[from + component];
  }
  const attribute = 'isFloat16BufferAttribute' in source && source.isFloat16BufferAttribute
    ? new Float16BufferAttribute(output as Uint16Array, source.itemSize, source.normalized)
    : new BufferAttribute(output, source.itemSize, source.normalized);
  attribute.name = source.name; attribute.setUsage(interleaved ? source.data.usage : (source as BufferAttribute).usage);
  if ('gpuType' in source) attribute.gpuType = source.gpuType;
  return attribute;
}

/**
 * Losslessly copy only referenced vertices. Never clones the full height-field first,
 * mutates the source index/BVH, flattens instances, or merges different material groups.
 */
export function compactTraceGeometry(source: BufferGeometry, useGroups = source.groups.length > 0): GeometryCompaction {
  const position = source.getAttribute('position');
  if (!position || !('array' in position || 'data' in position)) throw new Error('Quality geometry requires CPU-readable positions');
  const index = source.getIndex();
  const total = index?.count ?? position.count;
  const drawStart = Math.min(total, Math.max(0, Math.floor(source.drawRange.start)));
  const drawEnd = Math.min(total, Number.isFinite(source.drawRange.count) ? drawStart + Math.max(0, Math.floor(source.drawRange.count)) : total);
  const spans = (useGroups ? source.groups : [{ start: 0, count: total, materialIndex: 0 }]).map(group => {
    const start = Math.max(drawStart, group.start);
    const end = Math.min(drawEnd, group.start + group.count);
    return { start, end: start + Math.max(0, Math.floor((end - start) / 3) * 3), materialIndex: group.materialIndex ?? 0 };
  }).filter(span => span.end > span.start);
  const runs: { start: number; end: number; output: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const previous = runs.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else runs.push({ start: span.start, end: span.end, output: 0 });
  }
  let indexCount = 0;
  for (const run of runs) { run.output = indexCount; indexCount += run.end - run.start; }
  const remap = new Map<number, number>();
  const vertices: number[] = [];
  const indices = new Uint32Array(indexCount);
  let cursor = 0;
  for (const run of runs) for (let i = run.start; i < run.end; i++) {
    const oldIndex = index ? index.getX(i) : i;
    if (!Number.isSafeInteger(oldIndex) || oldIndex < 0 || oldIndex >= position.count) throw new RangeError(`Quality geometry index ${oldIndex} is out of bounds`);
    let next = remap.get(oldIndex);
    if (next === undefined) { next = vertices.length; vertices.push(oldIndex); remap.set(oldIndex, next); }
    indices[cursor++] = next;
  }
  const sourceIndices = Uint32Array.from(vertices);
  const geometry = new BufferGeometry();
  geometry.name = `${source.name || source.type}:quality`;
  let bytes = indices.byteLength;
  try {
    for (const [name, attribute] of Object.entries(source.attributes)) {
      if (attribute.count !== position.count) throw new Error(`Quality attribute ${name} has a different vertex count`);
      const copy = copyAttribute(attribute, sourceIndices); geometry.setAttribute(name, copy); bytes += copy.array.byteLength;
    }
    for (const [name, attributes] of Object.entries(source.morphAttributes)) {
      geometry.morphAttributes[name as 'position'] = attributes.map(attribute => { const copy = copyAttribute(attribute, sourceIndices); bytes += copy.array.byteLength; return copy; });
    }
    geometry.morphTargetsRelative = source.morphTargetsRelative;
    geometry.setIndex(new BufferAttribute(indices, 1));
    if (useGroups) for (const span of spans) {
      const run = runs.find(value => span.start >= value.start && span.end <= value.end)!;
      geometry.addGroup(run.output + span.start - run.start, span.end - span.start, span.materialIndex);
    }
    geometry.setDrawRange(0, indexCount);
    return { geometry, sourceVertices: position.count, vertices: vertices.length, triangles: indexCount / 3, bytes, sourceIndices };
  } catch (error) { geometry.dispose(); throw error; }
}

function signature(geometry: BufferGeometry, groups: boolean): string {
  return [geometry.uuid, groups, geometry.drawRange.start, geometry.drawRange.count,
    geometry.index?.version, geometry.index?.count,
    ...geometry.groups.flatMap(group => [group.start, group.count, group.materialIndex]),
    ...Object.entries(geometry.attributes).flatMap(([key, attr]) => [key, attr.count, 'isInterleavedBufferAttribute' in attr ? attr.data.version : (attr as BufferAttribute).version]),
    ...Object.entries(geometry.morphAttributes).flatMap(([key, attributes]) => [key, ...attributes.flatMap(attr => ['isInterleavedBufferAttribute' in attr ? attr.data.version : (attr as BufferAttribute).version, attr.count])]),
  ].join('|');
}

function hasMorph(mesh: Mesh): boolean { return Object.values(mesh.geometry.morphAttributes).some(attributes => attributes.length > 0); }

/** Bake one actor's morphs before upstream applies its skin matrices to the vertex buffer. */
function compactMeshGeometry(mesh: Mesh, groups: boolean, groupStart?: number, groupCount?: number): GeometryCompaction {
  let source = mesh.geometry;
  if (groupStart !== undefined) {
    // A lightweight borrowed attribute/index view, never a full clone. Each
    // ordered partition keeps the original material indices and triangle order.
    const subset = new BufferGeometry(); subset.attributes = source.attributes; subset.index = source.index;
    subset.morphAttributes = source.morphAttributes; subset.morphTargetsRelative = source.morphTargetsRelative;
    subset.groups = source.groups.slice(groupStart, groupStart + groupCount!); subset.drawRange = { ...source.drawRange }; subset.name = source.name;
    source = subset;
  }
  const compact = compactTraceGeometry(source, groups);
  if (!hasMorph(mesh)) return compact;
  try {
    let bytes = compact.bytes;
    for (const name of ['position', 'normal', 'tangent', 'color'] as const) {
      const base = compact.geometry.getAttribute(name) as BufferAttribute | undefined, targets = (compact.geometry.morphAttributes as Record<string, Attribute[] | undefined>)[name];
      if (!base || !targets?.length) continue;
      const values = new Float32Array(base.count * base.itemSize);
      for (let vertex = 0; vertex < base.count; vertex++) for (let component = 0; component < base.itemSize; component++) {
        const original = base.getComponent(vertex, component); let value = original;
        for (let index = 0; index < targets.length; index++) {
          const influence = mesh.morphTargetInfluences?.[index] ?? 0;
          if (influence && component < targets[index].itemSize) value += (targets[index].getComponent(vertex, component) - (compact.geometry.morphTargetsRelative ? 0 : original)) * influence;
        }
        values[vertex * base.itemSize + component] = value;
      }
      const baked = new BufferAttribute(values, base.itemSize); baked.name = base.name; baked.setUsage(base.usage);
      compact.geometry.setAttribute(name, baked); bytes += values.byteLength - base.array.byteLength;
    }
    return { ...compact, bytes };
  } catch (error) { compact.geometry.dispose(); throw error; }
}

export interface QualitySceneChange {
  camera?: boolean;
  transforms?: boolean;
  materials?: boolean;
  lights?: boolean;
  environment?: boolean;
  /** Refit/rebuild the named objects' private geometry, including skin/morph deformation. */
  geometry?: readonly Object3D[];
  topology?: boolean;
}
export interface PreparedSceneInspection {
  meshes: number;
  instances: number;
  uniqueGeometries: number;
  sourceMeshes: number;
  sourceInstances: number;
  maxGeometryGroups: number;
  sourceVertices: number;
  compactVertices: number;
  triangles: number;
  expandedTriangles: number;
  geometryBytes: number;
  /** Conservative size of upstream's single interleaved vertex storage buffer. */
  estimatedAttributeBytes: number;
}

/** Strict admission: application-specific TSL must be converted or explicitly composited. */
export function assertTraceMaterial(material: Material, object: Object3D): void {
  const value = material as Material & { isMeshStandardMaterial?: boolean; isMeshPhysicalMaterial?: boolean; isNodeMaterial?: boolean };
  const customNodes = Object.entries(material).filter(([key, node]) => key.endsWith('Node') && node !== null && node !== undefined).map(([key]) => key);
  if (!(value.isMeshStandardMaterial || value.isMeshPhysicalMaterial) || customNodes.length) {
    const path: string[] = []; let item: Object3D | null = object;
    while (item) { path.unshift(item.name || item.type); item = item.parent; }
    throw new Error(`Quality material mapping required: ${path.join('/')} (${material.type}${customNodes.length ? `: ${customNodes.join(', ')}` : ''})`);
  }
}

/** Owns private graph/BVH/geometry; source materials and textures remain borrowed. */
export class PreparedQualityScene {
  readonly source: Scene;
  scene: Scene;
  private mapping = new Map<Object3D, Object3D>();
  private cache = new Map<string, CacheEntry>();
  private parts = new Map<Mesh, Mesh[]>();
  private disposed = false;

  constructor(source: Scene) {
    this.source = source; this.scene = new Scene();
    try { this.rebuild(); } catch (error) { this.dispose(); throw error; }
  }

  private releaseGraph(scene = this.scene): void {
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    scene.traverse(object => {
      if (object instanceof SkinnedMesh && !skeletons.has(object.skeleton)) { skeletons.add(object.skeleton); object.skeleton.dispose(); }
      if (object instanceof InstancedMesh) object.dispose();
    });
  }

  rebuild(): void {
    if (this.disposed) throw new Error('Prepared quality scene disposed');
    this.source.updateMatrixWorld(true);
    const nextScene = cloneSkeleton(this.source) as Scene;
    const nextMapping = new Map<Object3D, Object3D>();
    const nextParts = new Map<Mesh, Mesh[]>();
    const nextCache = new Map(this.cache);
    const allocated: GeometryCompaction[] = [];
    const used = new Set<string>();
    const pair = (source: Object3D, target: Object3D): void => {
      nextMapping.set(source, target);
      if (source instanceof Mesh && target instanceof Mesh) {
        for (const material of Array.isArray(source.material) ? source.material : [source.material]) assertTraceMaterial(material, source);
        if ('isBatchedMesh' in source && source.isBatchedMesh) throw new Error(`Quality BatchedMesh needs an explicit geometry adapter: ${source.name}`);
        const groups = Array.isArray(source.material), morph = hasMorph(source);
        const groupCount = groups ? source.geometry.groups.length : 0;
        // Upstream packs a per-geometry BVH root in seven bits. Partition only
        // private geometry, preserving all groups instead of dropping materials.
        const partitions = Math.max(1, Math.ceil(groupCount / 128));
        const meshes: Mesh[] = [];
        for (let part = 0; part < partitions; part++) {
          const groupStart = partitions > 1 ? part * 128 : undefined;
          const count = groupStart === undefined ? undefined : Math.min(128, groupCount - groupStart);
          const key = `${source.geometry.uuid}:${groups}${morph ? `:morph:${source.uuid}` : ''}${groupStart === undefined ? '' : `:part:${groupStart}:${count}`}`;
          const version = signature(source.geometry, groups) + (morph ? `:${source.morphTargetInfluences?.join(',')}` : '');
          let entry = nextCache.get(key);
          if (!entry || entry.signature !== version) {
            const next = { ...compactMeshGeometry(source, groups, groupStart, count), signature: version, source: source.geometry, morphOwner: morph ? source : undefined, groupStart, groupCount: count };
            allocated.push(next); nextCache.set(key, next); entry = next;
          }
          const mesh = part === 0 ? target : target.clone(false);
          if (part > 0) { mesh.name = `${source.name || source.type}:quality-part-${part}`; mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1); mesh.matrix.identity(); mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = true; mesh.visible = true; target.add(mesh); }
          mesh.geometry = entry.geometry; used.add(key); meshes.push(mesh);
          if (entry.triangles === 0) {
            // Empty active draw ranges are transform scaffolds, not renderables.
            // Upstream invents an empty BVH root even for zero indices; with an
            // array material that root has no group/material and crashes packing.
            Object.defineProperty(mesh, 'isMesh', { configurable: true, value: false });
            if (mesh instanceof SkinnedMesh) Object.defineProperty(mesh, 'isSkinnedMesh', { configurable: true, value: false });
          }
          // A pose belongs to one mesh, never to geometry.uuid shared by other actors.
          if (mesh instanceof SkinnedMesh) delete (mesh as SkinnedMesh & { boundsTree?: unknown }).boundsTree;
        }
        nextParts.set(source, meshes);
      } else if ('isLine' in source || 'isPoints' in source || 'isSprite' in source) {
        throw new Error(`Quality composition mapping required: ${source.name || source.type} (${source.type})`);
      }
      for (let i = 0; i < source.children.length; i++) pair(source.children[i], target.children[i]);
    };
    try { pair(this.source, nextScene); }
    catch (error) { this.releaseGraph(nextScene); for (const entry of allocated) entry.geometry.dispose(); throw error; }
    for (const key of nextCache.keys()) if (!used.has(key)) nextCache.delete(key);
    this.releaseGraph();
    for (const [key, entry] of this.cache) if (nextCache.get(key) !== entry) entry.geometry.dispose();
    this.scene = nextScene; this.mapping = nextMapping; this.parts = nextParts; this.cache = nextCache;
    this.syncTransforms(); this.syncEnvironment();
  }

  syncTransforms(): void {
    this.source.updateMatrixWorld(true);
    for (const [source, target] of this.mapping) {
      target.position.copy(source.position); target.quaternion.copy(source.quaternion); target.scale.copy(source.scale);
      target.matrix.copy(source.matrix); target.matrixAutoUpdate = source.matrixAutoUpdate; target.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
      if (!source.matrixWorldAutoUpdate) target.matrixWorld.copy(source.matrixWorld);
      target.visible = source.visible;
      if (source instanceof InstancedMesh && target instanceof InstancedMesh) for (const part of this.parts.get(source) ?? [target]) { if (!(part instanceof InstancedMesh)) continue;
        if (source.count > part.instanceMatrix.count) throw new Error('Instance capacity changed; publish a topology change');
        part.count = source.count; part.instanceMatrix.copy(source.instanceMatrix); part.instanceMatrix.needsUpdate = true;
        if (source.instanceColor) { if (!part.instanceColor) part.instanceColor = source.instanceColor.clone() as InstancedBufferAttribute; else part.instanceColor.copy(source.instanceColor); part.instanceColor!.needsUpdate = true; }
      }
      if (source instanceof Mesh && target instanceof Mesh) {
        for (const part of this.parts.get(source) ?? [target]) { part.material = source.material;
        if (source.morphTargetInfluences && part.morphTargetInfluences) part.morphTargetInfluences.splice(0, part.morphTargetInfluences.length, ...source.morphTargetInfluences.map(value => hasMorph(source) ? 0 : value)); }
      }
      if ('isLight' in source && source.isLight) {
        const from = source as unknown as Object3D & { color: { clone(): unknown }; intensity: number };
        Object.assign(target, { color: from.color.clone(), intensity: from.intensity });
        for (const name of ['distance', 'decay', 'angle', 'penumbra', 'width', 'height'] as const) if (name in source) (target as unknown as Record<string, unknown>)[name] = (source as unknown as Record<string, unknown>)[name];
        if ('target' in source && 'target' in target && source.target && target.target) {
          const fromTarget = source.target as Object3D, toTarget = target.target as Object3D;
          toTarget.position.copy(fromTarget.position); toTarget.quaternion.copy(fromTarget.quaternion); toTarget.scale.copy(fromTarget.scale);
          toTarget.updateMatrixWorld(true);
        }
      }
    }
    this.scene.updateMatrixWorld(true);
    this.scene.traverse(object => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
  }

  syncEnvironment(): void {
    this.scene.environment = this.source.environment; this.scene.background = this.source.background;
    this.scene.environmentIntensity = this.source.environmentIntensity; this.scene.backgroundIntensity = this.source.backgroundIntensity;
    this.scene.environmentRotation.copy(this.source.environmentRotation); this.scene.backgroundRotation.copy(this.source.backgroundRotation);
  }

  syncMaterials(): void {
    for (const [source, target] of this.mapping) if (source instanceof Mesh && target instanceof Mesh) {
      for (const material of Array.isArray(source.material) ? source.material : [source.material]) assertTraceMaterial(material, source);
      if (Array.isArray(source.material) !== Array.isArray(target.material)) throw new Error('Material group topology changed; publish a topology change');
      for (const part of this.parts.get(source) ?? [target]) part.material = source.material;
    }
  }

  /** Re-copy named source geometries only, retaining untouched private BVHs. */
  updateGeometry(objects: readonly Object3D[]): void {
    const changed = new Set<BufferGeometry>();
    for (const object of objects) object.traverse(child => { if (child instanceof Mesh) changed.add(child.geometry); });
    const replacements: { key: string; previous: CacheEntry; next: CacheEntry }[] = [];
    try {
      for (const [key, entry] of this.cache) if (changed.has(entry.source)) replacements.push({ key, previous: entry,
        next: { ...compactMeshGeometry(entry.morphOwner ?? [...this.parts.keys()].find(mesh => mesh.geometry === entry.source)!, key.includes(':true'), entry.groupStart, entry.groupCount), signature: signature(entry.source, key.includes(':true')), source: entry.source, morphOwner: entry.morphOwner, groupStart: entry.groupStart, groupCount: entry.groupCount } });
    } catch (error) { for (const item of replacements) item.next.geometry.dispose(); throw error; }
    for (const { key, previous, next } of replacements) {
      this.cache.set(key, next);
      for (const [source, parts] of this.parts) if (source.geometry === previous.source) for (const target of parts) if (target.geometry === previous.geometry) {
        target.geometry = next.geometry;
        Object.defineProperty(target, 'isMesh', { configurable: true, value: next.triangles > 0 });
        if (target instanceof SkinnedMesh) Object.defineProperty(target, 'isSkinnedMesh', { configurable: true, value: next.triangles > 0 });
        if (target instanceof SkinnedMesh) delete (target as SkinnedMesh & { boundsTree?: unknown }).boundsTree;
      }
      previous.geometry.dispose();
    }
    this.syncTransforms();
    for (const object of objects) object.traverse(source => {
      const target = this.mapping.get(source);
      if (source instanceof Mesh) for (const part of this.parts.get(source) ?? []) if (part instanceof SkinnedMesh) delete (part as SkinnedMesh & { boundsTree?: unknown }).boundsTree;
    });
  }

  inspect(): PreparedSceneInspection {
    let meshes = 0, instances = 0, triangles = 0, expandedTriangles = 0, sourceVertices = 0, compactVertices = 0, geometryBytes = 0, extraUV = 0;
    const countedSources = new Set<string>();
    for (const entry of this.cache.values()) {
      const identity = `${entry.source.uuid}:${entry.morphOwner?.uuid ?? ''}`;
      if (!countedSources.has(identity)) { countedSources.add(identity); sourceVertices += entry.sourceVertices; }
      compactVertices += entry.vertices; geometryBytes += entry.bytes; triangles += entry.triangles;
      extraUV = Math.max(extraUV, Object.keys(entry.geometry.attributes).filter(key => /^uv[1-7]$/.test(key)).length);
    }
    this.scene.traverse(object => { if (object instanceof Mesh) { meshes++; const count = object instanceof InstancedMesh ? object.count : 1; instances += count; expandedTriangles += (object.geometry.index?.count ?? 0) / 3 * count; } });
    // Each skinned pose has a distinct BVH, plus a static BVH if that geometry is
    // also used by an ordinary mesh. Do not dedupe different actors by geometry.uuid.
    const packed = new Map<BufferGeometry, { static: boolean; skins: number }>();
    this.scene.traverse(object => { if (object instanceof Mesh) {
      const counts = packed.get(object.geometry) ?? { static: false, skins: 0 };
      if (object instanceof SkinnedMesh) counts.skins++; else counts.static = true;
      packed.set(object.geometry, counts);
    } });
    let packedVertices = 0; for (const [geometry, count] of packed) packedVertices += geometry.getAttribute('position').count * (Number(count.static) + count.skins);
    const sourceMeshes = this.parts.size, sourceInstances = [...this.parts.keys()].reduce((sum, mesh) => sum + (mesh instanceof InstancedMesh ? mesh.count : 1), 0);
    const maxGeometryGroups = Math.max(0, ...[...this.cache.values()].map(entry => entry.geometry.groups.length));
    return { meshes, instances, sourceMeshes, sourceInstances, maxGeometryGroups, uniqueGeometries: this.cache.size, sourceVertices, compactVertices, triangles, expandedTriangles, geometryBytes,
      estimatedAttributeBytes: packedVertices * (5 + extraUV) * 16 };
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.releaseGraph(); this.mapping.clear(); this.parts.clear();
    for (const entry of this.cache.values()) entry.geometry.dispose(); this.cache.clear();
  }
}
