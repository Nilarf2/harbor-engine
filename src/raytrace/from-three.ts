import {
  BackSide, Material, Matrix3, Matrix4, Vector3,
  type BufferAttribute, type BufferGeometry, type Color, type InstancedMesh,
  type InterleavedBufferAttribute, type Mesh, type Object3D,
} from 'three';
import type { TraceMaterial, TraceScene, TraceTriangle, TraceVec3 } from './types.js';

export interface FromThreeOptions {
  /** Explicitly permit approximations/skipped unsupported objects instead of throwing. */
  allowUnsupported?: boolean;
  /** Receives every distinct permitted approximation; defaults to console.warn. */
  onWarning?: (message: string) => void;
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;
type PBRMaterial = Material & {
  isMeshStandardMaterial?: boolean;
  isMeshPhysicalMaterial?: boolean;
  isNodeMaterial?: boolean;
  color?: Color;
  emissive?: Color;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  ior?: number;
  clearcoat?: number;
  sheen?: number;
  iridescence?: number;
  anisotropy?: number;
  thickness?: number;
  attenuationDistance?: number;
  specularIntensity?: number;
  specularColor?: Color;
  dispersion?: number;
  flatShading?: boolean;
  wireframe?: boolean;
};

const vector = (value: Vector3): TraceVec3 => [value.x, value.y, value.z];

function finiteVector(value: Vector3, label: string, limit = 1e6): void {
  if (![value.x, value.y, value.z].every(n => Number.isFinite(n) && Math.abs(n) <= limit)) {
    throw new RangeError(`${label} must be finite and within ±${limit}.`);
  }
}

function finiteScalar(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} must be in [${min}, ${max}].`);
  return value;
}

function validRange(start: number, count: number, label: string): void {
  if (!Number.isSafeInteger(start) || start < 0 || (count !== Infinity && (!Number.isSafeInteger(count) || count < 0))) {
    throw new RangeError(`${label} must contain a nonnegative integer start and count.`);
  }
}

/**
 * Snapshot visible Three meshes into detached world-space triangles and linear PBR constants.
 * No DOM/GPU is needed. Cameras, lights, fog and environment are configured separately.
 *
 * Supports indexed/interleaved geometry, material groups, draw ranges, ordinary meshes,
 * instances and instance colors. Negative scales preserve outward winding. Static GLTF
 * meshes can be passed directly. Live skinning/morphs must first be baked to plain meshes.
 * Texture maps, custom shader nodes and unsupported physical lobes fail explicitly.
 * With allowUnsupported, such materials use their constant PBR factors; animated geometry
 * and unsupported renderable object kinds are skipped with warnings. Input assets are never
 * disposed or rewritten. Call again after changing transforms/instances/materials.
 */
export function fromThreeScene(root: Object3D, options: FromThreeOptions = {}): TraceScene {
  if (!root?.isObject3D) throw new TypeError('fromThreeScene requires a Three Object3D.');
  const triangles: TraceTriangle[] = [];
  const materials: TraceMaterial[] = [];
  const materialIndices = new Map<Material, Map<string, number>>();
  const validatedMaterials = new Set<Material>();
  const warnings = new Set<string>();

  function unsupported(message: string): void {
    const text = `fromThreeScene: ${message}`;
    if (!options.allowUnsupported) throw new Error(text);
    if (!warnings.has(text)) {
      warnings.add(text);
      (options.onWarning ?? console.warn)(text);
    }
  }

  function checkMaterial(material: PBRMaterial): void {
    if (validatedMaterials.has(material)) return;
    const label = `material "${material.name || material.type}"`;
    if (!material.isMeshStandardMaterial) unsupported(`${label} is not a standard PBR material; using constant PBR approximations.`);
    if (material.onBeforeCompile !== Material.prototype.onBeforeCompile) unsupported(`${label} uses onBeforeCompile; custom shader code is not supported.`);
    const customNodes = Object.entries(material).filter(([key, value]) => key.endsWith('Node') && value != null).map(([key]) => key);
    if (material.isNodeMaterial && customNodes.length) unsupported(`${label} uses custom shader nodes (${customNodes.join(', ')}); their output is not extracted.`);
    const textureSlots = Object.entries(material).filter(([, value]) => value?.isTexture === true).map(([key]) => key);
    if (textureSlots.length) unsupported(`${label} uses textures (${textureSlots.join(', ')}); only constant material factors can be extracted.`);
    if (material.vertexColors) unsupported(`${label} uses vertex colors; per-vertex color interpolation is not supported.`);
    if (material.opacity !== 1 || material.alphaTest > 0 || material.alphaHash) unsupported(`${label} uses opacity/alpha masking; only opaque surfaces and physical transmission are supported.`);
    if (material.wireframe) unsupported(`${label} uses wireframe; extracting its filled triangle surfaces.`);
    if (material.side === BackSide) unsupported(`${label} uses BackSide culling; the path tracer traces both sides of every triangle.`);
    if (material.clippingPlanes?.length) unsupported(`${label} uses clipping planes; geometry clipping is not baked.`);
    for (const property of ['clearcoat', 'sheen', 'iridescence', 'anisotropy', 'dispersion'] as const) {
      if ((material[property] ?? 0) !== 0) unsupported(`${label} uses ${property}; that physical material lobe is not supported.`);
    }
    if (material.specularIntensity !== undefined && material.specularIntensity !== 1) unsupported(`${label} changes specularIntensity; the tracer uses its IOR/default dielectric response.`);
    if (material.specularColor && [material.specularColor.r, material.specularColor.g, material.specularColor.b].some(n => n !== 1)) {
      unsupported(`${label} uses tinted specularColor; that dielectric tint is not supported.`);
    }
    if ((material.transmission ?? 0) > 0) {
      if ((material.roughness ?? 1) > 0) unsupported(`${label} uses rough transmission; the current tracer supports polished refraction only.`);
      if (material.attenuationDistance !== undefined && material.attenuationDistance !== Infinity) {
        unsupported(`${label} uses volume attenuation; absorption is not supported.`);
      }
    }
    validatedMaterials.add(material);
  }

  function materialIndex(material: PBRMaterial, tint: TraceVec3): number {
    checkMaterial(material);
    let variants = materialIndices.get(material);
    if (!variants) materialIndices.set(material, variants = new Map());
    const key = tint.join(',');
    const existing = variants.get(key);
    if (existing !== undefined) return existing;
    const color: TraceVec3 = material.color ? [material.color.r, material.color.g, material.color.b] : [1, 1, 1];
    const emission: TraceVec3 = material.emissive ? [material.emissive.r, material.emissive.g, material.emissive.b] : [0, 0, 0];
    const intensity = finiteScalar(material.emissiveIntensity ?? 1, 'emissiveIntensity', 0, 1e6);
    for (let i = 0; i < 3; i++) {
      color[i] = finiteScalar(color[i] * tint[i], 'linear material color', 0, 1);
      emission[i] = finiteScalar(emission[i] * intensity, 'linear material emission', 0, 1e6);
    }
    const result: TraceMaterial = {
      color, emission,
      metalness: finiteScalar(material.metalness ?? 0, 'metalness', 0, 1),
      roughness: finiteScalar(material.roughness ?? 0.7, 'roughness', 0, 1),
      transmission: finiteScalar(material.transmission ?? 0, 'transmission', 0, 1),
      ior: finiteScalar(material.ior ?? 1.5, 'ior', 1, 3),
    };
    const index = materials.length;
    materials.push(result);
    variants.set(key, index);
    return index;
  }

  const instanceMatrix = new Matrix4(), transform = new Matrix4(), normalMatrix = new Matrix3();
  const positions = [new Vector3(), new Vector3(), new Vector3()];
  const normals = [new Vector3(), new Vector3(), new Vector3()];
  const geometric = new Vector3(), edge = new Vector3();

  function append(mesh: Mesh, geometry: BufferGeometry, position: Attribute, normal: Attribute | undefined,
    matrix: Matrix4, tint: TraceVec3, label: string): void {
    const determinant = matrix.determinant();
    if (matrix.elements.some(n => !Number.isFinite(n)) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError(`${label} has a non-finite or singular world transform.`);
    }
    normalMatrix.getNormalMatrix(matrix);
    const index = geometry.getIndex();
    const count = index?.count ?? position.count;
    validRange(geometry.drawRange.start, geometry.drawRange.count, `${label} drawRange`);
    const ranges = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const range of ranges) {
      validRange(range.start, range.count, `${label} geometry group`);
      const start = Math.max(range.start, geometry.drawRange.start);
      const end = Math.min(range.start + range.count, geometry.drawRange.start + geometry.drawRange.count, count);
      if (end - start < 3) continue;
      const slot = range.materialIndex ?? 0;
      if (!Number.isSafeInteger(slot) || slot < 0) throw new RangeError(`${label} has an invalid group material index.`);
      const material = (Array.isArray(mesh.material) ? mesh.material[slot] : mesh.material) as PBRMaterial | undefined;
      if (!material?.isMaterial) throw new Error(`${label} references a missing material at group index ${slot}.`);
      if (!material.visible) continue;
      const materialId = materialIndex(material, tint);
      for (let i = start; i + 2 < end; i += 3) {
        // Mirrored transforms reverse mesh orientation. Swap winding rather than flipping
        // inverse-transpose normals; refraction needs the original outward orientation.
        const order = determinant < 0 ? [0, 2, 1] : [0, 1, 2];
        for (let j = 0; j < 3; j++) {
          const vertex = index ? index.getX(i + order[j]) : i + order[j];
          if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= position.count) throw new RangeError(`${label} has an out-of-range vertex index.`);
          positions[j].fromBufferAttribute(position, vertex).applyMatrix4(matrix);
          finiteVector(positions[j], `${label} vertex`);
          if (normal && !material.flatShading) {
            normals[j].fromBufferAttribute(normal, vertex).applyMatrix3(normalMatrix);
            finiteVector(normals[j], `${label} normal`, Number.MAX_VALUE);
          }
        }
        geometric.subVectors(positions[1], positions[0]).cross(edge.subVectors(positions[2], positions[0]));
        if (geometric.lengthSq() === 0) continue; // Zero-area triangles have no visible surface.
        geometric.normalize();
        const triangle: TraceTriangle = {
          a: vector(positions[0]), b: vector(positions[1]), c: vector(positions[2]), material: materialId,
        };
        const resultNormals = normals.map(n => {
          const length = Math.hypot(n.x, n.y, n.z);
          return !normal || material.flatShading || length === 0 ? vector(geometric) : [n.x / length, n.y / length, n.z / length] as TraceVec3;
        });
        [triangle.normalA, triangle.normalB, triangle.normalC] = resultNormals;
        if (triangles.length >= 250_000) throw new RangeError('fromThreeScene supports at most 250000 visible triangles; simplify or partition this asset.');
        triangles.push(triangle);
      }
    }
  }

  root.updateWorldMatrix(true, true);
  let parent = root.parent;
  while (parent) {
    if (!parent.visible) return { triangles, materials: [{ color: [0.8, 0.8, 0.8] }] };
    parent = parent.parent;
  }
  root.traverseVisible(object => {
    const mesh = object as Mesh;
    const flags = object as Object3D & { isSkinnedMesh?: boolean; isBatchedMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
    const label = `object "${object.name || object.type}"`;
    if (!mesh.isMesh) {
      if (flags.isLine || flags.isPoints || flags.isSprite) unsupported(`${label} is not a triangle mesh and will be skipped.`);
      return;
    }
    if (flags.isSkinnedMesh || flags.isBatchedMesh) {
      unsupported(`${label} uses ${flags.isSkinnedMesh ? 'skinning' : 'BatchedMesh'}; bake a plain static Mesh first. Skipping this object.`);
      return;
    }
    const geometry = mesh.geometry;
    if (!geometry?.isBufferGeometry) throw new TypeError(`${label} requires BufferGeometry.`);
    if (Object.values(geometry.morphAttributes).some(attributes => attributes?.length)) {
      unsupported(`${label} has morph targets; bake its current pose to a plain static Mesh first. Skipping this object.`);
      return;
    }
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    if (!position || position.itemSize !== 3 || !Number.isSafeInteger(position.count)) throw new TypeError(`${label} requires a three-component position attribute.`);
    if (normal && (normal.itemSize !== 3 || normal.count !== position.count)) throw new TypeError(`${label} normal attributes must match its positions.`);
    const instance = mesh as InstancedMesh;
    if (instance.isInstancedMesh) {
      if (instance.morphTexture) {
        unsupported(`${label} has per-instance morph targets; bake its poses first. Skipping this object.`);
        return;
      }
      if (!Number.isSafeInteger(instance.count) || instance.count < 0 || instance.count > instance.instanceMatrix.count) throw new RangeError(`${label} has an invalid instance count.`);
      if (instance.instanceColor && instance.instanceColor.count < instance.count) throw new RangeError(`${label} is missing instance colors.`);
      for (let i = 0; i < instance.count; i++) {
        instance.getMatrixAt(i, instanceMatrix);
        transform.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        const tint: TraceVec3 = instance.instanceColor ? [instance.instanceColor.getX(i), instance.instanceColor.getY(i), instance.instanceColor.getZ(i)] : [1, 1, 1];
        append(mesh, geometry, position, normal, transform, tint, `${label} instance ${i}`);
      }
    } else append(mesh, geometry, position, normal, mesh.matrixWorld, [1, 1, 1], label);
  });
  if (!materials.length) materials.push({ color: [0.8, 0.8, 0.8] });
  return { triangles, materials };
}
