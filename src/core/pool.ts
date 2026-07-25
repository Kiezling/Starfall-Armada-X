/**
 * Fixed-capacity object pools.
 *
 * The game allocates every entity up front and never frees one. `acquire` hands back a
 * pre-built object; `release` returns it. Nothing in the hot loop calls `new`, so the
 * garbage collector has nothing to do during play and there are no frame hitches.
 */

/**
 * A pool that keeps its live objects in a dense prefix of the backing array, so iteration
 * over active items is cache-friendly and needs no `active` check.
 *
 * Iteration contract: when releasing during iteration, walk **backwards**, because releasing
 * swaps the last live item into the released slot.
 */
export class Pool<T> {
  /** The backing store. Indices `[0, size)` are live; the rest are free. */
  readonly items: T[];
  readonly capacity: number;
  private liveCount = 0;

  private readonly resetItem: ((item: T) => void) | undefined;

  /**
   * @param capacity  Hard cap. `acquire` returns null once full rather than growing, so a
   *                  runaway spawner degrades gracefully instead of exhausting memory.
   * @param factory   Builds one object. Called `capacity` times during construction.
   * @param resetItem Optional hook run when an object is released.
   */
  constructor(capacity: number, factory: (index: number) => T, resetItem?: (item: T) => void) {
    this.capacity = capacity;
    this.items = new Array<T>(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = factory(i);
    this.resetItem = resetItem;
  }

  /** Number of currently live objects. Live objects are `items[0 .. size-1]`. */
  get size(): number {
    return this.liveCount;
  }

  get available(): number {
    return this.capacity - this.liveCount;
  }

  /** Returns the next free object, or null when the pool is full. */
  acquire(): T | null {
    if (this.liveCount >= this.capacity) return null;
    return this.items[this.liveCount++]!;
  }

  /**
   * Releases the object at live index `i` by swapping the last live object into its place.
   * O(1), but it reorders the live set — hence the backwards-iteration rule.
   */
  releaseAt(i: number): void {
    if (i < 0 || i >= this.liveCount) return;
    const last = this.liveCount - 1;
    const item = this.items[i]!;
    if (this.resetItem) this.resetItem(item);
    if (i !== last) {
      this.items[i] = this.items[last]!;
      this.items[last] = item;
    }
    this.liveCount--;
  }

  /** Releases every live object. */
  releaseAll(): void {
    if (this.resetItem) {
      for (let i = 0; i < this.liveCount; i++) this.resetItem(this.items[i]!);
    }
    this.liveCount = 0;
  }

  /**
   * Runs `fn` over every live object, tolerating releases from inside the callback by
   * iterating backwards. Prefer a manual backwards `for` loop in the hottest paths — the
   * callback here is a real cost at thousands of items per frame.
   */
  forEachReverse(fn: (item: T, index: number) => void): void {
    for (let i = this.liveCount - 1; i >= 0; i--) fn(this.items[i]!, i);
  }
}

/**
 * A monotonically increasing id source. Entity ids must be unique across the whole run so a
 * stale homing reference cannot latch onto a recycled pool slot.
 */
export class IdSource {
  private next = 1;

  issue(): number {
    return this.next++;
  }

  reset(): void {
    this.next = 1;
  }
}

/**
 * A ring buffer of numbers, used for rolling frame-time averages in the adaptive quality
 * controller and the performance overlay.
 */
export class RollingAverage {
  private readonly samples: Float32Array;
  private cursor = 0;
  private filled = 0;
  private total = 0;

  constructor(size: number) {
    this.samples = new Float32Array(size);
  }

  push(value: number): void {
    const old = this.samples[this.cursor]!;
    this.total += value - old;
    this.samples[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  get average(): number {
    return this.filled === 0 ? 0 : this.total / this.filled;
  }

  get isWarm(): boolean {
    return this.filled === this.samples.length;
  }

  reset(): void {
    this.samples.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.total = 0;
  }
}
