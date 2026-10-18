import {
  BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry,
  MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, SphereGeometry,
  type BufferGeometry,
} from 'three/webgpu';
import type { Visual } from '../core/types.js';

/** Renderer-owned caches. Materials and geometries are shared, never entity-owned. */
export class VisualResources {
  readonly geometries = new Map<string, BufferGeometry>();
  readonly materials = new Map<string, MeshStandardNodeMaterial>();
  private usedGeometry = new Set<string>();
  private usedMaterial = new Set<string>();

  begin(): void {
    this.usedGeometry.clear();
    this.usedMaterial.clear();
  }

  acquire(visual: Visual): {
    geometry: BufferGeometry;
    material: MeshStandardNodeMaterial;
    key: string;
  } {
    const geometryKey = `${visual.shape}:${visual.size.join(',')}`;
    const materialKey = JSON.stringify([
      visual.color ?? '#e7edf0', visual.roughness ?? 0.75,
      visual.metalness ?? 0, visual.emissive ?? '#000000', visual.emissiveIntensity ?? 0,
      visual.transmission ?? 0, visual.ior ?? 1.5,
    ]);
    this.usedGeometry.add(geometryKey);
    this.usedMaterial.add(materialKey);
    let geometry = this.geometries.get(geometryKey);
    if (!geometry) {
      const [x, y, z] = visual.size;
      switch (visual.shape) {
        case 'box': geometry = new BoxGeometry(x, y, z); break;
        case 'sphere': geometry = new SphereGeometry(x / 2, 20, 12); break;
        case 'capsule': geometry = new CapsuleGeometry(x / 2, Math.max(0, y - x), 4, 12); break;
        case 'cylinder': geometry = new CylinderGeometry(x / 2, x / 2, y, 12); geometry.scale(1, 1, z / x); break;
        case 'cone': geometry = new ConeGeometry(x / 2, y, 12); geometry.scale(1, 1, z / x); break;
      }
      geometry.name = geometryKey;
      this.geometries.set(geometryKey, geometry);
    }
    let material = this.materials.get(materialKey);
    if (!material) {
      const parameters = {
        color: visual.color ?? '#e7edf0', roughness: visual.roughness ?? 0.75,
        metalness: visual.metalness ?? 0, emissive: visual.emissive ?? '#000000',
        emissiveIntensity: visual.emissiveIntensity ?? 0,
      };
      material = visual.transmission
        ? new MeshPhysicalNodeMaterial({ ...parameters, transmission: visual.transmission, ior: visual.ior ?? 1.5, thickness: visual.size[2] })
        : new MeshStandardNodeMaterial(parameters);
      material.name = materialKey;
      this.materials.set(materialKey, material);
    }
    return { geometry, material, key: `${geometryKey}/${materialKey}` };
  }

  /** Retain resources still used after a world rebuild; release the rest immediately. */
  sweep(): void {
    for (const [key, geometry] of this.geometries) {
      if (!this.usedGeometry.has(key)) { geometry.dispose(); this.geometries.delete(key); }
    }
    for (const [key, material] of this.materials) {
      if (!this.usedMaterial.has(key)) { material.dispose(); this.materials.delete(key); }
    }
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.usedGeometry.clear();
    this.usedMaterial.clear();
  }
}
