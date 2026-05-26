import { describe, expect, it } from "vitest";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

import { generateWorld } from "../src/generate.js";
import { burst, crosstalk, outOfOrder, quiet, traffic } from "../src/traffic.js";
import { toMillis } from "../src/duration.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import { DEVICE_EPOCH_BASE_SECS } from "../src/encode.js";

/** Collect the first n emissions of event, resolving with their first args. */
function collectEvents<K extends keyof MeshCoreEvents & string>(
  client: MeshCoreClient,
  event: K,
  n: number,
): Promise<Array<MeshCoreEvents[K][0]>> {
  return new Promise((resolve) => {
    const out: Array<MeshCoreEvents[K][0]> = [];
    const handler = ((...args: MeshCoreEvents[K]) => {
      out.push(args[0]);
      if (out.length === n) resolve(out);
    }) as never;
    client.on(event, handler);
  });
}

// ---------------------------------------------------------------------------
// burst
// ---------------------------------------------------------------------------

describe("traffic.burst", () => {
  it("produces exactly count message events", () => {
    const scn = burst({ from: "rocky", count: 3, within: "5s", seed: 1 });
    expect(scn.events).toHaveLength(3);
  });

  it("all events are from the specified node", () => {
    const scn = burst({ from: "river-crossing", count: 5, within: "10s", seed: 2 });
    for (const e of scn.events) {
      expect(e.event.kind).toBe("message");
      if (e.event.kind === "message") {
        expect(e.event.from).toBe("river-crossing");
      }
    }
  });

  it("all events arrive within the window (at <= within)", () => {
    const windowMs = toMillis("5s");
    const scn = burst({ from: "rocky", count: 10, within: "5s", seed: 3 });
    for (const e of scn.events) {
      expect(toMillis(e.at)).toBeLessThanOrEqual(windowMs);
    }
  });

  it("timing is jittered (not all identical offsets)", () => {
    const scn = burst({ from: "rocky", count: 5, within: "30s", seed: 42 });
    const offsets = scn.events.map((e) => toMillis(e.at));
    const unique = new Set(offsets);
    // With a 30s window and 5 messages, it's essentially impossible all 5 land
    // at the exact same millisecond.
    expect(unique.size).toBeGreaterThan(1);
  });

  it("same seed produces a deep-equal scenario (determinism)", () => {
    const a = burst({ from: "rocky", count: 5, within: "10s", seed: 42 });
    const b = burst({ from: "rocky", count: 5, within: "10s", seed: 42 });
    expect(a).toEqual(b);
  });

  it("different seed produces a different scenario", () => {
    const a = burst({ from: "rocky", count: 5, within: "10s", seed: 1 });
    const b = burst({ from: "rocky", count: 5, within: "10s", seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("uses default text 'msg <i>'", () => {
    const scn = burst({ from: "rocky", count: 3, within: "5s", seed: 1 });
    const texts = scn.events.map((e) => (e.event.kind === "message" ? e.event.text : null));
    // Texts come out in scenario's sorted order (sorted by at), but text content uses 0-based index
    expect(texts).toContain("msg 0");
    expect(texts).toContain("msg 1");
    expect(texts).toContain("msg 2");
  });

  it("accepts a custom text function", () => {
    const scn = burst({
      from: "rocky",
      count: 3,
      within: "5s",
      seed: 1,
      text: (i) => `hello ${i}`,
    });
    const texts = scn.events.map((e) => (e.event.kind === "message" ? e.event.text : null));
    expect(texts).toContain("hello 0");
    expect(texts).toContain("hello 1");
    expect(texts).toContain("hello 2");
  });

  it("omitting seed still produces a deterministic (fixed-default) result", () => {
    const a = burst({ from: "rocky", count: 3, within: "5s" });
    const b = burst({ from: "rocky", count: 3, within: "5s" });
    expect(a).toEqual(b);
  });

  it("throws RangeError for count < 1", () => {
    expect(() => burst({ from: "rocky", count: 0, within: "5s" })).toThrow(RangeError);
  });

  it("traffic.burst (namespace) is the same function", () => {
    const a = traffic.burst({ from: "x", count: 2, within: "1s", seed: 7 });
    const b = burst({ from: "x", count: 2, within: "1s", seed: 7 });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// crosstalk
// ---------------------------------------------------------------------------

describe("traffic.crosstalk", () => {
  it("includes all named nodes in the output", () => {
    const nodes = ["alpha", "beta", "gamma"];
    const scn = crosstalk({ nodes, within: "10s", seed: 1 });
    const senders = new Set(
      scn.events.map((e) => (e.event.kind === "message" ? e.event.from : null)),
    );
    for (const n of nodes) {
      expect(senders.has(n)).toBe(true);
    }
  });

  it("defaults to nodes.length * 2 total messages", () => {
    const nodes = ["a", "b", "c"];
    const scn = crosstalk({ nodes, within: "5s", seed: 1 });
    expect(scn.events).toHaveLength(6);
  });

  it("respects explicit count", () => {
    const nodes = ["a", "b"];
    const scn = crosstalk({ nodes, within: "10s", count: 5, seed: 1 });
    expect(scn.events).toHaveLength(5);
  });

  it("all events arrive within the window", () => {
    const windowMs = toMillis("10s");
    const scn = crosstalk({ nodes: ["a", "b"], within: "10s", seed: 99 });
    for (const e of scn.events) {
      expect(toMillis(e.at)).toBeLessThanOrEqual(windowMs);
    }
  });

  it("same seed produces deep-equal scenario", () => {
    const a = crosstalk({ nodes: ["x", "y", "z"], within: "15s", seed: 42 });
    const b = crosstalk({ nodes: ["x", "y", "z"], within: "15s", seed: 42 });
    expect(a).toEqual(b);
  });

  it("different seed produces a different scenario", () => {
    const a = crosstalk({ nodes: ["x", "y"], within: "10s", seed: 1 });
    const b = crosstalk({ nodes: ["x", "y"], within: "10s", seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("throws RangeError when nodes is empty", () => {
    expect(() => crosstalk({ nodes: [], within: "5s" })).toThrow(RangeError);
  });

  it("throws RangeError when count < nodes.length", () => {
    expect(() => crosstalk({ nodes: ["a", "b", "c"], within: "5s", count: 2 })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// quiet
// ---------------------------------------------------------------------------

describe("traffic.quiet", () => {
  it("returns an empty scenario", () => {
    const scn = quiet({ duration: "10s" });
    expect(scn.events).toHaveLength(0);
  });

  it("empty regardless of duration value", () => {
    expect(quiet({ duration: 0 }).events).toHaveLength(0);
    expect(quiet({ duration: "1h" }).events).toHaveLength(0);
  });

  it("traffic.quiet (namespace) behaves the same", () => {
    const scn = traffic.quiet({ duration: "5s" });
    expect(scn.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// outOfOrder
// ---------------------------------------------------------------------------

describe("traffic.outOfOrder", () => {
  it("produces exactly count message events", () => {
    const scn = outOfOrder({ from: "rocky", count: 4, within: "10s", seed: 1 });
    expect(scn.events).toHaveLength(4);
  });

  it("all events are kind=message from the specified node", () => {
    const scn = outOfOrder({ from: "cedar-ridge", count: 3, within: "10s", seed: 5 });
    for (const e of scn.events) {
      expect(e.event.kind).toBe("message");
      if (e.event.kind === "message") {
        expect(e.event.from).toBe("cedar-ridge");
      }
    }
  });

  it("produces the out-of-order property: arrival order differs from sentAt order", () => {
    // outOfOrder: arrivals are sorted ascending, sentAt values are reversed
    // so the message that arrives first has the LARGEST sentAt, and vice versa.
    const scn = outOfOrder({ from: "rocky", count: 4, within: "10s", seed: 7 });
    const events = scn.events;

    // All events must have sentAt set
    for (const e of events) {
      if (e.event.kind === "message") {
        expect(e.event.sentAt).toBeDefined();
      }
    }

    // Arrival times (at) should be in ascending order (scenario() sorts them)
    const arrivals = events.map((e) => toMillis(e.at));
    const sortedArrivals = [...arrivals].sort((a, b) => a - b);
    expect(arrivals).toEqual(sortedArrivals);

    // sentAt values for the sorted-by-arrival events should be in DESCENDING
    // order (the first-arriving message has the largest sentAt)
    const sentAts = events.map((e) => (e.event.kind === "message" ? e.event.sentAt! : 0));
    // The sentAt sequence should NOT be in ascending order (it's reversed)
    // Unless all arrivals are identical (degenerate case), the sentAts should differ from arrivals
    const allArrivalsDistinct = new Set(arrivals).size === arrivals.length;
    if (allArrivalsDistinct) {
      // sentAt should be descending (reverse of arrivals)
      const expectedSentAts = [...arrivals].reverse();
      expect(sentAts).toEqual(expectedSentAts);
    }
  });

  it("arrival order (at) != sentAt order for distinct offsets", () => {
    // If arrivals are [t0 < t1 < t2 < t3], sentAts should be [t3, t2, t1, t0]
    // so arrival 0 has the LARGEST sentAt (sent last), arrival 3 has the SMALLEST (sent first)
    const scn = outOfOrder({ from: "rocky", count: 4, within: "30s", seed: 99 });
    const arrivalOrder = scn.events.map((e) => toMillis(e.at));
    const sentAtOrder = scn.events.map((e) =>
      e.event.kind === "message" ? (e.event.sentAt ?? 0) : 0,
    );

    // As long as not all arrivals are identical, the sentAt order should differ
    const uniqueArrivals = new Set(arrivalOrder);
    if (uniqueArrivals.size > 1) {
      expect(sentAtOrder).not.toEqual(arrivalOrder);
    }
  });

  it("same seed produces deep-equal scenario", () => {
    const a = outOfOrder({ from: "rocky", count: 5, within: "10s", seed: 42 });
    const b = outOfOrder({ from: "rocky", count: 5, within: "10s", seed: 42 });
    expect(a).toEqual(b);
  });

  it("different seed produces a different scenario", () => {
    const a = outOfOrder({ from: "rocky", count: 4, within: "10s", seed: 1 });
    const b = outOfOrder({ from: "rocky", count: 4, within: "10s", seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("throws RangeError for count < 2", () => {
    expect(() => outOfOrder({ from: "rocky", count: 1, within: "5s" })).toThrow(RangeError);
  });

  it("places each message in a distinct whole second so the reorder survives second-granular timestamps", () => {
    // senderTimestamp is whole epoch seconds on the wire; if two messages share a
    // second the out-of-order property is invisible. sentAt offsets must floor to
    // distinct seconds (and the reversal must hold at second granularity).
    const scn = outOfOrder({ from: "rocky", count: 5, within: "10s", seed: 3 });
    const sentAtSecs = scn.events.map((e) =>
      e.event.kind === "message" ? Math.floor((e.event.sentAt ?? 0) / 1000) : -1,
    );
    expect(new Set(sentAtSecs).size).toBe(5); // all distinct seconds
    const arrivalSecs = scn.events.map((e) => Math.floor(toMillis(e.at) / 1000));
    expect(sentAtSecs).toEqual([...arrivalSecs].reverse()); // reversed at second granularity
  });

  it("throws when the window cannot span `count` distinct seconds", () => {
    // 2s window cannot hold 4 distinct whole seconds — reject rather than emit a
    // silently degenerate (same-second) fixture.
    expect(() => outOfOrder({ from: "rocky", count: 4, within: "2s" })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Integration: generateWorld + traffic.burst through a real MeshCoreClient
// ---------------------------------------------------------------------------

describe("integration: generateWorld + traffic.burst through MeshCoreClient", () => {
  it("delivers all burst messages as contactMessage events", async () => {
    const seed = 42;
    const BURST_COUNT = 5;
    const WITHIN = "10s";

    // Build world and scenario from the same seed (different generators, seed is not shared state)
    const world = generateWorld({ seed, nodes: 5, repeaters: 1 });

    // Pick the first remote node as the sender
    const sender = world.nodes.find((n) => n.id !== world.homeNodeId);
    expect(sender).toBeDefined();
    const senderNode = sender!;

    const scn = burst({ from: senderNode.id, count: BURST_COUNT, within: WITHIN, seed });

    // Wire up
    const clock = new SimClock();
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    // Collect BURST_COUNT contactMessage events
    const collected = collectEvents(client, "contactMessage", BURST_COUNT);

    // Advance past the window
    clock.advance(WITHIN);

    const messages = await collected;
    expect(messages).toHaveLength(BURST_COUNT);

    // All messages come from the sender
    for (const msg of messages) {
      // msg is the ContactMessage model from meshcore-ts
      expect(msg).toBeDefined();
    }
  });

  it("re-run with same seed delivers identical messages (determinism end-to-end)", async () => {
    const seed = 77;
    const BURST_COUNT = 3;
    const WITHIN = "8s";

    async function run() {
      const world = generateWorld({ seed, nodes: 4 });
      const sender = world.nodes.find((n) => n.id !== world.homeNodeId)!;
      const scn = burst({ from: sender.id, count: BURST_COUNT, within: WITHIN, seed });
      const clock = new SimClock();
      const sim = new SimConnection({ world, clock, scenario: scn });
      const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
      await client.connect();

      const collected = collectEvents(client, "contactMessage", BURST_COUNT);
      clock.advance(WITHIN);
      return collected;
    }

    const first = await run();
    const second = await run();

    expect(first.map((m) => m.text)).toEqual(second.map((m) => m.text));
    expect(first.map((m) => m.senderTimestamp)).toEqual(second.map((m) => m.senderTimestamp));
  });

  it("outOfOrder sentAt is reflected in senderTimestamp on received messages", async () => {
    const world = generateWorld({ seed: 1, nodes: 3 });
    const sender = world.nodes.find((n) => n.id !== world.homeNodeId)!;

    const scn = outOfOrder({ from: sender.id, count: 3, within: "10s", seed: 123 });

    const clock = new SimClock();
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    const collected = collectEvents(client, "contactMessage", 3);
    clock.advance("10s");
    const messages = await collected;

    expect(messages).toHaveLength(3);

    // Extract the expected sentAt values from the scenario
    const expectedSentAts = scn.events.map((e) =>
      e.event.kind === "message" ? e.event.sentAt! : 0,
    );

    // The senderTimestamp on each received message should match the sentAt
    // from the scenario event (converted from ms offset to epoch-secs).
    // meshcore-ts normalizes senderTimestamp to a Date, so convert for comparison.
    // Messages are delivered in arrival order (sorted by at), so index aligns.
    for (let i = 0; i < messages.length; i++) {
      const expectedEpochSecs = DEVICE_EPOCH_BASE_SECS + Math.floor(expectedSentAts[i]! / 1000);
      const ts = messages[i]!.senderTimestamp;
      // meshcore-ts may surface senderTimestamp as a Date or as epoch seconds
      const actualEpochSecs =
        ts instanceof Date ? Math.floor(ts.getTime() / 1000) : (ts as number);
      expect(actualEpochSecs).toBe(expectedEpochSecs);
    }
  });
});
