import { describe, expect, it } from "vitest";
import { MeshCoreClient } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import { at, scenario } from "../src/scenario.js";
import type { Scenario } from "../src/scenario.js";
import { DEVICE_EPOCH_BASE_SECS } from "../src/encode.js";

/** Build a world + connected client, returning the `sim` for command-log reads. */
async function setup(scn?: Scenario): Promise<{
  client: MeshCoreClient;
  clock: SimClock;
  sim: SimConnection;
}> {
  const world = defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", radioConfig: { freq: 910_525, bw: 250, sf: 10, cr: 5, txPower: 22 } }),
      node("rocky", { name: "Rocky", role: "repeater" }),
      node("cedar", { name: "Cedar" }),
    ],
    channels: [channel(0, "public"), channel(1, "ops", { kind: "private" })],
    contacts: [contact("Rocky", "rocky"), contact("Cedar", "cedar")],
  });
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, scenario: scn });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  await client.connect();
  return { client, clock, sim };
}

describe("Observable writes — config mutations reflected by getSelfInfo", () => {
  it("setTxPower changes the reported tx power", async () => {
    const { client } = await setup();
    expect((await client.getSelfInfo()).txPower).toBe(22);

    await client.setTxPower(15);
    expect((await client.getSelfInfo()).txPower).toBe(15);
  });

  it("setRadioParams changes the reported radio config", async () => {
    const { client } = await setup();
    await client.setRadioParams(869_525, 125, 11, 6);

    const self = await client.getSelfInfo();
    expect(self.radioFreq).toBe(869_525);
    expect(self.radioBw).toBe(125);
    expect(self.radioSf).toBe(11);
    expect(self.radioCr).toBe(6);
  });

  it("setAdvertName changes the reported name", async () => {
    const { client } = await setup();
    expect((await client.getSelfInfo()).name).toBe("Base");

    await client.setAdvertName("Relay 1");
    expect((await client.getSelfInfo()).name).toBe("Relay 1");
  });

  it("setAdvertLatLong changes the reported position (micro-degrees)", async () => {
    const { client } = await setup();
    await client.setAdvertLatLong(47.62, -122.35);

    const self = await client.getSelfInfo();
    expect(self.advLat).toBe(Math.round(47.62 * 1e6));
    expect(self.advLon).toBe(Math.round(-122.35 * 1e6));
  });

  it("mutations do not leak into a world reused by another connection", async () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home", { name: "Base", radioConfig: { freq: 910_525, bw: 250, sf: 10, cr: 5, txPower: 22 } })],
    });
    const simA = new SimConnection({ world, clock: new SimClock() });
    const clientA = new MeshCoreClient(simA.asConnection());
    await clientA.connect();
    await clientA.setTxPower(5);
    expect((await clientA.getSelfInfo()).txPower).toBe(5);

    // A second connection from the same world object is unaffected.
    const simB = new SimConnection({ world, clock: new SimClock() });
    const clientB = new MeshCoreClient(simB.asConnection());
    await clientB.connect();
    expect((await clientB.getSelfInfo()).txPower).toBe(22);
  });
});

describe("Observable writes — the received-command log", () => {
  it("records a config command with its decoded args", async () => {
    const { client, sim } = await setup();
    await client.setTxPower(20);

    expect(sim.commandsOf("setTxPower")).toEqual([
      { method: "setTxPower", args: { txPower: 20 }, at: 0 },
    ]);
  });

  it("records commands in order, each stamped at the virtual time it arrived", async () => {
    const { client, clock, sim } = await setup();

    await client.setTxPower(20);
    clock.advance("5s");
    await client.setRadioParams(869_525, 125, 11, 6);

    expect(sim.commandLog.map((c) => [c.method, c.at])).toEqual([
      ["setTxPower", 0],
      ["setRadioParams", 5000],
    ]);
  });

  it("records a send (with the resolved destination node id)", async () => {
    const { client, sim } = await setup();
    const rocky = await client.findContactByName("Rocky");
    await client.sendTextMessage(rocky!, "hi");

    expect(sim.commandsOf("sendTextMessage")[0]).toMatchObject({
      method: "sendTextMessage",
      args: { to: "rocky", text: "hi" },
    });
  });

  it("records sendAdvert and reboot (actions with no modeled world change)", async () => {
    const { client, sim } = await setup();
    await client.sendAdvert(1);
    await client.reboot();

    expect(sim.commandLog.map((c) => c.method)).toEqual(["sendAdvert", "reboot"]);
    expect(sim.commandsOf("sendAdvert")[0]!.args).toEqual({ type: 1 });
  });

  it("does not record reads", async () => {
    const { client, sim } = await setup();
    await client.getSelfInfo();
    await client.getContacts();
    await client.getChannels();

    expect(sim.commandLog).toHaveLength(0);
  });
});

describe("Observable writes — last-heard on the contact roster", () => {
  it("reflects when a node was last heard, not when the roster was read", async () => {
    // rocky advertises at +10s; cedar stays quiet. Read at +20s.
    const scn = scenario([at("10s", { kind: "advert", nodeId: "rocky" })]);
    const { client, clock } = await setup(scn);

    await clock.advanceAsync("20s");
    const contacts = await client.getContacts();
    const rocky = contacts.find((c) => c.advName === "Rocky")!;
    const cedar = contacts.find((c) => c.advName === "Cedar")!;

    // rocky was heard at 10s — its lastAdvert is stamped there, NOT at the 20s
    // read time (which the old read-time-now behavior would have shown).
    expect(rocky.lastAdvert.getTime()).toBe((DEVICE_EPOCH_BASE_SECS + 10) * 1000);
    // cedar never emitted — it falls back to the connect-time baseline (0s).
    expect(cedar.lastAdvert.getTime()).toBe(DEVICE_EPOCH_BASE_SECS * 1000);
    // …so the quiet node reads as the staler of the two.
    expect(cedar.lastAdvert.getTime()).toBeLessThan(rocky.lastAdvert.getTime());
  });

  it("a direct message also updates the sender's last-heard", async () => {
    const scn = scenario([at("8s", { kind: "message", from: "cedar", text: "hello" })]);
    const { client, clock } = await setup(scn);

    await clock.advanceAsync("15s");
    const contacts = await client.getContacts();
    const cedar = contacts.find((c) => c.advName === "Cedar")!;

    expect(cedar.lastAdvert.getTime()).toBe((DEVICE_EPOCH_BASE_SECS + 8) * 1000);
  });
});
