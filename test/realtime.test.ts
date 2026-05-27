import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SimClock } from "../src/clock.js";
import { RealtimeClock } from "../src/realtime.js";
import { SimError } from "../src/errors.js";

// The RealtimeClock is the one piece backed by real `setInterval` / `Date.now`,
// so drive it with vitest fake timers to keep these tests deterministic.
describe("RealtimeClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the SimClock by elapsed wall time as real time passes", () => {
    const clock = new SimClock();
    const rt = new RealtimeClock(clock, { step: "250ms" }).start();

    vi.advanceTimersByTime(1000);
    expect(clock.now()).toBe(1000);

    rt.stop();
  });

  it("fires a SimClock timer once enough wall time elapses", () => {
    const clock = new SimClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, "500ms");

    const rt = new RealtimeClock(clock, { step: "100ms" }).start();

    vi.advanceTimersByTime(400);
    expect(fired).toBe(false); // not yet

    vi.advanceTimersByTime(200); // crosses 500ms
    expect(fired).toBe(true);

    rt.stop();
  });

  it("scale runs simulated time faster than wall time", () => {
    const clock = new SimClock();
    const rt = new RealtimeClock(clock, { step: "100ms", scale: 10 }).start();

    vi.advanceTimersByTime(1000); // 1s of wall time
    expect(clock.now()).toBe(10_000); // 10s of simulated time

    rt.stop();
  });

  it("stop() halts advancement", () => {
    const clock = new SimClock();
    const rt = new RealtimeClock(clock, { step: "100ms" }).start();

    vi.advanceTimersByTime(300);
    expect(clock.now()).toBe(300);

    rt.stop();
    vi.advanceTimersByTime(1000);
    expect(clock.now()).toBe(300); // unchanged after stop
  });

  it("start() is idempotent — a second call does not double-pump", () => {
    const clock = new SimClock();
    const rt = new RealtimeClock(clock, { step: "100ms" }).start();
    rt.start(); // no-op

    vi.advanceTimersByTime(500);
    expect(clock.now()).toBe(500); // not 1000

    rt.stop();
  });

  it("exposes a running flag", () => {
    const clock = new SimClock();
    const rt = new RealtimeClock(clock, { step: "100ms" });
    expect(rt.running).toBe(false);

    rt.start();
    expect(rt.running).toBe(true);

    rt.stop();
    expect(rt.running).toBe(false);
  });

  it("rejects a non-positive step or scale", () => {
    const clock = new SimClock();
    expect(() => new RealtimeClock(clock, { step: 0 })).toThrow(SimError);
    expect(() => new RealtimeClock(clock, { scale: 0 })).toThrow(SimError);
    expect(() => new RealtimeClock(clock, { scale: -1 })).toThrow(SimError);
  });
});
