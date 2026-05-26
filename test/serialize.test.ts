/**
 * Tests for `serializeWorld` / `loadWorld` / `serializeScenario` / `loadScenario`.
 *
 * Covers:
 * - World round-trip exact (hand-built world with low-battery node + private channel)
 * - Generated world freeze: serialize → load deep-equals original; idempotent
 * - Scenario round-trip exact, including TelemetryEvent with non-empty lppSensorData
 * - Frozen fixture drives the same assertions as its source (integration)
 * - Bad input: throws SimError on garbage / wrong format / wrong version
 */

import { describe, expect, it } from "vitest";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import { generateWorld } from "../src/generate.js";
import { at, scenario } from "../src/scenario.js";
import { burst } from "../src/traffic.js";
import {
  loadScenario,
  loadWorld,
  serializeScenario,
  serializeWorld,
} from "../src/serialize.js";
import { SimError } from "../src/errors.js";
import { ChannelKind } from "../src/world.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// World round-trip
// ---------------------------------------------------------------------------

describe("serializeWorld / loadWorld", () => {
  it("round-trip exact: loadWorld(serializeWorld(w)) deep-equals w", () => {
    const w = defineWorld({
      homeNodeId: "home",
      nodes: [
        node("home", { name: "Base Station" }),
        node("alpha", { name: "Alpha", battery: 12 }), // low battery
        node("bravo", { name: "Bravo", role: "repeater", reachable: false }),
      ],
      channels: [
        channel(0, "public"),
        channel(1, "ops", { kind: ChannelKind.Private }),
      ],
      contacts: [
        contact("Alpha", "alpha"),
        contact("Bravo", "bravo"),
      ],
    });

    const loaded = loadWorld(serializeWorld(w));
    expect(loaded).toEqual(w);
  });

  it("serialize is deterministic: same world produces the same string every time", () => {
    const w = defineWorld({
      homeNodeId: "home",
      nodes: [
        node("home"),
        node("peer", { battery: 75 }),
      ],
      channels: [channel(0, "public")],
      contacts: [contact("peer", "peer")],
    });
    const s1 = serializeWorld(w);
    const s2 = serializeWorld(w);
    expect(s1).toBe(s2);
  });

  it("serialized string is valid pretty-printed JSON with the expected envelope", () => {
    const w = defineWorld({ homeNodeId: "home" });
    const json = serializeWorld(w);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe("meshcore-sim/world");
    expect(parsed.version).toBe(1);
    expect(parsed.world).toBeDefined();
    // pretty-printed: contains newlines and indentation
    expect(json).toContain("\n");
  });

  it("loadWorld throws SimError on empty object / missing format", () => {
    expect(() => loadWorld("{}")).toThrow(SimError);
  });

  it("loadWorld throws SimError on wrong format", () => {
    const bad = JSON.stringify({
      format: "wrong/format",
      version: 1,
      world: {},
    });
    expect(() => loadWorld(bad)).toThrow(SimError);
  });

  it("loadWorld throws SimError on wrong version", () => {
    const bad = JSON.stringify({
      format: "meshcore-sim/world",
      version: 99,
      world: {},
    });
    expect(() => loadWorld(bad)).toThrow(SimError);
  });

  it("loadWorld throws SimError on non-JSON input", () => {
    expect(() => loadWorld("not json at all")).toThrow(SimError);
  });

  it("loadWorld throws SimError on wrong-format envelope (scenario fed to loadWorld)", () => {
    // A scenario JSON is not a world JSON
    const w = defineWorld({ homeNodeId: "home" });
    const scn = scenario([at(1000, { kind: "advert", nodeId: "home" })]);
    const scenarioJson = serializeScenario(scn);
    expect(() => loadWorld(scenarioJson)).toThrow(SimError);
  });

  it("loadWorld rejects a corrupt fixture whose homeNodeId is missing from nodes", () => {
    // Freeze a valid world, then tamper: drop the home node from the serialized
    // nodes. loadWorld must reject this rather than silently fabricate a fresh
    // default home node (which would replace the frozen home node's data).
    const w = defineWorld({
      homeNodeId: "home",
      nodes: [node("home", { battery: 5 }), node("rocky")],
    });
    const parsed = JSON.parse(serializeWorld(w));
    parsed.world.nodes = parsed.world.nodes.filter(
      (n: { id: string }) => n.id !== "home",
    );
    expect(() => loadWorld(JSON.stringify(parsed))).toThrow(SimError);
  });
});

