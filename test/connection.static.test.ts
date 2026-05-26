import { describe, expect, it } from "vitest";
import { MeshCoreClient, MeshCoreError } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";

/** Build a small world + a connected `MeshCoreClient` over a `SimConnection`. */
async function setup(): Promise<{ client: MeshCoreClient; clock: SimClock }> {
  const world = defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base", battery: 80 }),
      node("rocky-ridge", { name: "Rocky", role: "repeater", battery: 12 }),
      node("dead-node", { name: "Dead", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(1, "ops", { kind: "private" })],
    contacts: [contact("Rocky", "rocky-ridge"), contact("Dead", "dead-node")],
  });
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: false });
  await client.connect();
  return { client, clock };
}

describe("SimConnection driven through a real MeshCoreClient", () => {
  it("connect() resolves once the connected event fires", async () => {
    // setup() awaits client.connect(); reaching here proves it resolved.
    const { client } = await setup();
    expect(client).toBeInstanceOf(MeshCoreClient);
  });

  it("getSelfInfo() returns the home node's name, hex key, and radio config", async () => {
    const { client } = await setup();
    const self = await client.getSelfInfo();
    expect(self.name).toBe("Base");
    expect(self.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(self.radioFreq).toBe(910_525);
    expect(self.radioBw).toBe(250);
    expect(self.radioSf).toBe(10);
    expect(self.radioCr).toBe(5);
  });

  it("getContacts() returns the world's contacts with hex keys and advNames", async () => {
    const { client } = await setup();
    const contacts = await client.getContacts();
    const names = contacts.map((c) => c.advName).sort();
    expect(names).toEqual(["Dead", "Rocky"]);
    for (const c of contacts) {
      expect(c.publicKey).toMatch(/^[0-9a-f]{64}$/);
    }
    const rocky = contacts.find((c) => c.advName === "Rocky");
    expect(rocky?.type).toBe(2); // AdvType.Repeater
  });

  it("findContactByName resolves a known contact and undefined for unknown", async () => {
    const { client } = await setup();
    const rocky = await client.findContactByName("Rocky");
    expect(rocky?.advName).toBe("Rocky");
    const missing = await client.findContactByName("Nobody");
    expect(missing).toBeUndefined();
  });

  it("getChannels() returns both channels with correct idx and name", async () => {
    const { client } = await setup();
    const channels = await client.getChannels();
    expect(channels.map((c) => [c.channelIdx, c.name])).toEqual([
      [0, "public"],
      [1, "ops"],
    ]);
  });

  it("getBatteryVoltage() reflects the home node's battery", async () => {
    const { client } = await setup();
    const battery = await client.getBatteryVoltage();
    // 80% on the 3000..4200 mV model = 3960 mV.
    expect(battery.milliVolts).toBe(3960);
    expect(battery.volts).toBeCloseTo(3.96);
  });

  it("getStatus(reachable repeater) returns plausible RepeaterStats", async () => {
    const { client } = await setup();
    const rocky = await client.findContactByName("Rocky");
    expect(rocky).toBeDefined();
    const stats = await client.getStatus(rocky!);
    // 12% on the model = 3000 + 1200*0.12 = 3144 mV.
    expect(stats.batteryMilliVolts).toBe(3144);
    expect(stats.currTxQueueLen).toBe(0);
  });

  it("getStatus(unreachable) rejects with a MeshCoreError", async () => {
    const { client } = await setup();
    const dead = await client.findContactByName("Dead");
    expect(dead).toBeDefined();
    await expect(client.getStatus(dead!)).rejects.toBeInstanceOf(MeshCoreError);
  });

  it("getDeviceTime() reflects the virtual clock deterministically", async () => {
    const { client, clock } = await setup();
    const t0 = await client.getDeviceTime();
    clock.advance("30s");
    const t1 = await client.getDeviceTime();
    expect(t1.getTime() - t0.getTime()).toBe(30_000);
  });
});
