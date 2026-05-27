import { describe, expect, it } from "vitest";
import { MeshCoreClient, MeshCoreError, fromHex } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import { at, scenario } from "../src/scenario.js";
import type { Scenario } from "../src/scenario.js";

/**
 * Resolve with the payload of the next emission of `event` — the meshcore-ts
 * `nextEvent` helper (test/client.events.test.ts).
 */
function nextEvent<K extends keyof MeshCoreEvents & string>(
  client: MeshCoreClient,
  event: K,
): Promise<MeshCoreEvents[K]> {
  return new Promise((resolve) => {
    client.once(event, ((...args: MeshCoreEvents[K]) => resolve(args)) as never);
  });
}

/**
 * Resolve once `event` has been emitted `n` times, collecting each emission's
 * first argument in order. Used to await a whole burst.
 */
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

/** Build a world + a connected client (autoSync on) over the given scenario. */
async function setup(scn?: Scenario): Promise<{
  client: MeshCoreClient;
  clock: SimClock;
  world: ReturnType<typeof defineWorld>;
}> {
  const world = defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base" }),
      node("rocky", { name: "Rocky", role: "repeater" }),
      node("dead", { name: "Dead", role: "repeater" }),
    ],
    channels: [channel(0, "public"), channel(1, "ops", { kind: "private" })],
    contacts: [contact("Rocky", "rocky"), contact("Dead", "dead")],
  });
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, scenario: scn });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  await client.connect();
  return { client, clock, world };
}

