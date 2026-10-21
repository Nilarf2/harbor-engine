export interface CompleteFramePlan {
  columns: number;
  rows: number;
  dispatches: number;
  tileWidth: number;
  tileHeight: number;
  maxTilePixels: number;
  /** Upstream divides image pixels by this hint before choosing its grid. */
  backendBudget: number;
}

/** Match the pinned megakernel grid, correcting edge rounding without reducing resolution. */
export function completeFramePlan(width: number, height: number, budget: number): CompleteFramePlan {
  if (![width, height, budget].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Frame dimensions and budget must be positive safe integers');
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) throw new RangeError('Frame pixel count exceeds the safe integer range');
  let budgetTiles = Math.max(1, Math.ceil(pixels / budget));
  // At each correction the grid grows; the finite limit also bounds hostile or
  // highly anisotropic size/budget combinations before any renderer work starts.
  for (let attempt = 0; attempt < 64; attempt++) {
    const columns = Math.ceil(Math.sqrt(budgetTiles)), rows = Math.ceil(budgetTiles / columns);
    const dispatches = columns * rows, tileWidth = Math.ceil(width / columns), tileHeight = Math.ceil(height / rows);
    if (!Number.isSafeInteger(dispatches) || dispatches > 1_000_000) throw new RangeError('Frame budget requires too many tile dispatches; increase the budget');
    const maxTilePixels = tileWidth * tileHeight;
    if (maxTilePixels <= budget) {
      // ceil(pixels/backendBudget) must reproduce budgetTiles exactly; stay in
      // the middle of its interval to avoid floating-point boundary rounding.
      const backendBudget = budgetTiles === Math.ceil(pixels / budget) ? budget : pixels / (budgetTiles - 0.5);
      return { columns, rows, dispatches, tileWidth, tileHeight, maxTilePixels, backendBudget };
    }
    budgetTiles = Math.max(budgetTiles + 1, Math.ceil(budgetTiles * maxTilePixels / budget));
  }
  throw new RangeError('Cannot fit the requested tile budget');
}
