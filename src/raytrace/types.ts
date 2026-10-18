export type TraceVec3 = [number, number, number];

/** Vertex positions are world-space; optional normals enable smooth triangle shading. */
export interface TraceTriangle {
  a: TraceVec3;
  b: TraceVec3;
  c: TraceVec3;
  normalA?: TraceVec3;
  normalB?: TraceVec3;
  normalC?: TraceVec3;
  material?: number;
}

/** RGB values are linear, not sRGB. Emission is radiance and may exceed 1. */
export interface TraceMaterial {
  color: TraceVec3;
  emission?: TraceVec3;
  metalness?: number;
  roughness?: number;
  /** Fraction of the dielectric interface using polished transmission. */
  transmission?: number;
  /** Index of refraction, relative to air. Defaults to 1.5. */
  ior?: number;
}

export interface TraceEnvironment {
  skyTop?: TraceVec3;
  skyHorizon?: TraceVec3;
  ground?: TraceVec3;
  /** Direction pointing toward the sun. */
  sunDirection?: TraceVec3;
  sunColor?: TraceVec3;
  sunIntensity?: number;
  /** Radians, clamped to [0, 0.2]. Zero produces a sharp directional shadow. */
  sunAngularRadius?: number;
}

export interface TraceScene {
  triangles: TraceTriangle[];
  materials: TraceMaterial[];
  environment?: TraceEnvironment;
}

export interface TraceCamera {
  position: TraceVec3;
  target: TraceVec3;
  /** Vertical field of view, in degrees. */
  fov?: number;
  up?: TraceVec3;
}

export interface BVHNode {
  min: TraceVec3;
  max: TraceVec3;
  left: number;
  right: number;
  start: number;
  count: number;
}

export interface BuiltBVH {
  nodes: BVHNode[];
  triangleOrder: number[];
  /** Six vec4<f32> records per triangle. */
  triangleData: Float32Array;
  /** Three 16-byte records per node: bounds min, bounds max, u32 metadata. */
  nodeData: ArrayBuffer;
  triangleCount: number;
  nodeCount: number;
  maxDepth: number;
  /** Incremented by refit only when packed geometry actually changes. */
  revision: number;
}

export interface PathTracerOptions {
  canvas: HTMLCanvasElement;
  width?: number;
  height?: number;
  /** Defaults to 6; supported range is 1–32. */
  maxBounces?: number;
  /** Optional capture for browser integration, diagnostics, and device-loss UI. */
  onError?: (error: Error) => void;
}

export interface PathTracerStats {
  backend: 'webgpu-compute';
  samples: number;
  width: number;
  height: number;
  triangles: number;
  bvhNodes: number;
  bvhDepth: number;
  maxBounces: number;
  approximateBufferBytes: number;
  status: 'ready' | 'lost' | 'error' | 'disposed';
  error?: string;
}

export interface PathTracer {
  setScene(scene: TraceScene): void;
  /** Refit the existing BVH for the same triangle count/order; reset progressive history. */
  updateGeometry(triangles: TraceTriangle[]): void;
  setCamera(camera: TraceCamera): void;
  /** One stochastic sample per pixel, then present the running mean. No hidden RAF. */
  render(): void;
  resize(width: number, height: number): void;
  reset(): void;
  inspect(): PathTracerStats;
  /** Read the accumulated linear RGBA mean. Intended for validation/export, not every frame. */
  captureLinear(): Promise<Float32Array>;
  dispose(): void;
}
