/**
 * The virtual clock — the test-time implementation of the injectable
 * `Clock` interface that `meshcore-mcp` and `checkmate` consume.
 *
 * Without a controllable clock a 30-second debounce means a 30-second test.
 * {@link SimClock} compresses any span of simulated time to zero real seconds:
 * call {@link SimClock.advance | advance("30s")} and every timer that would
 * have fired during that window fires synchronously, in deterministic order,
 * before the call returns.
 *
 * **Determinism contract.** Same-tick timers fire in FIFO scheduling order,
 * enforced by a monotone sequence number. No real time (`Date.now()`,
 * `setTimeout`) is ever consulted. Re-running an identical sequence of
 * schedule + advance calls yields identical firing order, every time.
 */

import { SimError } from "./errors.js";
import { toMillis } from "./duration.js";
import type { Duration } from "./duration.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An opaque handle returned by {@link Clock.setTimeout} /
 * {@link Clock.setInterval}. Pass to {@link Clock.clearTimeout} /
 * {@link Clock.clearInterval} to cancel the timer.
 *
 * The shape is intentionally opaque — callers must not inspect its fields.
 */
export type TimerHandle = { readonly __timerId: number };

/**
 * The minimal clock interface that apps inject.
 *
 * In production the app supplies a real implementation backed by
 * `Date.now()` and `globalThis.setTimeout`; in tests it is {@link SimClock}.
 * Because the interface is this small any app can define it locally and
 * `SimClock` will satisfy it structurally.
 */
export interface Clock {
  /** Virtual (or wall-clock) milliseconds since the clock's epoch. */
  now(): number;

  /**
   * Schedule `callback` to run after `delay` has elapsed.
   *
   * @returns A handle that can be passed to {@link clearTimeout}.
   */
  setTimeout(callback: () => void, delay: Duration): TimerHandle;

  /** Cancel a pending one-shot timer. No-op for unknown / already-fired handles. */
  clearTimeout(handle: TimerHandle): void;

  /**
   * Schedule `callback` to run repeatedly every `interval`.
   *
   * @returns A handle that can be passed to {@link clearInterval}.
   */
  setInterval(callback: () => void, interval: Duration): TimerHandle;

