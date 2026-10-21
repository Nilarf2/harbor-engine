import type { Scope } from '../core/Scope.js';

/** Native Three scenes/cameras can remain additional application-owned fields. */
export interface ApplicationScene<State = unknown> {
  readonly id: string;
  /** Synchronous activation; asynchronous preparation belongs in load/restore. */
  enter(): void;
  update(dt: number, time: number): void;
  render(time: number): void;
  resize(width: number, height: number): void;
  snapshot(): State;
  restore(state: State): void;
  diagnostics(): Record<string, unknown>;
  /** Await view/GPU cleanup before releasing assets used by that view. */
  dispose(): void | Promise<void>;
}
export interface SceneLoadContext { readonly signal: AbortSignal; readonly scope: Scope }
export interface SceneFactory<Services extends object, State = unknown, Manifest extends { id: string } = { id: string }> {
  readonly manifest: Manifest;
  load(services: Services & SceneLoadContext): Promise<ApplicationScene<State>>;
}
export interface FrameScheduler {
  now(): number;
  request(callback: (milliseconds: number) => void): number;
  cancel(handle: number): void;
}
export interface ApplicationHost extends FrameScheduler {
  readonly width: number;
  readonly height: number;
  readonly hidden: boolean;
  listen(type: 'resize' | 'visibilitychange', callback: () => void): () => void;
}
export interface ApplicationOptions<Services extends object, State = unknown, Manifest extends { id: string } = { id: string }> {
  services: Services;
  scenes?: readonly SceneFactory<Services, State, Manifest>[];
  autoStart?: boolean;
  /** RAF limit only. Explicit step(seconds) is never clamped or split. */
  maxFrameDelta?: number;
  /** Inject a deterministic host in Node, or omit to use the browser window. */
  host?: ApplicationHost;
  onError?: (error: Error) => void;
  /** Application-owned shared renderer/assets, released after scenes and pending loads. */
  disposeServices?: () => void | Promise<void>;
  /** Resize a shared native renderer before resizing the active scene. */
  resizeServices?: (width: number, height: number) => void;
}
