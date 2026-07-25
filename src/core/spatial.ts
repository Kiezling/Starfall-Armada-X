/**
 * Uniform spatial hash grid for broad-phase collision.
 *
 * With ~2000 projectiles and ~200 enemies, the naive all-pairs test is 400,000 checks per
 * frame. This grid reduces it to the handful of enemies sharing a cell with each projectile.
 *
 * Implementation notes: cells are stored in flat typed arrays with a linked-list-per-cell
 * layout (`cellHead` + `nextIndex`), so a rebuild allocates nothing and clearing is a single
 * `fill`. Objects are inserted by index; the caller resolves indices back to entities.
 */

export class SpatialGrid {
  readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly dim: number;
  private readonly halfDim: number;

  /** cellHead[cell] = index of the first item in that cell, or -1. */
  private readonly cellHead: Int32Array;
  /** nextIndex[item] = index of the next item in the same cell, or -1. */
  private readonly nextIndex: Int32Array;
  /** Cells touched since the last clear, so clearing is O(used) not O(cells). */
  private readonly usedCells: Int32Array;
  private usedCount = 0;

  private itemCount = 0;

  /**
   * @param worldRadius Half-extent of the world the grid must cover.
   * @param cellSize    Should be roughly the diameter of the largest common query radius.
   * @param maxItems    Hard cap on inserted items per rebuild.
   */
  constructor(worldRadius: number, cellSize: number, maxItems: number) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.dim = Math.max(1, Math.ceil((worldRadius * 2) / cellSize) + 2);
    this.halfDim = Math.floor(this.dim / 2);

    const cells = this.dim * this.dim * this.dim;
    this.cellHead = new Int32Array(cells).fill(-1);
    this.nextIndex = new Int32Array(maxItems).fill(-1);
    this.usedCells = new Int32Array(cells);
  }

  /** Empties the grid. Cheap — only touches cells that actually received an item. */
  clear(): void {
    for (let i = 0; i < this.usedCount; i++) {
      this.cellHead[this.usedCells[i]!] = -1;
    }
    this.usedCount = 0;
    this.itemCount = 0;
  }

  private cellIndex(x: number, y: number, z: number): number {
    // Offset into positive space, then clamp so out-of-bounds objects land in edge cells
    // rather than aliasing to the wrong side of the grid.
    let cx = Math.floor(x * this.invCellSize) + this.halfDim;
    let cy = Math.floor(y * this.invCellSize) + this.halfDim;
    let cz = Math.floor(z * this.invCellSize) + this.halfDim;
    const max = this.dim - 1;
    cx = cx < 0 ? 0 : cx > max ? max : cx;
    cy = cy < 0 ? 0 : cy > max ? max : cy;
    cz = cz < 0 ? 0 : cz > max ? max : cz;
    return (cz * this.dim + cy) * this.dim + cx;
  }

  /**
   * Inserts an item index at a world position. The item is registered in exactly one cell,
   * so queries must search the neighbourhood wide enough to cover the object's radius.
   */
  insert(itemIndex: number, x: number, y: number, z: number): void {
    if (itemIndex >= this.nextIndex.length) return;
    const cell = this.cellIndex(x, y, z);
    if (this.cellHead[cell] === -1) {
      this.usedCells[this.usedCount++] = cell;
    }
    this.nextIndex[itemIndex] = this.cellHead[cell]!;
    this.cellHead[cell] = itemIndex;
    this.itemCount++;
  }

  /**
   * Collects the indices of every item within `radius` of the point into `out`, which is
   * cleared first. This is a broad-phase result: entries are candidates, and the caller
   * still performs the exact test.
   *
   * Returns the number of candidates written. `out` is capped at its own length to keep the
   * worst case bounded.
   */
  query(x: number, y: number, z: number, radius: number, out: Int32Array): number {
    const span = Math.ceil(radius * this.invCellSize);
    const max = this.dim - 1;

    let baseX = Math.floor(x * this.invCellSize) + this.halfDim;
    let baseY = Math.floor(y * this.invCellSize) + this.halfDim;
    let baseZ = Math.floor(z * this.invCellSize) + this.halfDim;
    baseX = baseX < 0 ? 0 : baseX > max ? max : baseX;
    baseY = baseY < 0 ? 0 : baseY > max ? max : baseY;
    baseZ = baseZ < 0 ? 0 : baseZ > max ? max : baseZ;

    const minX = Math.max(0, baseX - span);
    const maxX = Math.min(max, baseX + span);
    const minY = Math.max(0, baseY - span);
    const maxY = Math.min(max, baseY + span);
    const minZ = Math.max(0, baseZ - span);
    const maxZ = Math.min(max, baseZ + span);

    let count = 0;
    const limit = out.length;

    for (let cz = minZ; cz <= maxZ; cz++) {
      const zOff = cz * this.dim;
      for (let cy = minY; cy <= maxY; cy++) {
        const yOff = (zOff + cy) * this.dim;
        for (let cx = minX; cx <= maxX; cx++) {
          let item = this.cellHead[yOff + cx]!;
          while (item !== -1) {
            if (count >= limit) return count;
            out[count++] = item;
            item = this.nextIndex[item]!;
          }
        }
      }
    }
    return count;
  }

  get count(): number {
    return this.itemCount;
  }
}