describe("SimConnection dynamic scenario engine", () => {
  it("delivers a 3-message burst in send order via MsgWaiting + drain", async () => {
    const scn = scenario([
      at("1s", { kind: "message", from: "rocky", text: "first" }),
      at("3s", { kind: "message", from: "rocky", text: "second" }),
      at("7s", { kind: "message", from: "rocky", text: "third" }),
    ]);
    const { client, clock } = await setup(scn);

    const got = collectEvents(client, "contactMessage", 3);
    clock.advance("10s");
    const messages = await got;

    expect(messages.map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("drains a same-tick burst together, in order", async () => {
    // All three fire in a single advance() call; they enqueue before the first
    // drain's getWaitingMessages() resolves, so they drain together (FIFO).
    const scn = scenario([
      at("1s", { kind: "message", from: "rocky", text: "a" }),
      at("1s", { kind: "message", from: "rocky", text: "b" }),
      at("1s", { kind: "message", from: "rocky", text: "c" }),
    ]);
    const { client, clock } = await setup(scn);

    const got = collectEvents(client, "contactMessage", 3);
    clock.advance("2s");
    const messages = await got;

    expect(messages.map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  it("advanceAsync delivers a burst without pre-counting and preserves per-event timing", async () => {
    // The consumer pattern from issue #4: register a plain handler (no
    // pre-counted promise), advance once with advanceAsync, and read what
    // arrived. A single `await Promise.resolve()` here would under-deliver.
    const scn = scenario([
      at("1s", { kind: "message", from: "rocky", text: "first" }),
      at("4s", { kind: "message", from: "rocky", text: "second" }),
      at("8s", { kind: "message", from: "rocky", text: "third" }),
    ]);
    const { client, clock } = await setup(scn);

    const received: Array<{ text: string; at: number }> = [];
    client.on("contactMessage", (m) => received.push({ text: m.text, at: clock.now() }));

    await clock.advanceAsync("10s");

    expect(received.map((r) => r.text)).toEqual(["first", "second", "third"]);
    // Per-event timing is preserved: each message is stamped near its own
    // arrival step, not collapsed to the 10s window end. With the default
    // 250 ms step every arrival lands within one step of its scheduled time.
    expect(received[0]!.at).toBeLessThanOrEqual(1250);
    expect(received[1]!.at).toBeLessThanOrEqual(4250);
    expect(received[2]!.at).toBeLessThanOrEqual(8250);
    expect(clock.now()).toBe(10_000);
  });

  it("a contactMessage carries the sender's pubKeyPrefix", async () => {
    const scn = scenario([at("1s", { kind: "message", from: "rocky", text: "hi" })]);
    const { client, clock, world } = await setup(scn);

    const got = nextEvent(client, "contactMessage");
    clock.advance("2s");
    const [msg] = await got;

    const rocky = world.nodes.find((n) => n.id === "rocky")!;
    const expectedPrefix = Buffer.from(fromHex(rocky.publicKey).subarray(0, 6)).toString("hex");
    expect(msg.pubKeyPrefix).toBe(expectedPrefix);
    expect(msg.text).toBe("hi");
  });

  it("nodeState{reachable:false} takes a repeater offline mid-timeline", async () => {
    const scn = scenario([at("5s", { kind: "nodeState", nodeId: "rocky", reachable: false })]);
    const { client, clock, world } = await setup(scn);

    const rocky = world.nodes.find((n) => n.id === "rocky")!;
    const key = fromHex(rocky.publicKey);

    // Before the event: reachable, getStatus resolves.
    const before = await client.getStatus(key);
    expect(before.batteryMilliVolts).toBeGreaterThan(0);

    clock.advance("6s");

    // After the event: offline, getStatus rejects with a MeshCoreError.
    await expect(client.getStatus(key)).rejects.toBeInstanceOf(MeshCoreError);
  });

  it("nodeState{reachable:true} brings a node back online", async () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home"), node("rocky", { role: "repeater", reachable: false })],
      contacts: [contact("Rocky", "rocky")],
    });
    const clock = new SimClock();
    const scn = scenario([at("5s", { kind: "nodeState", nodeId: "rocky", reachable: true })]);
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    const key = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);
    await expect(client.getStatus(key)).rejects.toBeInstanceOf(MeshCoreError);

    clock.advance("6s");
    const after = await client.getStatus(key);
    expect(after.batteryMilliVolts).toBeGreaterThan(0);
  });

  it("sendTextMessage triggers a sendConfirmed event", async () => {
    const { client, world } = await setup();
    const rocky = world.nodes.find((n) => n.id === "rocky")!;

    const confirmed = nextEvent(client, "sendConfirmed");
    await client.sendTextMessage(fromHex(rocky.publicKey), "hi");
    const [ack] = await confirmed;
    expect(ack.ackCode).toBe(0);
  });

  it("advert and telemetry events surface as named client events", async () => {
    const scn = scenario([
      at("1s", { kind: "advert", nodeId: "rocky" }),
      at("2s", { kind: "telemetry", nodeId: "rocky" }),
    ]);
    const { client, clock, world } = await setup(scn);

    const advert = nextEvent(client, "advert");
    const telemetry = nextEvent(client, "telemetryResponse");
    clock.advance("3s");

    const [adv] = await advert;
    const rocky = world.nodes.find((n) => n.id === "rocky")!;
    expect(adv.publicKey).toBe(rocky.publicKey);

    const [tel] = await telemetry;
    const expectedPrefix = Buffer.from(fromHex(rocky.publicKey).subarray(0, 6)).toString("hex");
    expect(tel.pubKeyPrefix).toBe(expectedPrefix);
  });
});

describe("SimConnection does not mutate the caller's world (cross-test isolation)", () => {
  it("a nodeState event in one connection does not affect a world reused by another", async () => {
    // The idiomatic fixture pattern: build one world, reuse it across tests.
    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home"), node("rocky", { role: "repeater" })],
      contacts: [contact("Rocky", "rocky")],
    });
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    // Connection A runs a timeline that takes rocky offline.
    const clockA = new SimClock();
    const simA = new SimConnection({
      world,
      clock: clockA,
      scenario: scenario([at("1s", { kind: "nodeState", nodeId: "rocky", reachable: false })]),
    });
    const clientA = new MeshCoreClient(simA.asConnection(), { autoSync: true });
    await clientA.connect();
    clockA.advance("2s");
    await expect(clientA.getStatus(rockyKey)).rejects.toBeInstanceOf(MeshCoreError);

    // The shared world object must be untouched.
    expect(world.nodes.find((n) => n.id === "rocky")!.reachable).toBe(true);

    // Connection B, built from the same world, must see rocky still reachable.
    const simB = new SimConnection({ world, clock: new SimClock() });
    const clientB = new MeshCoreClient(simB.asConnection(), { autoSync: false });
    await clientB.connect();
    const stats = await clientB.getStatus(rockyKey);
    expect(stats.batteryMilliVolts).toBeGreaterThan(0);
  });
});
