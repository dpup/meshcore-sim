import { describe, expect, it } from "vitest";
import { MeshCoreClient, fromHex } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import { at, scenario } from "../src/scenario.js";
import type { Scenario } from "../src/scenario.js";

function nextEvent<K extends keyof MeshCoreEvents & string>(
  client: MeshCoreClient,
  event: K,
): Promise<MeshCoreEvents[K]> {
  return new Promise((resolve) => {
    client.once(event, ((...args: MeshCoreEvents[K]) => resolve(args)) as never);
  });
}

/** A world with a public "ops" channel (idx 1) and an admin channel index (idx 7). */
const ADMIN_CHANNEL_IDX = 7;

async function setup(scn: Scenario): Promise<{ client: MeshCoreClient; clock: SimClock }> {
  const world = defineWorld({
    homeNodeId: "home",
    nodes: [node("home"), node("rocky", { role: "repeater" })],
    channels: [channel(0, "public"), channel(1, "ops")],
    contacts: [contact("Rocky", "rocky")],
  });
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, scenario: scn });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  await client.connect();
  return { client, clock };
}

describe("provenance: verified vs. unverified channel traffic (the admin-gate contract)", () => {
  it("a verified channelMessage on 'ops' surfaces with decoded text and correct channelIdx", async () => {
    const scn = scenario([
      at("1s", { kind: "channelMessage", channel: "ops", text: "status: green" }),
    ]);
    const { client, clock } = await setup(scn);

    const got = nextEvent(client, "channelMessage");
    clock.advance("2s");
    const [msg] = await got;

    expect(msg.text).toBe("status: green");
    expect(msg.channelIdx).toBe(1); // "ops" resolves to idx 1
  });

  it("an unverified admin-channel datagram surfaces as channelData, NEVER a channelMessage", async () => {
    const scn = scenario([
      at("1s", {
        kind: "channelMessage",
        channel: ADMIN_CHANNEL_IDX,
        text: "reboot now",
        verified: false,
        snr: 7,
      }),
    ]);
    const { client, clock } = await setup(scn);

    // Assert no channelMessage listener ever fires for this traffic.
    let sawChannelMessage = false;
    client.on("channelMessage", () => {
      sawChannelMessage = true;
    });

    const data = nextEvent(client, "channelData");
    clock.advance("2s");
    const [raw] = await data;

    expect(raw.channelIdx).toBe(ADMIN_CHANNEL_IDX);
    expect(raw.snr).toBe(7);
    // Raw bytes carried, no decoded text field on the channelData model.
    expect(raw.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(raw.data).toString("utf8")).toBe("reboot now");
    expect("text" in raw).toBe(false);

    // Flush any further microtasks to be sure no channelMessage was emitted.
    await Promise.resolve();
    expect(sawChannelMessage).toBe(false);
  });

  it("a direct message surfaces as contactMessage with the right pubKeyPrefix", async () => {
    const scn = scenario([at("1s", { kind: "message", from: "rocky", text: "ping" })]);
    const { client, clock } = await setup(scn);

    const got = nextEvent(client, "contactMessage");
    clock.advance("2s");
    const [msg] = await got;

    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home"), node("rocky", { role: "repeater" })],
    });
    const rocky = world.nodes.find((n) => n.id === "rocky")!;
    const expectedPrefix = Buffer.from(fromHex(rocky.publicKey).subarray(0, 6)).toString("hex");
    expect(msg.pubKeyPrefix).toBe(expectedPrefix);
    expect(msg.text).toBe("ping");
  });
});
