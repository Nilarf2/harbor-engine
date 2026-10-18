import type { SceneDefinition } from '../src/core/index.js';

/** Original geometry-only light study: colored bounce, glossy reflection, glass. */
export const lightStudy: SceneDefinition = {
  version: 1, name: 'Harbor Light Study', seed: 42,
  entities: [
    { id: 'floor', position: [0, -0.15, 0], visual: { shape: 'box', size: [10, 0.3, 9], color: '#d6d1bd', roughness: 0.4 } },
    { id: 'back', position: [0, 2.3, -3], visual: { shape: 'box', size: [10, 5, 0.2], color: '#e3ded0', roughness: 0.8 } },
    { id: 'red-wall', position: [-4, 1.8, -0.8], visual: { shape: 'box', size: [0.2, 4, 4.5], color: '#bd4b38', roughness: 0.85 } },
    { id: 'blue-wall', position: [4, 1.8, -0.8], visual: { shape: 'box', size: [0.2, 4, 4.5], color: '#417d8a', roughness: 0.85 } },
    { id: 'plinth', position: [-1.65, 0.3, -0.5], visual: { shape: 'box', size: [2.6, 0.6, 2.6], color: '#c0c0b8', roughness: 0.28 } },
    { id: 'chrome', position: [-1.65, 1.6, -0.5], visual: { shape: 'sphere', size: [2, 2, 2], color: '#e9ebee', roughness: 0.04, metalness: 1 } },
    { id: 'glass', position: [1.35, 1.25, 0.2], visual: { shape: 'sphere', size: [2.5, 2.5, 2.5], color: '#f3faf5', roughness: 0.02, transmission: 1, ior: 1.5 } },
    { id: 'gold', position: [1.6, 0.6, -1.75], visual: { shape: 'sphere', size: [1.2, 1.2, 1.2], color: '#e5b56a', roughness: 0.18, metalness: 1 } },
    { id: 'pedestal', position: [0, 0.45, 2], visual: { shape: 'box', size: [0.7, 0.9, 0.7], color: '#658c80', roughness: 0.65 } },
    { id: 'light', position: [0, 3.8, -1.1], visual: { shape: 'box', size: [2.5, 0.06, 1.1], color: '#fff3d7', emissive: '#ffeac6', emissiveIntensity: 4 } },
  ],
};