// ---------------------------------------------------------------------------
// Generated world freeze
// ---------------------------------------------------------------------------

describe("generated world freeze", () => {
  it("serialize → load deep-equals the original generated world", () => {
    const original = generateWorld({ seed: 42, nodes: 8, repeaters: 2 });
    const loaded = loadWorld(serializeWorld(original));
    expect(loaded).toEqual(original);
  });

  it("serialize is idempotent: serialize → load → serialize yields the identical string", () => {
    const original = generateWorld({ seed: 99, nodes: 8, repeaters: 2 });
    const json1 = serializeWorld(original);
    const loaded = loadWorld(json1);
    const json2 = serializeWorld(loaded);
    expect(json2).toBe(json1);
  });
});

// ---------------------------------------------------------------------------
// Scenario round-trip
// ---------------------------------------------------------------------------

describe("serializeScenario / loadScenario", () => {
  it("round-trip exact: loadScenario(serializeScenario(s)) deep-equals s", () => {
    const s = scenario([
      at(1000, { kind: "message", from: "rocky", text: "hello" }),
      at(2000, { kind: "advert", nodeId: "rocky" }),
      at(3000, { kind: "nodeState", nodeId: "rocky", reachable: false }),
      at(4000, { kind: "channelMessage", channel: 0, text: "broadcast" }),
    ]);

    const loaded = loadScenario(serializeScenario(s));
    expect(loaded).toEqual(s);
  });

  it("round-trip with TelemetryEvent including non-empty lppSensorData (Uint8Array)", () => {
    // Create a TelemetryEvent with known sensor bytes
    const sensorBytes = new Uint8Array([0x01, 0x68, 0x2a, 0x02, 0x73, 0xff]);
    const s = scenario([
      at(500, { kind: "advert", nodeId: "home" }),
      at(1000, {
        kind: "telemetry",
        nodeId: "home",
        lppSensorData: sensorBytes,
      }),
      at(2000, { kind: "telemetry", nodeId: "home" }), // no lppSensorData
    ]);

    const loaded = loadScenario(serializeScenario(s));

    // The events must round-trip exactly
    expect(loaded.events).toHaveLength(3);

    // Verify Uint8Array bytes survive exactly
    const telEvent = loaded.events.find(
      (e) => e.event.kind === "telemetry" && e.event.lppSensorData !== undefined,
    );
    expect(telEvent).toBeDefined();
    if (telEvent?.event.kind === "telemetry" && telEvent.event.lppSensorData) {
      expect(telEvent.event.lppSensorData).toBeInstanceOf(Uint8Array);
      expect(Array.from(telEvent.event.lppSensorData)).toEqual(
        Array.from(sensorBytes),
      );
    }

    // Also verify full deep-equal (Uint8Array equality)
    expect(loaded).toEqual(s);
  });

  it("round-trip with empty lppSensorData (zero-length Uint8Array)", () => {
    const s = scenario([
      at(1000, { kind: "telemetry", nodeId: "home", lppSensorData: new Uint8Array(0) }),
    ]);
    const loaded = loadScenario(serializeScenario(s));
    expect(loaded).toEqual(s);
    const e = loaded.events[0];
    if (e?.event.kind === "telemetry") {
      expect(e.event.lppSensorData).toBeInstanceOf(Uint8Array);
      expect(e.event.lppSensorData?.length).toBe(0);
    }
  });

  it("serialize is deterministic: same scenario produces the same string", () => {
    const s = burst({ from: "rocky", count: 5, within: "10s", seed: 42 });
    expect(serializeScenario(s)).toBe(serializeScenario(s));
  });

  it("serialize is idempotent: serialize → load → serialize yields the identical string", () => {
    const s = burst({ from: "rocky", count: 5, within: "10s", seed: 42 });
    const json1 = serializeScenario(s);
    const json2 = serializeScenario(loadScenario(json1));
    expect(json2).toBe(json1);
  });

  it("serialized string has the expected envelope", () => {
    const s = scenario([at(1000, { kind: "advert", nodeId: "home" })]);
    const json = serializeScenario(s);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe("meshcore-sim/scenario");
    expect(parsed.version).toBe(1);
    expect(parsed.scenario).toBeDefined();
    expect(parsed.scenario.events).toBeInstanceOf(Array);
  });

  it("loadScenario throws SimError on empty object", () => {
    expect(() => loadScenario("{}")).toThrow(SimError);
  });

  it("loadScenario throws SimError on wrong format", () => {
    const bad = JSON.stringify({
      format: "wrong/format",
      version: 1,
      scenario: { events: [] },
    });
    expect(() => loadScenario(bad)).toThrow(SimError);
  });

  it("loadScenario throws SimError on wrong version", () => {
    const bad = JSON.stringify({
      format: "meshcore-sim/scenario",
      version: 2,
      scenario: { events: [] },
    });
    expect(() => loadScenario(bad)).toThrow(SimError);
  });

  it("loadScenario throws SimError on non-JSON input", () => {
    expect(() => loadScenario("{bad json")).toThrow(SimError);
  });

  it("loadScenario throws SimError when a world JSON is fed in", () => {
    const w = defineWorld({ homeNodeId: "home" });
    expect(() => loadScenario(serializeWorld(w))).toThrow(SimError);
  });
});

