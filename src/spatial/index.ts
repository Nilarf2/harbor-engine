// Generalized from Nilarf2/dragon-raja-grand-escape (MIT), © 2026 Nilarf2.
export interface Rect { x: number; z: number; hw: number; hd: number; c: number; s: number }

/** CPU broad phase. Exact oriented collision and walkable-height rules belong to the game. */
export class SpatialIndex<T extends Rect> {
  private cells = new Map<string, Set<T>>();
  private keys = new Map<T, string[]>();
  constructor(readonly cellSize = 32) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Cell size must be positive and finite');
  }
  private range(x: number, z: number, rx: number, rz = rx): number[] {
    if (![x, z, rx, rz].every(Number.isFinite) || rx < 0 || rz < 0) throw new TypeError('Spatial bounds must be finite with nonnegative extents');
    const bounds = [Math.floor((x - rx) / this.cellSize), Math.floor((x + rx) / this.cellSize), Math.floor((z - rz) / this.cellSize), Math.floor((z + rz) / this.cellSize)];
    if (!bounds.every(Number.isSafeInteger) || (bounds[1] - bounds[0] + 1) * (bounds[3] - bounds[2] + 1) > 1_000_000) throw new RangeError('Spatial query spans too many cells');
    return bounds;
  }
  add(rect: T): () => void {
    if (!rect || ![rect.x, rect.z, rect.hw, rect.hd, rect.c, rect.s].every(Number.isFinite) || rect.hw < 0 || rect.hd < 0) throw new TypeError('Invalid spatial rectangle');
    const rx = Math.abs(rect.c) * rect.hw + Math.abs(rect.s) * rect.hd;
    const rz = Math.abs(rect.s) * rect.hw + Math.abs(rect.c) * rect.hd;
    const [x0, x1, z0, z1] = this.range(rect.x, rect.z, rx, rz), keys: string[] = [];
    this.remove(rect);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = `${x},${z}`; let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = new Set());
      cell.add(rect); keys.push(key);
    }
    this.keys.set(rect, keys);
    return () => this.remove(rect);
  }
  remove(rect: T): void {
    for (const key of this.keys.get(rect) ?? []) {
      const cell = this.cells.get(key)!; cell.delete(rect); if (!cell.size) this.cells.delete(key);
    }
    this.keys.delete(rect);
  }
  query(x: number, z: number, radius = 0): Set<T> {
    const [x0, x1, z0, z1] = this.range(x, z, radius), result = new Set<T>();
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) for (const rect of this.cells.get(`${i},${j}`) ?? []) result.add(rect);
    return result;
  }
  clear(): void { this.cells.clear(); this.keys.clear(); }
  get size(): number { return this.keys.size; }
}
