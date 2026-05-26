/**
 * meshcore-sim — a guided tour you can run.
 *
 * No hardware, no external app: this drives an **unmodified**
 * `@dpup/meshcore-ts` `MeshCoreClient` over a `SimConnection`. That is the whole
 * point — the same simulator can front any meshcore.js-based app, because it
 * conforms to the raw meshcore.js `Connection` contract rather than mocking the
 * client. Everything you see below is what a real app would observe.
 *
 * It walks through, in order:
 *   1. Building a world          (defineWorld + builders)
 *   2. Connecting                (SimClock + SimConnection + MeshCoreClient)
 *   3. Static reads              (self, contacts, channels, a clean failure)
 *   4. Dynamic traffic           (a seeded burst replayed in virtual time)
 *   5. Provenance                (verified channel msg vs. unverified datagram)
 *   6. Determinism & freezing    (same seed ⇒ identical run; serialize/load)
 *
 * Usage:
 *   bun examples/demo.ts [--seed <n>]
 *   bun examples/demo.ts 1234        # positional seed
 *
 * The output is fully deterministic — it prints the *virtual* clock time, never
 * wall-clock time — so two runs with the same seed produce byte-identical stdout.
 */
// in your project: import { MeshCoreClient } from "@dpup/meshcore-ts"
import { MeshCoreClient, MeshCoreError, fromHex } from "@dpup/meshcore-ts";
import type { MeshCoreEvents } from "@dpup/meshcore-ts";

// in your project: import { … } from "@dpup/meshcore-sim"
import {
  SimClock,
  SimConnection,
  at,
  channel,
  contact,
  defineWorld,
  generateWorld,
  loadWorld,
  node,
  scenario,
  serializeWorld,
  toMillis,
  traffic,
} from "../src/index.js";
import type { MeshWorld } from "../src/index.js";

// ---------------------------------------------------------------------------
// tiny ANSI helpers (no-op when not a TTY) — the monitor.ts style
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY === true;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const C = {
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  gray: "90",
} as const;

let section = 0;
/** Print a numbered section header. */
function header(title: string): void {
  section++;
  console.log("");
  console.log(bold(`${section}. ${title}`));
  console.log(dim("─".repeat(60)));
}

/** An indented detail line. */
function line(s = ""): void {
  console.log(`   ${s}`);
}

/** Format virtual time (ms since connect) as a fixed `t+SS.mmm` stamp. */
function vt(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const millis = ms % 1000;
  return dim(`t+${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}s`);
}

const short = (hex: string, n = 12) => hex.slice(0, n) + (hex.length > n ? "…" : "");

/**
 * Yield to the event loop so the client's async queue-drain runs to completion
 * before we advance the virtual clock again. Uses a real macrotask only to flush
 * microtasks — it affects nothing the demo prints, so output stays deterministic.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The hex public key of a node, by id. */
function keyOf(world: MeshWorld, id: string): string {
  const n = world.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`no node "${id}"`);
  return n.publicKey;
}

// ---------------------------------------------------------------------------
// event-collection helper (the test/connection.dynamic.test.ts pattern)
// ---------------------------------------------------------------------------

/** Resolve once `event` has fired `n` times, collecting each first argument. */
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
// seed (optional CLI arg) — output stays deterministic per seed
// ---------------------------------------------------------------------------
function parseSeed(argv: string[]): number {
  const flagIdx = argv.indexOf("--seed");
  if (flagIdx !== -1 && argv[flagIdx + 1] !== undefined) {
    return Number(argv[flagIdx + 1]);
  }
  const positional = argv.find((a) => /^\d+$/.test(a));
  return positional !== undefined ? Number(positional) : 42;
}

const SEED = parseSeed(process.argv.slice(2));