  /** Cancel a repeating timer. No-op for unknown / already-cancelled handles. */
  clearInterval(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------
// Internal timer record
// ---------------------------------------------------------------------------

/** Internal state for one scheduled timer entry. */
interface TimerEntry {
  /** The opaque public handle; `handle.__timerId === id`. */
  readonly handle: TimerHandle;
  /** Monotone creation index — the FIFO tiebreaker for same-due-time timers. */
  seq: number;
  /** Absolute virtual time (ms) at which the callback is next due. */
  dueAt: number;
  /** The callback to invoke when the timer fires. */
  readonly callback: () => void;
  /** `true` for `setInterval` timers; the period in ms when positive. */
  readonly period: number | false;
  /** Marked `true` once fired (one-shot) or cancelled. */
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// SimClock
// ---------------------------------------------------------------------------

/**
 * Deterministic virtual clock for test scenarios.
 *
 * Create one, pass it into the system under test wherever the app accepts a
 * {@link Clock}, then call {@link advance} / {@link runUntil} to drive
 * simulated time forward. All callbacks fire synchronously in due-time order
 * (FIFO within the same tick) before the control method returns.
 *
 * @example
 * ```ts
 * const clock = new SimClock();
 * let fired = false;
 * clock.setTimeout(() => { fired = true; }, "5s");
 * clock.advance("4999ms");
 * // fired === false
 * clock.advance("1ms");
 * // fired === true
 * ```
 */
export class SimClock implements Clock {
  /** Current virtual time in ms. */
  private _now: number;
  /** Monotonically increasing sequence counter — the FIFO tiebreaker. */
  private _seq = 0;
  /** Next timer id. */
  private _nextId = 1;
  /** All live (un-cancelled, un-fired-and-removed) timer entries. */
  private readonly _timers = new Map<number, TimerEntry>();

  /**
   * @param opts.start - Initial virtual time in ms (defaults to `0`).
   */
  constructor(opts?: { start?: number }) {
    this._now = opts?.start ?? 0;
  }

  // -------------------------------------------------------------------------
  // Clock interface
  // -------------------------------------------------------------------------

  /** Current virtual time in milliseconds. */
  now(): number {
    return this._now;
  }

  /**
   * Schedule a one-shot callback at `now() + delay`.
   *
   * A zero or negative delay (after parsing) is allowed — the callback will
   * fire at the current virtual time on the next {@link advance} or
   * {@link runUntil} call.
   *
   * @throws {SimError} If `delay` is not a valid {@link Duration}.
   */
  setTimeout(callback: () => void, delay: Duration): TimerHandle {
    const ms = toMillis(delay);
    return this._schedule(callback, this._now + ms, false);
  }

  /**
   * Cancel a pending one-shot timer.
   *
   * Cancelling an unknown or already-fired handle is a no-op.
   */
  clearTimeout(handle: TimerHandle): void {
    this._cancel(handle);
  }

  /**
   * Schedule a repeating callback that fires every `interval`.
   *
   * The interval period must be strictly positive — a zero or negative period
   * would cause an infinite loop inside a single {@link advance} call.
   *
   * @throws {SimError} If `interval` is not a valid {@link Duration} or its
   *   parsed value is `<= 0`.
   */
  setInterval(callback: () => void, interval: Duration): TimerHandle {
    const ms = toMillis(interval);
    if (ms <= 0) {
      throw new SimError(
        `setInterval: interval must be strictly positive (got ${ms} ms); ` +
          `a zero interval would loop forever inside a single advance()`,
      );
    }
    return this._schedule(callback, this._now + ms, ms);
  }

  /**
   * Cancel a repeating timer.
   *
   * Cancelling an unknown or already-cancelled handle is a no-op.
   */
  clearInterval(handle: TimerHandle): void {
    this._cancel(handle);
  }

  // -------------------------------------------------------------------------
  // SimClock-specific controls
  // -------------------------------------------------------------------------

  /**
   * Advance virtual time by `by`, firing every timer whose due time falls
   * within `(previousNow, now + by]`, in due-time order (FIFO within the same
   * tick).
   *
   * Timers scheduled *during* a callback that fall within the remaining window
   * also fire in the same `advance` — this lets a chain of timers collapse into
   * one call. After all due timers have fired, `now()` is set to exactly
   * `previousNow + toMillis(by)`.
   *
   * @throws {SimError} If `by` is not a valid {@link Duration}.
   */
  advance(by: Duration): void {
    const ms = toMillis(by);
    const target = this._now + ms;
    this._drainTo(target);
    this._now = target;
  }

  /**
   * Fire all timers with `dueAt <= t`, in order, then set `now()` to exactly
   * `t`.
   *
   * @throws {SimError} If `t < now()`.
   */
  runUntil(t: number): void {
    if (t < this._now) {
      throw new SimError(
        `runUntil(${t}): target time is in the past (now = ${this._now})`,
      );
    }
    this._drainTo(t);
    this._now = t;
  }

  /**
   * Fire all currently-pending one-shot timers until none remain, advancing
   * `now()` to the due time of the last timer fired. Interval timers are
   * left in place (they never drain to zero).
   *
   * This is a convenience for scenario draining in M4 and later milestones.
   *
   * @param maxIterations - Guard against runaway loops (default 100 000).
   * @throws {SimError} If `maxIterations` is exceeded (likely caused by an
   *   interval or by one-shot timers scheduling each other without bound).
   */
  runAll(maxIterations = 100_000): void {
    let iters = 0;
    for (;;) {
      const next = this._nextDueOneShot();
      if (next === undefined) break;
      if (++iters > maxIterations) {
        throw new SimError(
          `runAll(): exceeded ${maxIterations} iterations — possible infinite timer chain`,
        );
      }
      this._drainTo(next.dueAt);
      this._now = next.dueAt;
    }
  }

  /**
   * Number of scheduled timers that have not yet fired or been cancelled.
   * Useful for assertions and diagnostics.
   */
  pendingCount(): number {
    return this._timers.size;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Create a new timer entry and register it. */
  private _schedule(
    callback: () => void,
    dueAt: number,
    period: number | false,
  ): TimerHandle {
    const id = this._nextId++;
    const handle: TimerHandle = { __timerId: id };
    const entry: TimerEntry = {
      handle,
      seq: this._seq++,
      dueAt,
      callback,
      period,
      cancelled: false,
    };
    this._timers.set(id, entry);
    return handle;
  }

  /** Mark the timer for the given handle as cancelled and remove it. */
  private _cancel(handle: TimerHandle): void {
    const entry = this._timers.get(handle.__timerId);
    if (entry !== undefined) {
      entry.cancelled = true;
      this._timers.delete(handle.__timerId);
    }
  }

  /**
   * Repeatedly pull the earliest due timer with `dueAt <= target` and fire it,
   * until no more remain within the window. Timers added during callbacks are
   * included if they fall within the window.
   *
   * `this._now` is updated to each timer's `dueAt` before its callback runs, so
   * that `now()` inside a callback reflects the virtual time at which the timer
   * fired.
   */
  private _drainTo(target: number): void {
    for (;;) {
      const entry = this._nextDue(target);
      if (entry === undefined) break;

      // Advance the clock to this timer's due time before firing.
      this._now = entry.dueAt;

      if (entry.period !== false) {
        // Interval: reschedule *before* calling the callback so that a
        // clearInterval() inside the callback cancels the rescheduled entry.
        entry.dueAt = this._now + entry.period;
        entry.seq = this._seq++; // update seq so FIFO ordering resets per period
      } else {
        // One-shot: remove before calling.
        this._timers.delete(entry.handle.__timerId);
      }

      entry.callback();
    }
  }

  /**
   * Return the timer with the smallest `dueAt <= target`, breaking ties by
   * `seq` (FIFO scheduling order). Returns `undefined` if no such timer exists.
   *
   * Linear scan is fine for the timer counts expected in tests.
   */
  private _nextDue(target: number): TimerEntry | undefined {
    let best: TimerEntry | undefined;
    for (const entry of this._timers.values()) {
      if (entry.dueAt > target) continue;
      if (
        best === undefined ||
        entry.dueAt < best.dueAt ||
        (entry.dueAt === best.dueAt && entry.seq < best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }

  /**
   * Return the one-shot timer with the smallest `dueAt`, or `undefined` if no
   * one-shot timers remain. Used by {@link runAll}.
   */
  private _nextDueOneShot(): TimerEntry | undefined {
    let best: TimerEntry | undefined;
    for (const entry of this._timers.values()) {
      if (entry.period !== false) continue; // skip intervals
      if (best === undefined || entry.dueAt < best.dueAt) {
        best = entry;
      }
    }
    return best;
  }
}
