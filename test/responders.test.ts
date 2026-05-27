import { describe, expect, it } from "vitest";
import { MeshCoreClient, TxtType, fromHex } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

import { channel, contact, defineWorld, node } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";
import type { Responder } from "../src/responder.js";

/** Resolve with the payload of the next emission of `event`. */
function nextEvent<K extends keyof MeshCoreEvents & string>(
  client: MeshCoreClient,
  event: K,
): Promise<MeshCoreEvents[K]> {
  return new Promise((resolve) => {
    client.once(event, ((...args: MeshCoreEvents[K]) => resolve(args)) as never);
  });
}

/** Build a world + connected client (autoSync on) with the given responders. */
async function setup(responders?: Responder[]): Promise<{
  client: MeshCoreClient;
  clock: SimClock;
  world: ReturnType<typeof defineWorld>;
}> {
  const world = defineWorld({
    homeNodeId: "home",
    nodes: [
      node("home", { name: "Base" }),
      node("rocky", { name: "Rocky", role: "repeater" }),
    ],
    channels: [channel(0, "public"), channel(1, "ops", { kind: "private" })],
    contacts: [contact("Rocky", "rocky")],
  });
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock, responders });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  await client.connect();
  return { client, clock, world };
}

/** The hex pubKeyPrefix (first 6 bytes) for a node, the contactMessage key. */
function prefixOf(world: ReturnType<typeof defineWorld>, id: string): string {
  const n = world.nodes.find((nd) => nd.id === id)!;
  return Buffer.from(fromHex(n.publicKey).subarray(0, 6)).toString("hex");
}

describe("SimConnection responders (reactive replies)", () => {
  it("answers a remote-admin CliData send with a reply from the target node", async () => {
    const responders: Responder[] = [
      {
        to: "rocky",
        when: (m) => m.txtType === TxtType.CliData,
        reply: (m) => ({ from: "rocky", text: `OK - ${m.text}`, after: "2s" }),
      },
    ];
    const { client, clock, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const reply = nextEvent(client, "contactMessage");
    await client.sendTextMessage(rockyKey, "reboot", TxtType.CliData);

    // Nothing yet — the reply is scheduled 2s out.
    await clock.advanceAsync("1s");
    // Now cross the 2s mark.
    await clock.advanceAsync("2s");

    const [msg] = await reply;
    expect(msg.text).toBe("OK - reboot");
    expect(msg.pubKeyPrefix).toBe(prefixOf(world, "rocky"));
  });

  it("does not reply when the `when` predicate fails", async () => {
    const responders: Responder[] = [
      {
        to: "rocky",
        when: (m) => m.txtType === TxtType.CliData,
        reply: () => ({ from: "rocky", text: "should not happen" }),
      },
    ];
    const { client, clock, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const received: string[] = [];
    client.on("contactMessage", (m) => received.push(m.text));

    // A Plain (non-CliData) send must not match.
    await client.sendTextMessage(rockyKey, "hello", TxtType.Plain);
    await clock.advanceAsync("5s");

    expect(received).toEqual([]);
  });

  it("an echo bot with no `to` matches any send", async () => {
    const responders: Responder[] = [
      { reply: (m) => ({ from: "rocky", text: `echo: ${m.text}` }) },
    ];
    const { client, clock, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const reply = nextEvent(client, "contactMessage");
    await client.sendTextMessage(rockyKey, "ping");
    await clock.advanceAsync("1s");

    const [msg] = await reply;
    expect(msg.text).toBe("echo: ping");
  });

  it("delivers multiple replies (a multi-line command response) in order", async () => {
    const responders: Responder[] = [
      {
        to: "rocky",
        reply: () => [
          { from: "rocky", text: "line 1" },
          { from: "rocky", text: "line 2", after: "1s" },
          { from: "rocky", text: "line 3", after: "2s" },
        ],
      },
    ];
    const { client, clock, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const received: string[] = [];
    client.on("contactMessage", (m) => received.push(m.text));

    await client.sendTextMessage(rockyKey, "status");
    await clock.advanceAsync("3s");

    expect(received).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("a channel responder answers a channel send with a channelMessage", async () => {
    const responders: Responder[] = [
      {
        when: (m) => m.kind === "channel" && m.channel === 0,
        reply: (m) => ({ channel: 0, text: `bot: ${m.text}` }),
      },
    ];
    const { client, clock } = await setup(responders);

    const reply = nextEvent(client, "channelMessage");
    await client.sendChannelTextMessage(0, "!weather");
    await clock.advanceAsync("1s");

    const [msg] = await reply;
    expect(msg.text).toBe("bot: !weather");
    expect(msg.channelIdx).toBe(0);
  });

  it("respects the reply delay — nothing arrives before `after`", async () => {
    const responders: Responder[] = [
      { to: "rocky", reply: () => ({ from: "rocky", text: "late", after: "10s" }) },
    ];
    const { client, clock, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const received: string[] = [];
    client.on("contactMessage", (m) => received.push(m.text));

    await client.sendTextMessage(rockyKey, "go");
    await clock.advanceAsync("9s");
    expect(received).toEqual([]); // still pending

    await clock.advanceAsync("2s");
    expect(received).toEqual(["late"]); // crossed 10s
  });

  it("a reply does not fire synchronously inside the send (it goes through the clock)", async () => {
    const responders: Responder[] = [
      { to: "rocky", reply: () => ({ from: "rocky", text: "immediate" }) },
    ];
    const { client, world } = await setup(responders);
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const received: string[] = [];
    client.on("contactMessage", (m) => received.push(m.text));

    await client.sendTextMessage(rockyKey, "go");
    // No clock advance yet: even a 0-delay reply is scheduled on the clock.
    await Promise.resolve();
    expect(received).toEqual([]);
  });

  it("with no responders configured, a send still acks and produces no reply", async () => {
    const { client, clock, world } = await setup();
    const rockyKey = fromHex(world.nodes.find((n) => n.id === "rocky")!.publicKey);

    const received: string[] = [];
    client.on("contactMessage", (m) => received.push(m.text));
    const confirmed = nextEvent(client, "sendConfirmed");

    await client.sendTextMessage(rockyKey, "hi");
    const [ack] = await confirmed;
    expect(ack.ackCode).toBe(0);

    await clock.advanceAsync("5s");
    expect(received).toEqual([]);
  });
});
