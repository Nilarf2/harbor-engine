import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AssetManager } from './AssetManager.js';
import { disposeObject } from './disposeObject.js';
export { AssetManager } from './AssetManager.js';
export type { AssetHandle, AssetLoader } from './AssetManager.js';
export { Actor } from './Actor.js';
export { disposeObject } from './disposeObject.js';

/** Self-contained GLB avoids uncancellable external dependencies and CDN requests. */
export function assertEmbeddedGLB(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== view.byteLength) {
    throw new Error('Expected a self-contained glTF 2 binary (.glb)');
  }
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB is missing its JSON chunk');
  const length = view.getUint32(12, true);
  if (20 + length > view.byteLength) throw new Error('Truncated GLB JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri && !String(item.uri).startsWith('data:')) throw new Error('Pack external buffers/textures into the GLB before importing');
  }
}

export function createAssetManager(): AssetManager {
  const manager = new AssetManager();
  manager.register('json', {
    async load(url, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Asset HTTP ${response.status}: ${url}`);
      return response.json();
    }, dispose() {},
  });
  manager.register<GLTF>('gltf', {
    async load(url, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Asset HTTP ${response.status}: ${url}`);
      const buffer = await response.arrayBuffer();
      signal.throwIfAborted();
      assertEmbeddedGLB(buffer);
      return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
    },
    dispose(gltf) { disposeObject(new Set(gltf.scenes)); },
  });
  return manager;
}
