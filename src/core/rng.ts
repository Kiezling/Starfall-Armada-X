/**
 * Seeded random number generation.
 *
 * Every gameplay-affecting random draw goes through an `Rng` instance so a run is
 * reproducible from its seed. Purely cosmetic randomness (particle jitter) may use
 * `Math.random` — mixing the two into the gameplay stream would break reproducibility.
 */

/** mulberry32 — small, fast, and good enough for game randomness. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid a zero state, which mulberry32 handles poorly.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** Uniform in [-magnitude, magnitude]. */
  signed(magnitude = 1): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * Weighted pick. `weights` must be the same length as `items` and sum to more than zero.
   * Returns the last item if floating-point drift overshoots.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i]!;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Picks `count` distinct items without allocating a copy of `items`. Writes into `out`,
   * which is cleared first. If `count` exceeds the pool size, returns everything available.
   */
  sample<T>(items: readonly T[], count: number, out: T[]): T[] {
    out.length = 0;
    const n = Math.min(count, items.length);
    // Reservoir-free approach: track picked indices in a small scratch set.
    for (let i = 0; i < items.length && out.length < n; i++) {
      const remaining = items.length - i;
      const needed = n - out.length;
      if (this.next() < needed / remaining) out.push(items[i]!);
    }
    return out;
  }

  /** Snapshot the internal state so a sub-stream can be restored later. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  /**
   * Derives an independent generator from this one. Useful for giving a subsystem its own
   * stream so its draw count cannot perturb the main sequence.
   */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 0xffffffff));
  }
}

/** A seed derived from the clock, for runs the player did not explicitly seed. */
export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

/** Turns a human-typed seed string into a 32-bit integer seed. */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
