import {
  ACESFilmicToneMapping, BackSide, Color, DataTexture, DirectionalLight,
  EquirectangularReflectionMapping, FogExp2, Group, HemisphereLight,
  InstancedMesh, Mesh, MeshBasicNodeMaterial, Object3D, PerspectiveCamera,
  RenderPipeline, Scene, SphereGeometry, SRGBColorSpace, WebGPURenderer,
  type BufferGeometry, type MeshStandardNodeMaterial,
} from 'three/webgpu';
import { color, mix, pass, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Scope, type World } from '../core/index.js';
import type { Entity } from '../core/types.js';
import { VisualResources } from './resources.js';

export { createOcean } from './ocean.js';
export type { Ocean, OceanOptions } from './ocean.js';

export type Quality = 'low' | 'medium' | 'high';
export interface BrowserRendererOptions {
  canvas: HTMLCanvasElement;
  world: World;
  backend?: 'auto' | 'webgl';
  quality?: Quality;
  /** Width of one static batch cell in world units; smaller cells improve culling. */
  batchCellSize?: number;
  /** Defaults are renderer-owned; callers may replace scene background/environment. */
  sky?: boolean;
  fog?: boolean;
  bloom?: boolean;
}
export interface RenderStats {
  backend: 'webgpu' | 'webgl2';
  quality: Quality;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  instances: number;
  batches: number;
  objects: number;
  cachedGeometries: number;
  cachedMaterials: number;
  pixelRatio: number;
  bloom: boolean;
}
export interface BrowserRenderer {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Paint once. Simulation advancement remains the application's responsibility. */
  render(dt?: number): void;
  resize(width: number, height: number): void;
  setQuality(quality: Quality): void;
  /** Rebuild shared visuals after editing shape/material/static transforms in place. */
  invalidateScene(): void;
  inspect(): RenderStats;
  /** Static batched entities return their shared InstancedMesh. */
  getObject(id: string): Object3D | undefined;
  /** Resolve an ordinary object, or an InstancedMesh raycast's instanceId. */
  getEntityId(object: Object3D, instanceId?: number): string | undefined;
  dispose(): void;
}

interface Batch {
  entities: Entity[];
  geometry: BufferGeometry;
  material: MeshStandardNodeMaterial;
  castsShadow: boolean;
}

function copyTransform(object: Object3D, entity: Entity): void {
  object.position.fromArray(entity.position);
  object.quaternion.fromArray(entity.rotation);
  object.scale.fromArray(entity.scale);
}

