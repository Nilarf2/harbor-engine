// Adapted from Nilarf2/dragon-raja-grand-escape (MIT), © 2026 Nilarf2.
import type { Object3D, Material, Texture, BufferGeometry, SkinnedMesh, Skeleton } from 'three/webgpu';

/** Use for an owned asset template; cloned instances share its geometry/materials. */
export function disposeObject(root: Object3D | Iterable<Object3D>) {
  const roots = 'traverse' in root ? [root] : root;
  const objects = new Set<Object3D>(), skeletons = new Set<Skeleton>();
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>();
  for (const scene of roots) scene.traverse(object => {
    objects.add(object);
    const mesh = object as SkinnedMesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  }
  const images = new Set<{ close(): void }>();
  for (const texture of textures) {
    const image = texture.source?.data as { close?: () => void } | undefined;
    if (typeof image?.close === 'function') images.add(image as { close(): void });
  }
  const errors: unknown[] = [];
  const cleanup = (run: () => void) => { try { run(); } catch (error) { errors.push(error); } };
  // Collect first: user disposal listeners may mutate the scene hierarchy.
  for (const object of objects) cleanup(() => object.dispose());
  for (const skeleton of skeletons) cleanup(() => skeleton.dispose());
  for (const material of materials) cleanup(() => material.dispose());
  for (const geometry of geometries) cleanup(() => geometry.dispose());
  for (const texture of textures) cleanup(() => texture.dispose());
  for (const image of images) cleanup(() => image.close());
  if (errors.length) throw new AggregateError(errors, 'Object resource cleanup failed');
}
