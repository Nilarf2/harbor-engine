import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/core/index.js';
import { buildBVH, fromWorld, refitBVH } from '../src/raytrace/index.js';
import type { TraceTriangle } from '../src/raytrace/types.js';

function triangle(x: number, material = 0): TraceTriangle {
  return { a: [x, 0, 0], b: [x + 0.75, 0, 0], c: [x, 1, 0], material };
}

test('BVH leaves cover every input triangle exactly once and contain their geometry', () => {
  const source = Array.from({ length: 37 }, (_, i) => triangle((i * 17) % 37));
  const tree = buildBVH(source);
  assert.ok(tree.maxDepth <= 6);
  assert.equal(tree.triangleCount, 37);
  const covered: number[] = [];
  for (const node of tree.nodes) {
    if (node.count) {
      assert.ok(node.count <= 4);
      for (let i = node.start; i < node.start + node.count; i++) {
        const input = tree.triangleOrder[i]; covered.push(input);
        for (const point of [source[input].a, source[input].b, source[input].c]) {
          point.forEach((value, axis) => assert.ok(value >= node.min[axis] && value <= node.max[axis]));
        }
      }
    } else {
      for (const child of [tree.nodes[node.left], tree.nodes[node.right]]) {
        child.min.forEach((value, axis) => assert.ok(value >= node.min[axis]));
        child.max.forEach((value, axis) => assert.ok(value <= node.max[axis]));
      }
    }
  }
  assert.deepEqual(covered.sort((a, b) => a - b), source.map((_, i) => i));
});

test('GPU binary triangle and node records match the WGSL vec4 layout', () => {
  const tree = buildBVH([triangle(2, 3)]);
  assert.equal(tree.triangleData.byteLength, 96);
  assert.equal(tree.nodeData.byteLength, 48);
  assert.deepEqual([...tree.triangleData.slice(0, 4)], [2, 0, 0, 3]);
  assert.deepEqual([...tree.triangleData.slice(4, 7)], [2.75, 0, 0]);
  assert.deepEqual([...tree.triangleData.slice(8, 11)], [2, 1, 0]);
  assert.deepEqual([...tree.triangleData.slice(12, 15)], [0, 0, 1]);
  const links = new Uint32Array(tree.nodeData);
  assert.deepEqual([...links.slice(8, 12)], [0, 0, 0, 1]);
});

test('refit reuses topology/buffers, updates bounds, and detects unchanged geometry', () => {
  const source = Array.from({ length: 13 }, (_, i) => triangle(i));
  const tree = buildBVH(source);
  const nodes = tree.nodes, nodeData = tree.nodeData, triangleData = tree.triangleData;
  const order = [...tree.triangleOrder];
  const links = nodes.map(({ left, right, start, count }) => ({ left, right, start, count }));
  refitBVH(tree, source);
  assert.equal(tree.revision, 0);
  source[0] = triangle(-30);
  assert.equal(refitBVH(tree, source), tree);
  assert.equal(tree.revision, 1);
  assert.equal(tree.nodes, nodes); assert.equal(tree.nodeData, nodeData); assert.equal(tree.triangleData, triangleData);
  assert.deepEqual(tree.triangleOrder, order);
  assert.deepEqual(nodes.map(({ left, right, start, count }) => ({ left, right, start, count })), links);
  assert.ok(tree.nodes[0].min[0] < -30);
  refitBVH(tree, source);
  assert.equal(tree.revision, 1);
  assert.throws(() => refitBVH(tree, []), /same triangle count/);
});

test('empty scenes and degenerate triangles remain finite in the CPU representation', () => {
  const empty = buildBVH([]);
  assert.equal(empty.nodeCount, 0); assert.equal(empty.triangleCount, 0);
  assert.equal(refitBVH(empty, []).revision, 0);
  const degenerate = buildBVH([{ a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0] }]);
  assert.ok([...degenerate.triangleData].every(Number.isFinite));
});

test('BVH rejects sparse/non-finite/out-of-range data before GPU upload', () => {
  assert.throws(() => buildBVH([{ ...triangle(0), a: new Array(3) as [number, number, number] }]), /finite/);
  assert.throws(() => buildBVH([{ ...triangle(0), b: [NaN, 0, 0] }]), /finite/);
  assert.throws(() => buildBVH([triangle(1e8)]), /world units/);
  assert.throws(() => buildBVH([triangle(0, -1)]), /material/);
  assert.throws(() => buildBVH([triangle(0)], 0), /leafSize/);
});

test('fromWorld snapshots transforms, configurable tessellation, and glass optical properties', () => {
  const world = new World();
  world.spawn({ id: 'glass', position: [3, 2, 1], visual: { shape: 'sphere', size: [2, 2, 2], color: '#ffffff', transmission: 1, ior: 1.52, roughness: 0 } });
  const low = fromWorld(world, { segments: 12 }), high = fromWorld(world, { segments: 48 });
  assert.ok(high.triangles.length > low.triangles.length * 10);
  assert.equal(low.materials[0].transmission, 1); assert.equal(low.materials[0].ior, 1.52);
  assert.deepEqual(low.materials[0].color, [1, 1, 1]);
  const bvh = buildBVH(low.triangles);
  assert.ok(bvh.nodes[0].min[0] > 1.9 && bvh.nodes[0].max[0] < 4.1);
  world.get('glass')!.position[0] = 8;
  refitBVH(bvh, fromWorld(world, { segments: 12 }).triangles);
  assert.ok(bvh.nodes[0].min[0] > 6.9 && bvh.nodes[0].max[0] < 9.1);
  world.dispose();
});