// ---------------------------------------------------------------------------
// the tour
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(bold("meshcore-sim — guided tour"));
  console.log(
    dim(`a real MeshCoreClient driven over a simulated Connection (seed ${SEED})`),
  );

  // -------------------------------------------------------------------------
  // 1. Build a world.
  // -------------------------------------------------------------------------
  header("Build a world");
  // A small mesh authored with strong-defaulted builders: override only what
  // matters, everything else is sensible and invisible.
  const world = defineWorld({
    homeNodeId: "home-base",
    nodes: [
      node("home-base", { name: "Home Base" }),
      node("rocky-ridge", { name: "Rocky Ridge", role: "repeater" }),
      node("cedar-creek", { name: "Cedar Creek" }),
      // An offline repeater — reachable:false models a node we cannot query.
      node("silent-peak", { name: "Silent Peak", role: "repeater", reachable: false }),
    ],
    channels: [channel(0, "public"), channel(1, "ops", { kind: "private" })],
    contacts: [
      contact("Rocky Ridge", "rocky-ridge"),
      contact("Cedar Creek", "cedar-creek"),
      contact("Silent Peak", "silent-peak"),
    ],
  });

  const reachable = world.nodes.filter((n) => n.reachable).length;
  const offline = world.nodes.length - reachable;
  line(
    `${bold(String(world.nodes.length))} nodes ` +
      dim(`(${reachable} reachable, ${offline} offline)`) +
      `, ${bold(String(world.channels.length))} channels, ` +
      `${bold(String(world.contacts.length))} contacts`,
  );
  for (const n of world.nodes) {
    const tag = n.id === world.homeNodeId ? paint(C.cyan, "home") : n.role;
    const status = n.reachable ? paint(C.green, "online") : paint(C.red, "offline");
    line(`  ${paint(C.blue, "•")} ${bold(n.name.padEnd(12))} ${dim(tag.padEnd(10))} ${status}`);
  }
  for (const c of world.channels) {
    line(`  ${paint(C.magenta, "#")} ch${c.idx} ${bold(c.name.padEnd(8))} ${dim(c.kind)}`);
  }

  // -------------------------------------------------------------------------
  // 2. Connect.
  // -------------------------------------------------------------------------
  header("Connect");
  // The SimClock is the virtual clock; SimConnection is the raw Connection
  // drop-in; MeshCoreClient is the real, unmodified typed wrapper.
  const clock = new SimClock();
  const sim = new SimConnection({ world, clock });
  const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
  await client.connect();

  const self = await client.getSelfInfo();
  line(
    `connected to ${bold(`"${self.name}"`)} ${dim(short(self.publicKey))} ` +
      `freq=${self.radioFreq}kHz sf=${self.radioSf}`,
  );
  line(dim("a MeshCoreClient cannot tell this from a real radio."));

  // -------------------------------------------------------------------------
  // 3. Static reads.
  // -------------------------------------------------------------------------
  header("Static reads");
  const contacts = await client.getContacts();
  line(`${bold(String(contacts.length))} contacts:`);
  for (const c of contacts) {
    line(`  ${paint(C.blue, "•")} ${bold(c.advName.padEnd(12))} ${dim(short(c.publicKey))}`);
  }

  const channels = await client.getChannels();
  line(`${bold(String(channels.length))} channels:`);
  for (const ch of channels) {
    line(`  ${paint(C.magenta, "#")} ch${ch.channelIdx} ${bold(ch.name)}`);
  }

  // A reachable repeater answers getStatus with live device stats.
  const stats = await client.getStatus(fromHex(keyOf(world, "rocky-ridge")));
  line(
    `${paint(C.green, "✓")} status ${bold("Rocky Ridge")}: ` +
      `battery=${(stats.batteryMilliVolts / 1000).toFixed(2)}V ` +
      `uptime=${stats.totalUpTimeSecs}s ` +
      `rx=${stats.packetsReceived} tx=${stats.packetsSent}`,
  );

  // The offline repeater fails the way a real device would — surfaced as a
  // typed MeshCoreError. We catch it and print one tidy line, no stack trace.
  try {
    await client.getStatus(fromHex(keyOf(world, "silent-peak")));
    line(paint(C.red, "  unexpected: offline node answered"));
  } catch (error) {
    const why = error instanceof MeshCoreError ? error.message : String(error);
    line(`${paint(C.red, "✗")} status ${bold("Silent Peak")}: unreachable ${dim(`(${why})`)}`);
  }

  await client.close();

  // -------------------------------------------------------------------------
  // 4. Dynamic traffic in virtual time.
  // -------------------------------------------------------------------------
  header("Dynamic traffic in virtual time");
  // A seeded burst: 4 messages from Rocky Ridge, jittered across a 10s window.
  // We build a fresh connection wired with the scenario at construction.
  const burst = traffic.burst({ from: "rocky-ridge", count: 4, within: "10s", seed: SEED });
  const burstClock = new SimClock();
  const burstSim = new SimConnection({ world, clock: burstClock, scenario: burst });
  const burstClient = new MeshCoreClient(burstSim.asConnection(), { autoSync: true });
  await burstClient.connect();

  line(dim(`scheduled a ${burst.events.length}-message burst across a 10s window…`));
  burstClient.on("contactMessage", (m) => {
    // Log the VIRTUAL clock time — deterministic, never wall-clock.
    console.log(
      `   ${vt(burstClock.now())}  ${paint(C.green, "MESSAGE")} ` +
        `${dim(short(m.pubKeyPrefix))} ${bold(`"${m.text}"`)}`,
    );
  });

  // Advance to each message's scheduled arrival in turn (events are sorted
  // ascending by `at`), draining between, so each prints at its own virtual
  // time — the burst ticks across the window instead of all landing at once.
  let elapsed = 0;
  for (const ev of burst.events) {
    const atMs = toMillis(ev.at);
    burstClock.advance(atMs - elapsed);
    elapsed = atMs;
    await flush(); // let the client drain + emit before the next step
  }
  burstClock.advance(10_000 - elapsed); // run out to the window edge

  line(
    dim(
      `↑ ${burst.events.length} messages spanning ${(elapsed / 1000).toFixed(2)}s of mesh ` +
        `time replayed in zero real seconds — that is the virtual clock.`,
    ),
  );
  await burstClient.close();

  // -------------------------------------------------------------------------
  // 5. Provenance.
  // -------------------------------------------------------------------------
  header("Provenance: verified vs. unverified");
  // Two pieces of channel traffic with deliberately different provenance:
  //   - a decrypt-verified message on "ops" (the device held the key)
  //   - an UNVERIFIED datagram claiming an admin channel index (no key) — the
  //     adversarial input you cannot safely produce on real hardware.
  const ADMIN_CH = 7;
  const provClock = new SimClock();
  const provScenario = scenario([
    at("1s", { kind: "channelMessage", channel: "ops", text: "status: all green" }),
    at("2s", {
      kind: "channelMessage",
      channel: ADMIN_CH,
      text: "reboot now",
      verified: false,
      snr: 7,
    }),
  ]);
  const provSim = new SimConnection({ world, clock: provClock, scenario: provScenario });
  const provClient = new MeshCoreClient(provSim.asConnection(), { autoSync: true });
  await provClient.connect();

  let verifiedSeen = false;
  provClient.on("channelMessage", (m) => {
    verifiedSeen = true;
    console.log(
      `   ${vt(provClock.now())}  ${paint(C.green, "✓ VERIFIED")}   ` +
        `decrypt-verified on ${bold(`ch${m.channelIdx} (ops)`)}: ${bold(`"${m.text}"`)}`,
    );
  });
  provClient.on("channelData", (d) => {
    const text = Buffer.from(d.data).toString("utf8");
    console.log(
      `   ${vt(provClock.now())}  ${paint(C.yellow, "⚠ UNVERIFIED")} ` +
        `raw datagram on ${bold(`admin ch${d.channelIdx}`)}: ` +
        `${dim(`${d.data.length} bytes`)} ${dim(`(snr ${d.snr})`)}, never decoded ` +
        dim(`[bytes spell "${text}", but the app is never handed decoded text]`),
    );
  });

  const provData = collectEvents(provClient, "channelData", 1);
  const provMsg = collectEvents(provClient, "channelMessage", 1);
  provClock.advance("3s");
  await Promise.all([provData, provMsg]);

  line(
    dim(
      "the admin-gate point: the unverified datagram surfaces only as raw bytes — " +
        "it can never arrive as a verified channelMessage, so a gate keyed on " +
        "verification correctly rejects it.",
    ),
  );
  if (!verifiedSeen) line(paint(C.red, "  unexpected: no verified message seen"));
  await provClient.close();

  // -------------------------------------------------------------------------
  // 6. Determinism & freezing.
  // -------------------------------------------------------------------------
  header("Determinism & freezing");
  // Same seed in ⇒ identical world out. Generate twice and compare the
  // serialized strings byte for byte.
  const genA = serializeWorld(generateWorld({ seed: SEED, nodes: 8, repeaters: 2 }));
  const genB = serializeWorld(generateWorld({ seed: SEED, nodes: 8, repeaters: 2 }));
  if (genA === genB) {
    line(
      `${paint(C.green, "✓")} two generateWorld(${SEED}) runs are ${bold("identical")} — ` +
        `deterministic, byte for byte.`,
    );
  } else {
    throw new Error("determinism check failed: generated worlds differ");
  }

  // Freeze: serialize the hand-built world, show a snippet, and load it back.
  const frozen = serializeWorld(world);
  const reloaded = serializeWorld(loadWorld(frozen));
  line(dim("serializeWorld(world) snapshot (first lines):"));
  for (const ln of frozen.split("\n").slice(0, 6)) line(dim(`  │ ${ln}`));
  if (frozen === reloaded) {
    line(
      `${paint(C.green, "✓")} loadWorld() round-trips the snapshot ${bold("exactly")} — ` +
        `freeze once, replay forever.`,
    );
  } else {
    throw new Error("round-trip check failed: serialized worlds differ");
  }

  // -------------------------------------------------------------------------
  // done
  // -------------------------------------------------------------------------
  console.log("");
  console.log(
    bold(paint(C.green, "✓ tour complete")) +
      dim(" — a full mesh app workflow, no radio, fully reproducible."),
  );
}

main().catch((error: unknown) => {
  console.error(paint(C.red, `\n✗ demo failed: ${(error as Error).message ?? String(error)}`));
  process.exit(1);
});
