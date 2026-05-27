/**
 * The wall-clock driver — the interactive counterpart to {@link SimClock}'s
 * advance-only model.
 *
 * `SimClock` is deliberately advance-only: tests step time forward by hand, and
 * nothing here consults real time (the determinism contract). But an
 * **interactive** sim-backed server — a live demo, manual exploration, a real
 * stdio MCP server fronted by `SimConnection` — needs time to *flow on its
 * own*. {@link RealtimeClock} is the small, explicitly non-deterministic adapter
 * that does that: it pumps a `SimClock` from wall time on a real interval, so
 * scenario events, responder replies, and debounces fire as real seconds pass —
 * without each consumer re-inventing `setInterval(() => clock.advance(…), …)`.
 *
 * **It is not for tests.** It is the one place real `setInterval` / `Date.now()`
 * enter the package, kept in its own module so they never leak into the
 * deterministic core. Tests should drive a bare `SimClock` with `advance` /
 * {@link SimClock.advanceAsync} instead.
 */

import type { SimClock } from "./clock.js";
import { SimError } from "./errors.js";
import { toMillis } from "./duration.js";
import type { Duration } from "./duration.js";

/** Options for a {@link RealtimeClock}. */
export interface RealtimeClockOptions {
  /**
   * How often to pump the clock, in wall-clock time (default `"250ms"`). Each
   * tick advances the `SimClock` by the wall time actually elapsed since the
   * previous tick (so a delayed event loop catches up rather than drifting),
   * multiplied by {@link RealtimeClockOptions.scale}.
   */
  step?: Duration;
  /**
   * Virtual-to-real time ratio (default `1` — true real time). `scale: 10` runs
   * the simulation ten times faster than wall time, so a 30-second debounce
   * fires in three real seconds — handy for live demos.
   */
  scale?: number;
}

/** The default pump cadence, in ms. */
const DEFAULT_STEP_MS = 250;

/**
 * Drives a {@link SimClock} from wall time for interactive use. Construct it
 * around the same `SimClock` the app was given, then {@link start} it.
 *
 * @example
 * ```ts
 * const clock = new SimClock();
 * const sim = new SimConnection({ world, clock, responders });
 * // … wire up an interactive server …
 *
 * const realtime = new RealtimeClock(clock).start();
 * // time now flows on its own; scheduled events fire as real seconds pass.
 * // on shutdown:
 * realtime.stop();
 * ```
 */
export class RealtimeClock {
  private readonly clock: SimClock;
  private readonly stepMs: number;
  private readonly scale: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Wall-clock time (ms) of the previous tick, for elapsed-time advancement. */
  private lastReal = 0;

  /**
   * @param clock - The `SimClock` to drive (the one the app under test was
   *   injected with).
   * @throws {SimError} If `step` is not a strictly-positive {@link Duration}, or
   *   `scale` is not positive.
   */
  constructor(clock: SimClock, opts?: RealtimeClockOptions) {
    this.clock = clock;
    this.stepMs = opts?.step !== undefined ? toMillis(opts.step) : DEFAULT_STEP_MS;
    this.scale = opts?.scale ?? 1;
    if (this.stepMs <= 0) {
      throw new SimError(`RealtimeClock: step must be strictly positive (got ${this.stepMs} ms)`);
    }
    if (!(this.scale > 0)) {
      throw new SimError(`RealtimeClock: scale must be positive (got ${this.scale})`);
    }
  }

  /** Whether the pump is currently running. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Start pumping the clock. Idempotent — a no-op if already running. The
   * underlying interval is `unref`'d so it never keeps a Node process alive on
   * its own.
   */
  start(): this {
    if (this.timer !== undefined) return this;
    this.lastReal = Date.now();
    this.timer = setInterval(() => this.tick(), this.stepMs);
    // Don't hold the event loop open just for the pump (Node's Timeout.unref).
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  /** Stop pumping the clock. Idempotent — a no-op if not running. */
  stop(): this {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this;
  }

  /** Advance the `SimClock` by the (scaled) wall time elapsed since the last tick. */
  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastReal;
    this.lastReal = now;
    const advanceBy = Math.round(elapsed * this.scale);
    if (advanceBy > 0) this.clock.advance(advanceBy);
  }
}
