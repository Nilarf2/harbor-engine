// Adapted from Nilarf2/dragon-raja-grand-escape (MIT), © 2026 Nilarf2.
import { AnimationMixer, LoopOnce, LoopRepeat, type Object3D, type AnimationClip, type AnimationAction, type SkinnedMesh } from 'three/webgpu';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetHandle } from './AssetManager.js';

export class Actor {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  private actions = new Map<string, AnimationAction>();
  private current?: AnimationAction;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(readonly id: string, template: { scene: Object3D; animations: AnimationClip[] }, private release: () => void = () => {}) {
    this.root = clone(template.scene); this.root.name = id;
    this.mixer = new AnimationMixer(this.root);
    for (const clip of template.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
  }
  static fromHandle(id: string, handle: AssetHandle<GLTF>) {
    try { return new Actor(id, handle.value, handle.release); }
    catch (error) {
      try { handle.release(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Actor construction and release failed'); }
      throw error;
    }
  }
  get clips() { return [...this.actions.keys()]; }
  play(name: string, fade = 0.25, once = false) {
    if (this.disposed) throw new Error(`Actor ${this.id} disposed`);
    const action = this.actions.get(name);
    if (!action) throw new Error(`Actor ${this.id} has no animation ${name}`);
    if (action === this.current && action.isRunning()) return;
    action.reset().setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    if (this.current && this.current !== action) this.current.fadeOut(fade);
    action.fadeIn(fade).play(); this.current = action;
  }
  onFinished(callback: (name: string) => void) {
    if (this.disposed) throw new Error(`Actor ${this.id} disposed`);
    const listener = (event: { action: AnimationAction }) => callback(event.action.getClip().name);
    this.mixer.addEventListener('finished', listener);
    const remove = () => { this.mixer.removeEventListener('finished', listener); this.listeners.delete(remove); };
    this.listeners.add(remove);
    return remove;
  }
  update(dt: number) { if (!this.disposed) this.mixer.update(dt); }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    const errors: unknown[] = [];
    const cleanup = (run: () => void) => { try { run(); } catch (error) { errors.push(error); } };
    for (const remove of this.listeners) cleanup(remove);
    cleanup(() => this.mixer.stopAllAction());
    cleanup(() => this.mixer.uncacheRoot(this.root));
    const objects: Object3D[] = [];
    this.root.traverse(object => objects.push(object));
    for (const object of objects) {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) cleanup(() => mesh.skeleton.dispose());
      cleanup(() => object.dispose());
    }
    cleanup(() => this.root.removeFromParent());
    this.actions.clear(); this.current = undefined;
    cleanup(this.release);
    if (errors.length) throw new AggregateError(errors, `Actor ${this.id} cleanup failed`);
  }
}
