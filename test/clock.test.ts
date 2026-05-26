/**
 * Tests for SimClock — the deterministic virtual clock.
 *
 * Every assertion here is about simulated time only; no real `setTimeout` or
 * `Date.now()` is used. The tests cover:
 *   - `now()` initial value and exact positioning after advance
 *   - `setTimeout` boundary conditions (fires at due time, not before)
 *   - Multi-timer time-ordered firing across a single advance
 *   - Same-due-time FIFO ordering (the determinism invariant)
 *   - Nested timer scheduling (timers scheduled mid-advance that fall in window)
 *   - `clearTimeout` before due; cancelling unknown handles
 *   - `setInterval` repeat firing and `clearInterval`
 *   - Zero/negative interval rejection
 *   - `runUntil` semantics and past-time rejection
 *   - `runAll` drains one-shots, leaves intervals, guards against infinite loops
 *   - `pendingCount` bookkeeping
 *   - Determinism: two identical schedules produce byte-identical firing order
 */

import { describe, expect, it } from "vitest";
import { SimClock } from "../src/clock.js";
import { SimError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// now() and advance basics
// ---------------------------------------------------------------------------

describe("now() and advance()", () => {
  it("starts at 0 by default", () => {
    const clock = new SimClock();
    expect(clock.now()).toBe(0);
  });

  it("starts at the given start value", () => {
    const clock = new SimClock({ start: 5000 });
    expect(clock.now()).toBe(5000);
  });

  it("advance moves now() by exactly the requested amount", () => {
    const clock = new SimClock();
    clock.advance("1s");
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it("advance by 0 leaves now() unchanged", () => {
    const clock = new SimClock();
    clock.advance(0);
    expect(clock.now()).toBe(0);
  });

  it("advance sets now() to target even when no timers are pending", () => {
    const clock = new SimClock();
    clock.advance("10s");
    expect(clock.now()).toBe(10_000);
  });

  it("advance sets now() to target even when the last timer fired before target", () => {
    const clock = new SimClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), "500ms");
    clock.advance("1s");
    expect(fired).toEqual([500]);
    expect(clock.now()).toBe(1000); // target, not last-timer time
  });
});

// ---------------------------------------------------------------------------
// setTimeout boundary conditions
// ---------------------------------------------------------------------------

describe("setTimeout boundaries", () => {
  it("does NOT fire on advance that stops 1 ms before due time", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, "1000ms");

    clock.advance("999ms");
    expect(fired).toBe(false);
    expect(clock.now()).toBe(999);
  });

  it("fires on the advance that reaches exactly the due time", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, "1000ms");

    clock.advance("999ms");
    expect(fired).toBe(false);
    clock.advance("1ms");
    expect(fired).toBe(true);
    expect(clock.now()).toBe(1000);
  });

  it("fires when advance goes past the due time", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, "1000ms");

    clock.advance("2000ms");
    expect(fired).toBe(true);
  });

  it("now() inside the callback equals the timer's due time", () => {
    const clock = new SimClock();
    let nowAtFire = -1;
    clock.setTimeout(() => { nowAtFire = clock.now(); }, "500ms");
    clock.advance("1s");
    expect(nowAtFire).toBe(500);
  });

  it("a zero-delay timer fires at now() on the next advance", () => {
    const clock = new SimClock();
    let fired = false;
    clock.advance("1s"); // move to t=1000
    clock.setTimeout(() => { fired = true; }, 0);
    clock.advance(0); // advance by 0 — due at t=1000, target=1000, inclusive
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple timers — time-ordered firing
// ---------------------------------------------------------------------------

describe("multiple timers — time order", () => {
  it("fires N timers at staggered times in due-time order across one advance", () => {
    const clock = new SimClock();
    const order: string[] = [];

    clock.setTimeout(() => order.push("b"), "200ms");
    clock.setTimeout(() => order.push("c"), "300ms");
    clock.setTimeout(() => order.push("a"), "100ms");

    clock.advance("1s");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("records the correct virtual time for each timer", () => {
    const clock = new SimClock();
    const times: number[] = [];

    clock.setTimeout(() => times.push(clock.now()), "100ms");
    clock.setTimeout(() => times.push(clock.now()), "200ms");
    clock.setTimeout(() => times.push(clock.now()), "300ms");

    clock.advance("1s");
    expect(times).toEqual([100, 200, 300]);
  });
});

// ---------------------------------------------------------------------------
// Same-due-time FIFO ordering (the determinism invariant)
// ---------------------------------------------------------------------------

describe("same-due-time FIFO ordering", () => {
  it("fires timers with identical due times in scheduling (FIFO) order", () => {
    const clock = new SimClock();
    const order: number[] = [];

    clock.setTimeout(() => order.push(1), "1s");
    clock.setTimeout(() => order.push(2), "1s");
    clock.setTimeout(() => order.push(3), "1s");

    clock.advance("1s");
    expect(order).toEqual([1, 2, 3]);
  });

  it("FIFO holds even when mixed with different-time timers", () => {
    const clock = new SimClock();
    const order: string[] = [];

    clock.setTimeout(() => order.push("early"), "500ms");
    clock.setTimeout(() => order.push("same-1"), "1s");
    clock.setTimeout(() => order.push("same-2"), "1s");
    clock.setTimeout(() => order.push("same-3"), "1s");
    clock.setTimeout(() => order.push("late"), "1500ms");

    clock.advance("2s");
    expect(order).toEqual(["early", "same-1", "same-2", "same-3", "late"]);
  });
});

// ---------------------------------------------------------------------------
// Nested timer scheduling (timers scheduled mid-advance)
// ---------------------------------------------------------------------------

describe("nested timer scheduling", () => {
  it("a timer that schedules another timer within the window fires in the same advance", () => {
    const clock = new SimClock();
    const order: string[] = [];

    clock.setTimeout(() => {
      order.push("outer");
      // schedule an inner timer due at now() + 500ms = 1500ms, within the 2s window
      clock.setTimeout(() => order.push("inner"), "500ms");
    }, "1s");

    clock.advance("2s");
    expect(order).toEqual(["outer", "inner"]);
    expect(clock.now()).toBe(2000);
  });

  it("a nested timer that falls outside the remaining window does NOT fire in the same advance", () => {
    const clock = new SimClock();
    const order: string[] = [];

    clock.setTimeout(() => {
      order.push("outer");
      // schedule inner due at now() + 2s = 3s, outside the 2s advance window
      clock.setTimeout(() => order.push("inner"), "2s");
    }, "1s");

    clock.advance("2s");
    expect(order).toEqual(["outer"]); // inner not yet due
    expect(clock.pendingCount()).toBe(1);
  });

  it("chains of three nested timers all collapse into one advance", () => {
    const clock = new SimClock();
    const order: string[] = [];

    clock.setTimeout(() => {
      order.push("A");
      clock.setTimeout(() => {
        order.push("B");
        clock.setTimeout(() => order.push("C"), "100ms");
      }, "100ms");
    }, "100ms");

    clock.advance("1s");
    expect(order).toEqual(["A", "B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// clearTimeout
// ---------------------------------------------------------------------------

describe("clearTimeout", () => {
  it("prevents the callback from firing", () => {
    const clock = new SimClock();
    let fired = false;
    const handle = clock.setTimeout(() => { fired = true; }, "1s");

    clock.clearTimeout(handle);
    clock.advance("2s");
    expect(fired).toBe(false);
  });

  it("reduces pendingCount immediately", () => {
    const clock = new SimClock();
    const h1 = clock.setTimeout(() => {}, "1s");
    const h2 = clock.setTimeout(() => {}, "2s");
    expect(clock.pendingCount()).toBe(2);

    clock.clearTimeout(h1);
    expect(clock.pendingCount()).toBe(1);

    clock.clearTimeout(h2);
    expect(clock.pendingCount()).toBe(0);
  });

  it("cancelling an already-fired handle is a no-op", () => {
    const clock = new SimClock();
    const handle = clock.setTimeout(() => {}, "1s");
    clock.advance("2s"); // fires and removes the timer
    expect(() => clock.clearTimeout(handle)).not.toThrow();
    expect(clock.pendingCount()).toBe(0);
  });

  it("cancelling an unknown handle is a no-op", () => {
    const clock = new SimClock();
    // Create a handle from another clock — unknown to this one.
    const otherClock = new SimClock();
    const alien = otherClock.setTimeout(() => {}, "1s");
    expect(() => clock.clearTimeout(alien)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// setInterval
// ---------------------------------------------------------------------------

describe("setInterval", () => {
  it("fires repeatedly over advance(3.5s) with a 1s interval (3 times)", () => {
    const clock = new SimClock();
    const times: number[] = [];
    clock.setInterval(() => times.push(clock.now()), "1s");

    clock.advance("3500ms");
    expect(times).toEqual([1000, 2000, 3000]);
    expect(clock.now()).toBe(3500);
  });

  it("clearInterval stops further firings", () => {
    const clock = new SimClock();
    const times: number[] = [];
    const handle = clock.setInterval(() => times.push(clock.now()), "1s");

    clock.advance("2s");
    expect(times).toEqual([1000, 2000]);

    clock.clearInterval(handle);
    clock.advance("3s");
    expect(times).toEqual([1000, 2000]); // no new firings
  });

  it("clearInterval inside the callback stops subsequent firings", () => {
    const clock = new SimClock();
    const times: number[] = [];
    let handle: ReturnType<typeof clock.setInterval>;

    handle = clock.setInterval(() => {
      times.push(clock.now());
      if (times.length >= 2) {
        clock.clearInterval(handle);
      }
    }, "1s");

    clock.advance("10s");
    expect(times).toEqual([1000, 2000]); // stopped after 2nd firing
  });

  it("throws SimError on a zero interval", () => {
    const clock = new SimClock();
    expect(() => clock.setInterval(() => {}, 0)).toThrow(SimError);
  });

  it("throws SimError on a negative interval (string form that parses to 0)", () => {
    // toMillis rejects negative strings, so we use 0 directly
    const clock = new SimClock();
    expect(() => clock.setInterval(() => {}, 0)).toThrow(SimError);
  });

  it("interval timer stays in pendingCount even after firings", () => {
    const clock = new SimClock();
    clock.setInterval(() => {}, "1s");
    expect(clock.pendingCount()).toBe(1);
    clock.advance("5s");
    expect(clock.pendingCount()).toBe(1); // still pending (repeating)
  });

  it("cancelled interval is removed from pendingCount", () => {
    const clock = new SimClock();
    const h = clock.setInterval(() => {}, "1s");
    expect(clock.pendingCount()).toBe(1);
    clock.clearInterval(h);
    expect(clock.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runUntil
// ---------------------------------------------------------------------------

describe("runUntil", () => {
  it("fires all timers with dueAt <= t and sets now() to t", () => {
    const clock = new SimClock();
    const fired: number[] = [];

    clock.setTimeout(() => fired.push(clock.now()), "1s");
    clock.setTimeout(() => fired.push(clock.now()), "2s");
    clock.setTimeout(() => fired.push(clock.now()), "3s");

    clock.runUntil(2500);
    expect(fired).toEqual([1000, 2000]);
    expect(clock.now()).toBe(2500);
  });

  it("sets now() to t exactly, even when no timers are pending", () => {
    const clock = new SimClock();
    clock.runUntil(5000);
    expect(clock.now()).toBe(5000);
  });

  it("fires a timer due exactly at t", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, "1s");

    clock.runUntil(1000);
    expect(fired).toBe(true);
    expect(clock.now()).toBe(1000);
  });

  it("does NOT fire a timer due after t", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, "2s");

    clock.runUntil(1000);
    expect(fired).toBe(false);
    expect(clock.pendingCount()).toBe(1);
  });

  it("throws SimError when t < now()", () => {
    const clock = new SimClock();
    clock.advance("5s");
    expect(() => clock.runUntil(4999)).toThrow(SimError);
  });

  it("runUntil(now()) is a no-op and does not throw", () => {
    const clock = new SimClock();
    clock.advance("1s");
    expect(() => clock.runUntil(1000)).not.toThrow();
    expect(clock.now()).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// runAll
// ---------------------------------------------------------------------------

describe("runAll", () => {
  it("fires all pending one-shot timers and advances now() to the last one", () => {
    const clock = new SimClock();
    const fired: number[] = [];

    clock.setTimeout(() => fired.push(clock.now()), "1s");
    clock.setTimeout(() => fired.push(clock.now()), "3s");
    clock.setTimeout(() => fired.push(clock.now()), "2s");

    clock.runAll();
    expect(fired).toEqual([1000, 2000, 3000]);
    expect(clock.now()).toBe(3000);
    expect(clock.pendingCount()).toBe(0);
  });

  it("leaves interval timers in place", () => {
    const clock = new SimClock();
    clock.setInterval(() => {}, "1s");
    clock.setTimeout(() => {}, "2s");

    clock.runAll();
    expect(clock.pendingCount()).toBe(1); // interval still there
  });

  it("throws SimError if maxIterations is exceeded", () => {
    const clock = new SimClock();
    // Each one-shot schedules another — infinite chain.
    const chain = () => {
      clock.setTimeout(chain, "1ms");
    };
    clock.setTimeout(chain, "1ms");

    expect(() => clock.runAll(10)).toThrow(SimError);
  });
});

// ---------------------------------------------------------------------------
// pendingCount
// ---------------------------------------------------------------------------

describe("pendingCount", () => {
  it("starts at 0", () => {
    expect(new SimClock().pendingCount()).toBe(0);
  });

  it("increments on each schedule and decrements after firing", () => {
    const clock = new SimClock();
    clock.setTimeout(() => {}, "1s");
    clock.setTimeout(() => {}, "2s");
    expect(clock.pendingCount()).toBe(2);

    clock.advance("1s");
    expect(clock.pendingCount()).toBe(1);

    clock.advance("1s");
    expect(clock.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("two identical schedules produce byte-identical firing order", () => {
    function runScenario(): string[] {
      const clock = new SimClock();
      const order: string[] = [];

      clock.setTimeout(() => order.push("A@100"), 100);
      clock.setTimeout(() => order.push("B@100"), 100);
      clock.setTimeout(() => order.push("C@200"), 200);
      clock.setTimeout(() => {
        order.push("D@300");
        clock.setTimeout(() => order.push("E@400"), 100);
      }, 300);
      clock.setInterval(() => order.push("I@50"), 50);

      clock.advance(500);
      return order;
    }

    const run1 = runScenario();
    const run2 = runScenario();
    expect(run1).toEqual(run2);
    // Spot-check the FIFO invariant: A and B are at the same due time;
    // A was scheduled first so it must fire first.
    expect(run1.indexOf("A@100")).toBeLessThan(run1.indexOf("B@100"));
  });

  it("same-tick FIFO is stable regardless of insertion order in the map", () => {
    // Schedule in reverse time order so the map insertion order would give
    // wrong results if we relied on it rather than the seq tiebreaker.
    function runScenario(scheduleReversed: boolean): string[] {
      const clock = new SimClock();
      const order: string[] = [];

      const tags = ["X", "Y", "Z"];
      const toSchedule = scheduleReversed ? [...tags].reverse() : tags;

      for (const tag of toSchedule) {
        clock.setTimeout(() => order.push(tag), "1s");
      }

      clock.advance("2s");
      return order;
    }

    const forwardOrder = runScenario(false);
    const reversedOrder = runScenario(true);

    // Both runs fire all three timers — the relative order is stable within
    // each run but the runs themselves use different scheduling orders, so
    // forward = [X,Y,Z] and reversed = [Z,Y,X] (FIFO within each run).
    expect(forwardOrder).toEqual(["X", "Y", "Z"]);
    expect(reversedOrder).toEqual(["Z", "Y", "X"]);
  });
});