// ---------------------------------------------------------------------------
// Integration: frozen fixture drives the same assertions as its source
// ---------------------------------------------------------------------------

describe("frozen fixture replay", () => {
  /**
   * Run a world + scenario through SimConnection + MeshCoreClient and collect
   * observations: the number of contacts returned by getContacts() and the texts
   * of all contactMessage events delivered after advancing the clock.
   */
  async function runAndObserve(
    w: ReturnType<typeof defineWorld>,
    scn: ReturnType<typeof scenario>,
  ): Promise<{ contactCount: number; messageTexts: string[] }> {
    const clock = new SimClock();
    const sim = new SimConnection({ world: w, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    const messageCount = scn.events.filter((e) => e.event.kind === "message").length;
    const collected = messageCount > 0
      ? collectEvents(client, "contactMessage", messageCount)
      : Promise.resolve([]);

    clock.advance("15s");

    const messages = await collected;
    const contacts = await client.getContacts();

    return {
      contactCount: contacts.length,
      messageTexts: messages.map((m) => m.text),
    };
  }

  it("frozen world + scenario produces identical observations to the original", async () => {
    // Build the source world and scenario.
    const sourceWorld = generateWorld({ seed: 7, nodes: 5, repeaters: 1 });
    const sender = sourceWorld.nodes.find((n) => n.id !== sourceWorld.homeNodeId)!;
    const sourceScenario = burst({
      from: sender.id,
      count: 3,
      within: "10s",
      seed: 7,
    });

    // Collect observations from the source (live) fixtures.
    const sourceObs = await runAndObserve(sourceWorld, sourceScenario);

    // Serialize both to JSON, then deserialize ("freeze" and "thaw").
    const frozenWorld = loadWorld(serializeWorld(sourceWorld));
    const frozenScenario = loadScenario(serializeScenario(sourceScenario));

    // The frozen fixtures must deep-equal their sources.
    expect(frozenWorld).toEqual(sourceWorld);
    expect(frozenScenario).toEqual(sourceScenario);

    // Collect observations from the frozen fixtures.
    const frozenObs = await runAndObserve(frozenWorld, frozenScenario);

    // Identical behavior: same contact count and same messages in same order.
    expect(frozenObs.contactCount).toBe(sourceObs.contactCount);
    expect(frozenObs.messageTexts).toEqual(sourceObs.messageTexts);
  });

  it("contact count from frozen world matches contacts in the serialized world", async () => {
    const world = generateWorld({ seed: 13, nodes: 6, repeaters: 1 });
    const frozenWorld = loadWorld(serializeWorld(world));

    // The frozen world has the same contacts as the original.
    expect(frozenWorld.contacts.length).toBe(world.contacts.length);

    // And getContacts() through a SimConnection reflects those contacts.
    const clock = new SimClock();
    const sim = new SimConnection({ world: frozenWorld, clock });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    const contacts = await client.getContacts();
    expect(contacts.length).toBe(world.contacts.length);
  });
});
