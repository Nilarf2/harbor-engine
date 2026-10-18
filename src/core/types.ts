export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Shape = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'cone';
/** Size is full width, height, depth; sphere uses width as diameter. */
export interface Visual {
  shape: Shape;
  size: Vec3;
  color?: string;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  ior?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** Explicit static instancing; use only for entities which never move. */
  batch?: boolean;
  castShadow?: boolean;
}
export interface Body {
  type: 'fixed' | 'dynamic' | 'character';
  shape: 'box' | 'sphere' | 'capsule';
  size: Vec3;
  friction?: number;
  restitution?: number;
  mass?: number;
}
export interface EntityDefinition {
  id: string;
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  visual?: Visual;
  body?: Body;
  tags?: string[];
  data?: Record<string, Json>;
}
export interface Entity extends EntityDefinition {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  tags: string[];
  data: Record<string, Json>;
}
export interface SceneDefinition {
  version: 1;
  name: string;
  seed?: number;
  fixedDelta?: number;
  entities: EntityDefinition[];
}
export interface WorldSnapshot {
  version: 1;
  tick: number;
  time: number;
  entities: Entity[];
}
export interface Command { type: string; [key: string]: unknown }
export type Disposer = () => void;