/** Low-cost, self-contained environment: no network fetch or HDR asset dependency. */
function createEnvironment(): DataTexture {
  const width = 64, height = 32;
  const pixels = new Uint8Array(width * height * 4);
  const top = [90, 166, 210], horizon = [197, 228, 225], ground = [62, 88, 83];
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const upper = t < 0.5;
    const a = upper ? top : horizon, b = upper ? horizon : ground;
    const f = upper ? t * 2 : (t - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(a[c] * (1 - f) + b[c] * f);
      pixels[i + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, width, height);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  texture.name = 'harbor:procedural-environment';
  return texture;
}

/**
 * The only engine module that requires a browser/GPU context.
 * Three's WebGPURenderer selects WebGPU, with the same TSL graph on WebGL2 fallback.
 */
export async function createBrowserRenderer(options: BrowserRendererOptions): Promise<BrowserRenderer> {
  const { canvas, world } = options;
  const cellSize = options.batchCellSize ?? 24;
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('batchCellSize must be positive.');
  if (options.quality !== undefined && !['low', 'medium', 'high'].includes(options.quality)) throw new TypeError(`Unknown quality: ${options.quality}`);
  if (options.backend !== undefined && !['auto', 'webgl'].includes(options.backend)) throw new TypeError(`Unknown backend: ${options.backend}`);
  for (const key of ['sky', 'fog', 'bloom'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
  }
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: options.backend === 'webgl' });
  const scope = new Scope();
  let disposed = false, rendererDisposal: Promise<void> | undefined;
  const disposeRenderer = () => rendererDisposal ??= renderer.dispose();
  scope.add(() => { void disposeRenderer().catch(error => console.error('[Harbor] Renderer cleanup failed', error)); });
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scope.dispose();
  }
  try {
    await renderer.init();
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = SRGBColorSpace;
    // We manage the loop and explicitly reset once, including all post-processing passes.
    renderer.info.autoReset = false;
    const scene = new Scene();
    scene.background = new Color('#a8d9e4');
    if (options.fog !== false) scene.fog = new FogExp2('#a8d9e4', 0.006);
    const camera = new PerspectiveCamera(52, 1, 0.1, 1400);
    camera.position.set(30, 24, 38);
    camera.lookAt(0, 2, 0);
    const owned = new Group();
    owned.name = 'harbor:renderer-owned';
    scene.add(owned);
    scope.add(() => { owned.removeFromParent(); owned.clear(); });
    const worldRoot = new Group();
    worldRoot.name = 'harbor:world';
    owned.add(worldRoot);
    scope.add(() => worldRoot.clear());
    const skyGeometry = new SphereGeometry(850, 24, 16);
    scope.add(() => skyGeometry.dispose());
    const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
    scope.add(() => skyMaterial.dispose());
    const direction = positionLocal.normalize();
    const skyGradient = smoothstep(-0.08, 0.8, direction.y);
    const sunDisc = direction.dot(vec3(0.42, 0.64, 0.48).normalize()).max(0).pow(450);
    skyMaterial.colorNode = mix(color('#d4e9df'), color('#4c9bce'), skyGradient)
      .add(color('#fff1c0').mul(sunDisc).mul(3));
    const sky = new Mesh(skyGeometry, skyMaterial);
    sky.name = 'harbor:sky';
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    if (options.sky !== false) owned.add(sky);
    const environment = createEnvironment();
    scene.environment = environment;
    scope.add(() => { if (scene.environment === environment) scene.environment = null; environment.dispose(); });
    scene.environmentIntensity = 0.55;
    const hemisphere = new HemisphereLight('#c9e9ff', '#588a72', 1.65);
    hemisphere.name = 'harbor:hemisphere';
    const sun = new DirectionalLight('#fff0cf', 3.2);
    scope.add(() => sun.shadow.dispose());
    sun.name = 'harbor:sun';
    sun.position.set(38, 64, 28);
    sun.shadow.camera.left = -48;
    sun.shadow.camera.right = 48;
    sun.shadow.camera.top = 48;
    sun.shadow.camera.bottom = -48;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 170;
    sun.shadow.normalBias = 0.035;
    sun.shadow.bias = -0.00015;
    owned.add(hemisphere, sun, sun.target);

    const resources = new VisualResources();
    scope.add(() => resources.dispose());
    const objects = new Map<string, Object3D>();
    const dynamicObjects = new Map<string, Mesh>();
    const instancedMeshes = new Set<InstancedMesh>();
    const scratch = new Object3D();
    let dirty = true;
    let instanceCount = 0;
    let quality: Quality = options.quality ?? 'medium';
    let pipeline: RenderPipeline | undefined;
    let scenePass: ReturnType<typeof pass> | undefined;
    let bloomPass: ReturnType<typeof bloom> | undefined;

    const invalidate = () => { dirty = true; };
    for (const type of ['entity:spawn', 'entity:remove']) scope.add(world.events.on(type, invalidate));
    scope.add(world.events.on<Entity>('entity:transform', entity => {
      // Ordinary meshes copy transforms on every render. Only static instances
      // need their uploaded matrices, spatial cells and culling bounds rebuilt.
      if (entity.visual?.batch) invalidate();
    }));

    function releaseWorldMeshes(): void {
      const errors: unknown[] = [];
      // Three's render-object cache listens to object disposal, including ordinary
      // Mesh objects that share material/geometry resources and have no dispose method.
      for (const mesh of dynamicObjects.values()) {
        try { mesh.dispatchEvent({ type: 'dispose' } as never); } catch (error) { errors.push(error); }
      }
      for (const mesh of instancedMeshes) {
        try { mesh.dispose(); } catch (error) { errors.push(error); }
      }
      instancedMeshes.clear(); objects.clear(); dynamicObjects.clear();
      worldRoot.clear();
      if (errors.length) throw new AggregateError(errors, 'World mesh cleanup failed');
    }
    scope.add(releaseWorldMeshes);

    function rebuild(): void {
      if (!dirty || disposed) return;
      dirty = false;
      releaseWorldMeshes();
      resources.begin();
      const batches = new Map<string, Batch>();
      instanceCount = 0;
      for (const entity of world.entities.values()) {
        const visual = entity.visual;
        if (!visual) continue;
        const resource = resources.acquire(visual);
        if (visual.batch) {
          const cell = entity.position.map(n => Math.floor(n / cellSize)).join(',');
          const key = `${resource.key}/${visual.castShadow !== false}/${cell}`;
          let batch = batches.get(key);
          if (!batch) {
            batch = { entities: [], geometry: resource.geometry, material: resource.material, castsShadow: visual.castShadow !== false };
            batches.set(key, batch);
          }
          batch.entities.push(entity);
          instanceCount++;
        } else {
          const mesh = new Mesh(resource.geometry, resource.material);
          mesh.name = entity.id;
          mesh.userData.entityId = entity.id;
          mesh.castShadow = visual.castShadow !== false;
          mesh.receiveShadow = true;
          copyTransform(mesh, entity);
          objects.set(entity.id, mesh);
          dynamicObjects.set(entity.id, mesh);
          worldRoot.add(mesh);
        }
      }
      for (const [key, batch] of batches) {
        const mesh = new InstancedMesh(batch.geometry, batch.material, batch.entities.length);
        mesh.name = `harbor:batch:${key}`;
        mesh.castShadow = batch.castsShadow;
        mesh.receiveShadow = true;
        mesh.userData.entityIds = batch.entities.map(entity => entity.id);
        batch.entities.forEach((entity, i) => {
          copyTransform(scratch, entity);
          scratch.updateMatrix();
          mesh.setMatrixAt(i, scratch.matrix);
          objects.set(entity.id, mesh);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        instancedMeshes.add(mesh);
        worldRoot.add(mesh);
      }
      resources.sweep();
    }

    function disposePipeline(): void {
      pipeline?.dispose();
      bloomPass?.dispose();
      scenePass?.dispose();
      pipeline = undefined; bloomPass = undefined; scenePass = undefined;
    }
    scope.add(disposePipeline);

    function setQuality(next: Quality): void {
      if (disposed) return;
      if (!['low', 'medium', 'high'].includes(next)) throw new TypeError(`Unknown quality: ${next}`);
      quality = next;
      const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? 1;
      renderer.setPixelRatio(Math.min(dpr, next === 'low' ? 1 : next === 'medium' ? 1.5 : 2));
      renderer.shadowMap.enabled = next !== 'low';
      sun.castShadow = next !== 'low';
      const shadowSize = next === 'high' ? 2048 : 1024;
      if (sun.shadow.mapSize.x !== shadowSize) {
        sun.shadow.map?.dispose(); sun.shadow.map = null;
        sun.shadow.mapPass?.dispose(); sun.shadow.mapPass = null;
        sun.shadow.mapSize.set(shadowSize, shadowSize);
        sun.shadow.needsUpdate = true;
      }
      disposePipeline();
      if (next === 'high' && options.bloom !== false) {
        scenePass = pass(scene, camera);
        const output = scenePass.getTextureNode();
        bloomPass = bloom(output, 0.24, 0.45, 1.05);
        bloomPass.setResolutionScale(0.5);
        pipeline = new RenderPipeline(renderer, output.add(bloomPass));
      }
    }

    function resize(width: number, height: number): void {
      if (disposed) return;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    setQuality(quality);
    resize(canvas.clientWidth || canvas.width || 1, canvas.clientHeight || canvas.height || 1);
    rebuild();
    return {
      renderer, scene, camera, resize, setQuality, invalidateScene: invalidate,
      render(_dt) {
        if (disposed) return;
        rebuild();
        for (const [id, mesh] of dynamicObjects) {
          const entity = world.entities.get(id);
          if (entity) copyTransform(mesh, entity);
        }
        sky.position.copy(camera.position);
        renderer.info.reset();
        if (pipeline) pipeline.render(); else renderer.render(scene, camera);
      },
      inspect() {
        const info = renderer.info;
        return {
          backend: (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2',
          quality, drawCalls: info.render.drawCalls, triangles: info.render.triangles,
          geometries: info.memory.geometries, textures: info.memory.textures,
          instances: instanceCount, batches: instancedMeshes.size, objects: objects.size,
          cachedGeometries: resources.geometries.size, cachedMaterials: resources.materials.size,
          pixelRatio: renderer.getPixelRatio(), bloom: !!pipeline,
        };
      },
      getObject(id) { rebuild(); return objects.get(id); },
      getEntityId(object, instanceId) {
        if (instanceId !== undefined) return object.userData.entityIds?.[instanceId] as string | undefined;
        return object.userData.entityId as string | undefined;
      },
      dispose,
    };
  } catch (error) {
    const errors = [error];
    try { dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    // Initialization failure owns teardown all the way through the async backend.
    try { await disposeRenderer(); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, 'Renderer initialization and cleanup failed');
    throw error;
  }
}
