/**
 * Deterministic, dependency-free seeded pseudo-random number generator.
 *
 * The simulator is deterministic by construction: every run is reproducible
 * (PRD §4). Randomness is allowed, but only *seeded* — the same seed in yields
 * the same sequence out. {@link SeededRandom} is that enabler. It is used for
 * *variety* (display names, battery jitter, traffic timing) in the generators
 * and scenario builders that arrive in later milestones.
 *
 * It is **not** used to derive node keys — those are derived deterministically
 * from the node id with no seed at all (see `keys.ts`). Key material must be
 * stable across worlds regardless of which seed produced them.
 *
 * The core is `mulberry32`: a tiny, well-distributed 32-bit generator. Same
 * seed ⇒ identical sequence, on every platform, forever.
 */

/** A small, deterministic 32-bit PRNG seeded from a single integer. */
export class SeededRandom {
  /** Internal 32-bit state, advanced on every draw. */
  private state: number;

  /**
   * @param seed - Any integer. The same seed always produces the same
   *   sequence; the value is masked to 32 bits.
   */
  constructor(seed: number) {
    // Coerce to a non-negative 32-bit integer so non-integer or negative
    // seeds still produce a stable, well-defined starting state.
    this.state = seed >>> 0;
  }

  /** Next float in the half-open interval `[0, 1)`. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Integer in the inclusive range `[minInclusive, maxInclusive]`.
   *
   * @throws {RangeError} If `minInclusive > maxInclusive`.
   */
  int(minInclusive: number, maxInclusive: number): number {
    if (minInclusive > maxInclusive) {
      throw new RangeError(
        `int(): min (${minInclusive}) must be <= max (${maxInclusive})`,
      );
    }
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(this.next() * span);
  }

  /**
   * Pick a uniformly random element from a non-empty array.
   *
   * @throws {RangeError} If `items` is empty.
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError("pick(): cannot pick from an empty array");
    }
    // `int` is bounded to a valid index, so the read is always in range; the
    // non-null assertion satisfies `noUncheckedIndexedAccess`.
    return items[this.int(0, items.length - 1)]!;
  }

  /**
   * A biased coin flip. Returns `true` with probability `p`.
   *
   * @param p - Probability of `true`, in `[0, 1]`. Defaults to `0.5`.
   */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** A deterministic buffer of `n` random bytes (each `0..255`). */
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.int(0, 255);
    }
    return out;
  }
}
