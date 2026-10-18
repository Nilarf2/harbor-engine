import {
  BoxGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry,
  Matrix3, Matrix4, Quaternion, SphereGeometry, Vector3, type BufferGeometry,
} from 'three';
import type { World } from '../core/index.js';
import type { TraceMaterial, TraceScene, TraceTriangle, TraceVec3 } from './types.js';

/**
 * Snapshot declarative world visuals as real triangles and linear PBR constants.
 * TSL ocean/sky, external Three objects, textures, skinning and custom shaders are not extracted.
 */
export interface WorldTraceOptions { segments?: number }

export function fromWorld(world: World, { segments = 24 }: WorldTraceOptions = {}): TraceScene {
  if (!Number.isInteger(segments) || segments < 8 || segments > 256) throw new RangeError('segments must be an integer in [8, 256].');
  const triangles: TraceTriangle[] = [], materials: TraceMaterial[] = [];
  const materialIndices = new Map<string, number>();
  const matrix = new Matrix4(), normalMatrix = new Matrix3();
  const p = new Vector3(), n = new Vector3(), q = new Quaternion(), s = new Vector3();
  for (const entity of world.entities.values()) {
    const visual = entity.visual;
    if (!visual) continue;
    const key = JSON.stringify([visual.color, visual.emissive, visual.emissiveIntensity, visual.metalness, visual.roughness, visual.transmission, visual.ior]);
    let material = materialIndices.get(key);
    if (material === undefined) {
      const color = new Color(visual.color ?? '#e7edf0');
      const emission = new Color(visual.emissive ?? '#000000').multiplyScalar(visual.emissiveIntensity ?? 0);
      material = materials.length;
      materials.push({
        color: color.toArray() as TraceVec3, emission: emission.toArray() as TraceVec3,
        metalness: visual.metalness ?? 0, roughness: visual.roughness ?? 0.75,
        transmission: visual.transmission ?? 0, ior: visual.ior ?? 1.5,
      });
      materialIndices.set(key, material);
    }
    const [x, y, z] = visual.size;
    let geometry: BufferGeometry;
    switch (visual.shape) {
      case 'box': geometry = new BoxGeometry(x, y, z); break;
      case 'sphere': geometry = new SphereGeometry(x / 2, segments, Math.max(6, Math.floor(segments * 2 / 3))); break;
      case 'capsule': geometry = new CapsuleGeometry(x / 2, Math.max(0, y - x), Math.max(4, Math.floor(segments / 4)), segments); break;
      case 'cylinder': geometry = new CylinderGeometry(x / 2, x / 2, y, segments); geometry.scale(1, 1, z / x); break;
      case 'cone': geometry = new ConeGeometry(x / 2, y, segments); geometry.scale(1, 1, z / x); break;
    }
    matrix.compose(p.fromArray(entity.position), q.fromArray(entity.rotation), s.fromArray(entity.scale));
    normalMatrix.getNormalMatrix(matrix);
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const count = index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      const vertices: TraceVec3[] = [], normals: TraceVec3[] = [];
      for (let j = 0; j < 3; j++) {
        const k = index ? index.getX(i + j) : i + j;
        vertices.push(p.fromBufferAttribute(position, k).applyMatrix4(matrix).toArray() as TraceVec3);
        normals.push(n.fromBufferAttribute(normal, k).applyMatrix3(normalMatrix).normalize().toArray() as TraceVec3);
      }
      triangles.push({ a: vertices[0], b: vertices[1], c: vertices[2], normalA: normals[0], normalB: normals[1], normalC: normals[2], material });
    }
    geometry.dispose();
  }
  if (!materials.length) materials.push({ color: [0.8, 0.8, 0.8] });
  return { triangles, materials };
}
