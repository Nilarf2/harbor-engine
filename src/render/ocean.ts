import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { color, cos, mix, positionLocal, sin, smoothstep, transformNormalToView, uniform, vec3 } from 'three/tsl';

export interface OceanOptions { size?: number; level?: number }
export interface Ocean {
  object: Mesh<PlaneGeometry, MeshStandardNodeMaterial>;
  /** Simulation seconds; driven explicitly by the caller, with no hidden clock. */
  update(time: number): void;
  dispose(): void;
}

/** Small analytic TSL ocean; no GPU compute or external textures are required. */
export function createOcean({ size = 260, level = -0.65 }: OceanOptions = {}): Ocean {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(level)) {
    throw new RangeError('Ocean size must be positive and level must be finite.');
  }
  const geometry = new PlaneGeometry(size, size, 112, 112);
  geometry.rotateX(-Math.PI / 2);
  // Vertex displacement is bounded by 0.37 m, so the CPU bounds remain conservative.
  geometry.computeBoundingBox();
  geometry.boundingBox!.min.y = -0.5;
  geometry.boundingBox!.max.y = 0.5;
  geometry.computeBoundingSphere();
  geometry.boundingSphere!.radius += 0.5;
  const material = new MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.22 });
  const clock = uniform(0);
  const x = positionLocal.x;
  const z = positionLocal.z;
  const a = x.mul(0.22).add(z.mul(0.13)).add(clock.mul(0.85));
  const b = x.mul(-0.15).add(z.mul(0.32)).add(clock.mul(1.15));
  const c = x.mul(0.64).add(z.mul(0.48)).sub(clock.mul(1.75));
  const height = sin(a).mul(0.22).add(sin(b).mul(0.11)).add(sin(c).mul(0.04));
  material.positionNode = vec3(x, positionLocal.y.add(height), z);
  // normalNode expects view-space; the helper also handles non-uniform object scale.
  const dx = cos(a).mul(0.0484).add(cos(b).mul(-0.0165)).add(cos(c).mul(0.0256));
  const dz = cos(a).mul(0.0286).add(cos(b).mul(0.0352)).add(cos(c).mul(0.0192));
  const localNormal = vec3(dx.negate(), 1, dz.negate()).normalize();
  material.normalNode = transformNormalToView(localNormal);
  const ripple = sin(x.mul(1.7).add(clock.mul(0.5)))
    .mul(sin(z.mul(1.9).sub(clock.mul(0.7)))).mul(0.5).add(0.5);
  const tint = smoothstep(-0.24, 0.3, height);
  const base = mix(color('#07586a'), color('#34aeb4'), tint);
  material.colorNode = base.add(color('#9bdacf').mul(smoothstep(0.86, 0.98, ripple)).mul(0.18));
  material.roughnessNode = ripple.mul(0.12).add(0.2);
  const object = new Mesh(geometry, material);
  object.name = 'harbor:ocean';
  object.position.y = level;
  object.receiveShadow = true;
  let disposed = false;
  return {
    object,
    update(time) { if (!disposed && Number.isFinite(time)) clock.value = time; },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
