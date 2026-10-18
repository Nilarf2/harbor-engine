import type { BuiltBVH, BVHNode, TraceTriangle, TraceVec3 } from './types.js';

export function finiteVec3(value: unknown, label: string): asserts value is TraceVec3 {
  if (!Array.isArray(value) || value.length !== 3 || ![0, 1, 2].every(i => typeof value[i] === 'number' && Number.isFinite(value[i]))) {
    throw new TypeError(`${label} must be an array of three finite numbers.`);
  }
}

function unit(v: TraceVec3, fallback: TraceVec3): TraceVec3 {
  const scale = Math.max(...v.map(Math.abs));
  if (scale < 1e-12) return fallback;
  const scaled = v.map(n => n / scale);
  const length = Math.hypot(...scaled);
  return scaled.map(n => n / length) as TraceVec3;
}

function validateTriangle(triangle: TraceTriangle, index: number): void {
  for (const key of ['a', 'b', 'c'] as const) {
    finiteVec3(triangle[key], `triangle ${index}.${key}`);
    if (triangle[key].some(n => Math.abs(n) > 1e6)) throw new RangeError('Trace vertex coordinates must be within ±1,000,000 world units.');
  }
  for (const key of ['normalA', 'normalB', 'normalC'] as const) {
    if (triangle[key] !== undefined) finiteVec3(triangle[key], `triangle ${index}.${key}`);
  }
  if (triangle.material !== undefined && (!Number.isInteger(triangle.material) || triangle.material < 0 || triangle.material > 16_777_215)) {
    throw new RangeError(`triangle ${index}.material must be an integer in [0, 16777215].`);
  }
}

function packTriangle(data: Float32Array, offset: number, t: TraceTriangle): boolean {
  const e1 = t.b.map((v, axis) => v - t.a[axis]);
  const e2 = t.c.map((v, axis) => v - t.a[axis]);
  const geometric = unit([
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ], [0, 1, 0]);
  const packed = [
    ...t.a, t.material ?? 0, ...t.b, 0, ...t.c, 0,
    ...unit(t.normalA ?? geometric, geometric), 0,
    ...unit(t.normalB ?? geometric, geometric), 0,
    ...unit(t.normalC ?? geometric, geometric), 0,
  ];
  let changed = false;
  for (let i = 0; i < 24; i++) {
    const value = Math.fround(packed[i]);
    if (data[offset + i] !== value) { data[offset + i] = value; changed = true; }
  }
  return changed;
}

/** Deterministic median-split, triangle BVH; pure CPU and usable without a DOM or GPU. */
export function buildBVH(triangles: readonly TraceTriangle[], leafSize = 4): BuiltBVH {
  if (!Number.isInteger(leafSize) || leafSize < 1 || leafSize > 16) throw new RangeError('leafSize must be an integer in [1, 16].');
  if (triangles.length > 0x7fffffff) throw new RangeError('Triangle count exceeds the BVH u32 index format.');
  const centers: TraceVec3[] = [];
  triangles.forEach((triangle, index) => {
    validateTriangle(triangle, index);
    centers.push([0, 1, 2].map(axis => (triangle.a[axis] + triangle.b[axis] + triangle.c[axis]) / 3) as TraceVec3);
  });
  const nodes: BVHNode[] = [];
  const order = triangles.map((_, index) => index);
  let maxDepth = 0;
  function partition(start: number, end: number, depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    const min: TraceVec3 = [Infinity, Infinity, Infinity], max: TraceVec3 = [-Infinity, -Infinity, -Infinity];
    const cmin: TraceVec3 = [...min], cmax: TraceVec3 = [...max];
    for (let i = start; i < end; i++) {
      const index = order[i], triangle = triangles[index];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], triangle.a[axis], triangle.b[axis], triangle.c[axis]);
        max[axis] = Math.max(max[axis], triangle.a[axis], triangle.b[axis], triangle.c[axis]);
        cmin[axis] = Math.min(cmin[axis], centers[index][axis]);
        cmax[axis] = Math.max(cmax[axis], centers[index][axis]);
      }
    }
    // A small pad also keeps planar nodes robust against slab boundary precision.
    for (let axis = 0; axis < 3; axis++) { min[axis] -= 1e-5; max[axis] += 1e-5; }
    const node: BVHNode = { min, max, left: 0, right: 0, start, count: end - start };
    const index = nodes.push(node) - 1;
    if (end - start <= leafSize) return index;
    let axis = 0;
    for (let i = 1; i < 3; i++) if (cmax[i] - cmin[i] > cmax[axis] - cmin[axis]) axis = i;
    const sorted = order.slice(start, end).sort((a, b) => centers[a][axis] - centers[b][axis] || a - b);
    for (let i = 0; i < sorted.length; i++) order[start + i] = sorted[i];
    const middle = start + Math.floor((end - start) / 2);
    node.count = 0;
    node.left = partition(start, middle, depth + 1);
    node.right = partition(middle, end, depth + 1);
    return index;
  }
  if (triangles.length) partition(0, triangles.length, 1);
  const nodeData = new ArrayBuffer(Math.max(nodes.length, 1) * 48);
  const nf = new Float32Array(nodeData), nu = new Uint32Array(nodeData);
  nodes.forEach((node, i) => {
    const o = i * 12;
    nf.set(node.min, o); nf.set(node.max, o + 4);
    nu.set([node.left, node.right, node.start, node.count], o + 8);
  });
  const triangleData = new Float32Array(Math.max(triangles.length, 1) * 24);
  order.forEach((source, i) => packTriangle(triangleData, i * 24, triangles[source]));
  return { nodes, triangleOrder: order, triangleData, nodeData, triangleCount: triangles.length, nodeCount: nodes.length, maxDepth, revision: 0 };
}

/** In-place CPU refit: preserves topology, allocations, and original triangle order. */
export function refitBVH(bvh: BuiltBVH, triangles: readonly TraceTriangle[]): BuiltBVH {
  if (triangles.length !== bvh.triangleCount) throw new RangeError('Refit requires the same triangle count; rebuild for topology changes.');
  triangles.forEach(validateTriangle);
  let changed = false;
  bvh.triangleOrder.forEach((source, i) => { changed = packTriangle(bvh.triangleData, i * 24, triangles[source]) || changed; });
  if (!changed) return bvh;
  const data = bvh.triangleData;
  const bounds = new Float32Array(bvh.nodeData);
  // Children are always after parents in the flattened median-split tree.
  for (let i = bvh.nodes.length - 1; i >= 0; i--) {
    const node = bvh.nodes[i];
    if (node.count) {
      node.min.fill(Infinity); node.max.fill(-Infinity);
      for (let t = node.start; t < node.start + node.count; t++) {
        for (let vertex = 0; vertex < 3; vertex++) {
          for (let axis = 0; axis < 3; axis++) {
            const value = data[t * 24 + vertex * 4 + axis];
            node.min[axis] = Math.min(node.min[axis], value - 1e-5);
            node.max[axis] = Math.max(node.max[axis], value + 1e-5);
          }
        }
      }
    } else {
      const left = bvh.nodes[node.left], right = bvh.nodes[node.right];
      for (let axis = 0; axis < 3; axis++) {
        node.min[axis] = Math.min(left.min[axis], right.min[axis]);
        node.max[axis] = Math.max(left.max[axis], right.max[axis]);
      }
    }
    bounds.set(node.min, i * 12); bounds.set(node.max, i * 12 + 4);
  }
  bvh.revision++;
  return bvh;
}
