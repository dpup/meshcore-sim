# Guide

Concepts and recipes for `@dpup/meshcore-sim`. For exhaustive signatures, types,
and enums, see the generated [API reference](./api.md).

## Overview

`meshcore-sim` gives you three things:

- A **world** — a static snapshot of a mesh as observed through the home node
  (nodes, channels, contacts), built with `defineWorld` or `generateWorld`.
- A **scenario** — a timeline of events the world produces (messages arriving,
  nodes going offline, telemetry, adverts), built by hand or with `traffic.*`.
- A **virtual clock** (`SimClock`) the test controls, so time-domain logic runs
  instantly and deterministically.

`SimConnection` ties them together behind the raw `@liamcottle/meshcore.js`
`Connection` interface, so a real `MeshCoreClient` (or any meshcore.js-based app)
runs against a simulated mesh with no hardware attached.

---

## Worlds

A world is a static snapshot of the mesh: the home node the app connects to,
other nodes that exist in the network, channels the home node has keys for, and
contacts (known nodes with names).

Build one with `defineWorld`:

```ts
import { defineWorld, node, channel, contact, ChannelKind } from "@dpup/meshcore-sim";

const world = defineWorld({
  homeNodeId: "home",
  nodes: [
    node("home", { name: "Base Station" }),
    node("rocky-ridge", { name: "Rocky Ridge", role: "repeater" }),
    node("cedar-creek", { name: "Cedar Creek" }),
    node("silent-peak", { name: "Silent Peak", role: "repeater", reachable: false }),
  ],
  channels: [
    channel(0, "public"),
    channel(1, "ops", { kind: ChannelKind.Private }),
  ],
  contacts: [
    contact("Rocky Ridge", "rocky-ridge"),
    contact("Cedar Creek", "cedar-creek"),
    contact("Silent Peak", "silent-peak"),
  ],
});
```

**Strong defaults.** `node(id)` produces a fully-formed node: `role:
"companion"`, `reachable: true`, 100% battery, the standard 910.525 MHz LoRa
radio preset, and a `name` and `publicKey` derived deterministically from `id`.
Override only the fields a test cares about; everything else is sensible and
invisible. Likewise, `channel(idx, name)` defaults to `kind: "public"` with a
deterministic secret.

**One validated path.** `defineWorld` validates that node ids are unique, channel
indices are unique, every contact references a known node, and `homeNodeId`
references a known node. Generated worlds (`generateWorld`) go through the same
path, so neither hand-authored nor generated worlds can be internally
inconsistent.

**Reachable vs. offline.** Set `reachable: false` on a node to model a node the
home device cannot reach. Remote reads against it (`getStatus`, `getTelemetry`,
`getNeighbours`) reject with a `MeshCoreDeviceError` — exactly as they would on
real hardware. Flip reachability mid-timeline with a `nodeState` scenario event.

**Public vs. private channels.** `ChannelKind.Public` (the default) is an open
channel; `ChannelKind.Private` requires the home node to hold the key. Both
surface as `channelMessage` events for verified traffic; unverified traffic on
either channel surfaces as `channelData`.

---

## Connecting

Wrap a world in a `SimConnection`, pass it to a `MeshCoreClient`, and call
`connect()`:

```ts
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimConnection, SimClock, defineWorld } from "@dpup/meshcore-sim";

const world = defineWorld({ homeNodeId: "home" });
const clock = new SimClock();
const sim = new SimConnection({ world, clock });

const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
await client.connect();

const self = await client.getSelfInfo();
console.log(`Connected to "${self.name}"`);
```

`sim.asConnection()` casts the `SimConnection` to the raw meshcore.js
`Connection` type `MeshCoreClient` expects. This is the **drop-in point**: a
`MeshCoreClient` (or any meshcore.js-based app) cannot tell this from a real
TCP/serial connection. The same simulator can front any app that takes a
`Connection`.

**`autoSync: true`** tells the client to auto-drain incoming messages and emit
`contactMessage` / `channelMessage` / `channelData` events when the device
signals waiting messages. It is the normal mode for app code; tests without it
must drain manually with `getWaitingMessages()`.

Static reads — `getSelfInfo`, `getContacts`, `getChannels`, `getStatus`,
`getTelemetry`, `getNeighbours` — resolve immediately from the world without
advancing the clock.

---

## The virtual clock

`SimClock` is the test's handle on simulated time. It implements the `Clock`
interface the app under test injects, so a 30-second debounce costs zero real
seconds:

```ts
import { SimClock } from "@dpup/meshcore-sim";

const clock = new SimClock();

// Schedule something 30 seconds from now.
clock.setTimeout(() => console.log("fired"), "30s");

// Instantly advance 30 seconds of simulated time — the callback fires before
// this line returns. No real milliseconds spent.
clock.advance("30s");
```

**`advance(by)`** moves the virtual clock forward by `by` (a number of
milliseconds or a string like `"30s"`, `"500ms"`), firing every timer due within
that window in due-time order before returning. Timers scheduled inside callbacks
that fall within the remaining window also fire in the same call.

**`runUntil(t)`** moves to absolute virtual time `t`. Useful when you know the
exact target time.

**`runAll()`** fires all pending one-shot timers and advances to the last one's
due time. Convenient for draining a scenario completely.

**`await advanceAsync(by)`** is the settling counterpart to `advance`. `advance`
fires timers *synchronously*, but a client draining messages under `autoSync`
delivers them *asynchronously*, across many microtask turns — so a synchronous
`advance` alone leaves delivery unfinished. `advanceAsync` steps the clock
forward in fine increments (default 250 ms) and flushes the microtask queue
between steps, so a multi-message burst is fully delivered **and** each message
keeps the timestamp of the step it fired in. Reach for it whenever advancing
time causes message delivery; keep the synchronous `advance` for pure-timer
tests. See [Device-queue delivery](#device-queue-delivery-and-await).

**`await settle()`** flushes the microtask queue without advancing time — use it
after a manual `advance`, or after `await client.sendTextMessage(...)` whose ack
or reply lands on the microtask queue. Both helpers consult no real time, so
they stay deterministic.

**Why it matters.** Without a controllable clock, a test for a 30-second
coalescer debounce is a 30-second test. With `SimClock`, it is a zero-second
test. The same applies to any time-domain logic: burst windows, retry backoffs,
connection timeouts. See the [Testing patterns](#testing-patterns) section for
concrete recipes.

**The `Clock` interface.** `SimClock` implements `Clock` — a tiny interface
(`now`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`) that any
app can define locally and `SimClock` will satisfy structurally. In production
the app wires in a real implementation backed by `Date.now()` and
`globalThis.setTimeout`; in tests it swaps in `SimClock`.

---

## Scenarios and provenance

A scenario is a time-sorted list of `ScheduledEvent`s — things the simulated
world does at specific offsets from connect time. Build one with `scenario` and
`at`:

```ts
import { scenario, at } from "@dpup/meshcore-sim";

const scn = scenario([
  at("1s", { kind: "message", from: "rocky-ridge", text: "hello" }),
  at("3s", { kind: "advert", nodeId: "rocky-ridge" }),
  at("5s", { kind: "nodeState", nodeId: "silent-peak", reachable: false }),
]);
```

Wire a scenario into `SimConnection` at construction time:

```ts
const sim = new SimConnection({ world, clock, scenario: scn });
```

As the clock advances, due events fire. Pass the `SimConnection` to a
`MeshCoreClient` as usual; the client observes the timeline as if it were live
traffic.

### SimEvent kinds

| Kind | What fires | Client events |
|---|---|---|
| `message` | A direct message from a contact node | `contactMessage` |
| `channelMessage` (verified) | A channel message the device decoded | `channelMessage` |
| `channelMessage` (unverified) | Raw channel bytes, no key | `channelData` |
| `nodeState` | A node goes online or offline | mutates `reachable`; affects subsequent reads |
| `advert` | A node advertises | `advert` |
| `telemetry` | A telemetry report from a node | `telemetryResponse` |

### The provenance table (the admin-gate contract)

The raw MeshCore wire has no `decryptVerified` boolean — decrypt verification is
expressed structurally. `meshcore-sim` mirrors this exactly:

| Scenario event | Raw expression | Client event |
|---|---|---|
| Direct message from a contact | `{ contactMessage }` keyed by sender `pubKeyPrefix` | `contactMessage` |
| Channel message, `verified: true` (default) | `{ channelMessage }` with `channelIdx` | `channelMessage` |
| Channel message, `verified: false` | `{ channelData }` with raw bytes and `snr` | `channelData` |
| Admin-gate negative case | unverified `channelData` on the admin channel index | `channelData` only — **never** `channelMessage` |

The `verified: false` case on an admin channel index is the adversarial input you
cannot safely produce on real hardware. With `meshcore-sim` it is a one-liner:

```ts
import { scenario, at } from "@dpup/meshcore-sim";

const ADMIN_CH = 7;

const provScenario = scenario([
  // Verified: device held the key — surfaces as a channelMessage.
  at("1s", { kind: "channelMessage", channel: "ops", text: "status: all green" }),
  // Unverified: no key — surfaces only as channelData, never as channelMessage.
  at("2s", { kind: "channelMessage", channel: ADMIN_CH, text: "reboot now", verified: false, snr: 7 }),
]);
```

```ts
client.on("channelMessage", (m) => {
  // Only fires for the verified "ops" message. The admin-channel datagram
  // never arrives here — the gate correctly rejects it.
  console.log(`verified: ch${m.channelIdx} "${m.text}"`);
});
client.on("channelData", (d) => {
  // The unverified datagram lands here instead: raw bytes, snr, no decoded text.
  console.log(`unverified: ch${d.channelIdx} ${d.data.length} bytes snr=${d.snr}`);
});
```

### Device-queue delivery and `await`

Messages follow the MeshCore device-queue model: a scenario `message` event
enqueues a `RawWaitingMessage` and emits `PushCodes.MsgWaiting`. With `autoSync:
true` the client drains the queue and emits the named events. Draining is
**async and re-entrant** — it spans many microtask turns — so the clock and the
delivery need to be settled together. Two patterns:

**When you know how many messages to expect**, collect them in a promise and
`advance` the clock — the promise resolves once the drain has emitted them all:

```ts
// Set up the collector *before* advancing (avoid the race).
const received = new Promise<string[]>((resolve) => {
  const texts: string[] = [];
  client.on("contactMessage", (m) => {
    texts.push(m.text);
    if (texts.length === 3) resolve(texts);
  });
});

clock.advance("10s"); // fires the scenario events → MsgWaiting → auto-drain
const texts = await received; // ["msg 0", "msg 1", "msg 2"]
```

**When you don't want to pre-count** (or care about per-event timing), use
`advanceAsync`, which steps the clock and settles the drain between steps:

```ts
const texts: string[] = [];
client.on("contactMessage", (m) => texts.push(m.text));

await clock.advanceAsync("10s"); // advance + settle the async drain
// texts holds every message delivered in the window, each stamped at the
// step it fired in (not collapsed to the window's end).
```

> **Footgun:** a single `await Promise.resolve()` after `advance` flushes only
> the *first* microtask turn, so a multi-message burst silently under-delivers.
> Use `advanceAsync` (or `await clock.settle()` after a manual `advance`)
> instead.

---

## Generators

For larger or more varied fixtures, use the procedural generators.

### `generateWorld`

Builds an N-node mesh through the same validated `defineWorld` path as any
hand-authored world:

```ts
import { generateWorld } from "@dpup/meshcore-sim";

const world = generateWorld({ seed: 42, nodes: 10, repeaters: 2 });
// → 1 home companion + 2 repeaters + 7 companions, 2 channels, 9 contacts
```

Node ids are generated from a curated word-pair pool (`rocky-ridge`,
`cedar-creek`, …) so generated worlds are human-readable as well as
deterministic. The home node always has id `"home"`.

Knobs: `seed` (required), `nodes` (total including home), `repeaters` (default
~25% of remotes), `channels` (default 2: a public channel at idx 0 and a private
`"ops"` channel at idx 1).

### `traffic.*` scenario generators

All four generators return a validated `Scenario` built through the same
`scenario()` constructor. Same seed ⇒ identical scenario, byte for byte.

**`traffic.burst`** — `count` messages from one node, jittered across a window.
The canonical coalescer stressor:

```ts
import { traffic } from "@dpup/meshcore-sim";

const scn = traffic.burst({ from: "rocky-ridge", count: 3, within: "10s", seed: 42 });
// 3 messages at seeded-jitter offsets within 0–10 s
```

**`traffic.crosstalk`** — interleaved messages from multiple nodes:

```ts
const scn = traffic.crosstalk({
  nodes: ["rocky-ridge", "cedar-creek"],
  count: 6,
  within: "15s",
  seed: 99,
});
```

**`traffic.quiet`** — an empty timeline representing an idle span. Combine with
`clock.advance` to assert nothing fires:

```ts
const silence = traffic.quiet({ duration: "10s" });
// silence.events is empty
clock.advance("10s");
expect(received).toHaveLength(0);
```

**`traffic.outOfOrder`** — messages whose **arrival** order differs from their
**sender-timestamp** order. Each message gets an `at` (arrival offset) and a
`sentAt` (sender-clock offset); the two orderings are reversed. Exercises
reordering logic in a coalescer:

```ts
const scn = traffic.outOfOrder({ from: "rocky-ridge", count: 4, within: "10s", seed: 7 });
// arrivalOffsets: [t1 < t2 < t3 < t4]; sentAt: [t4, t3, t2, t1]
```

**Seeded determinism.** Omitting `seed` from a generator still produces a
deterministic scenario (a fixed default constant is used internally). Pass an
explicit seed to pin the exact fixture across runs.

**Low-knob philosophy.** The generators have at most four or five options. A
generator with thirty parameters is as much work as hand-writing; the goal is
"get a plausible, varied fixture with one line."

---

## Freezing fixtures

A generated world and scenario can be frozen to a committed JSON file and
replayed later — the "generate once, inspect, snapshot, replay" workflow:

```ts
import { generateWorld, traffic, serializeWorld, serializeScenario, loadWorld, loadScenario } from "@dpup/meshcore-sim";
import { writeFileSync, readFileSync } from "node:fs";

// Generate and inspect.
const world = generateWorld({ seed: 42, nodes: 8, repeaters: 2 });
const scn = traffic.burst({ from: world.nodes[1]!.id, count: 5, within: "10s", seed: 42 });

// Freeze to disk.
writeFileSync("fixtures/world.json", serializeWorld(world));
writeFileSync("fixtures/scenario.json", serializeScenario(scn));

// Load later — identical world and scenario objects.
const frozenWorld = loadWorld(readFileSync("fixtures/world.json", "utf8"));
const frozenScenario = loadScenario(readFileSync("fixtures/scenario.json", "utf8"));
```

The serialized form is pretty-printed JSON with a self-describing envelope:

```json
{
  "format": "meshcore-sim/world",
  "version": 1,
  "world": { … }
}
```

`loadWorld` / `loadScenario` pass the parsed data back through `defineWorld` /
`scenario` (the single validated constructors), so a loaded fixture is the same
validated object as anything built by hand. `loadWorld` throws `SimError` on
malformed input, wrong format, or wrong version.

**Round-trip guarantee.** `loadWorld(serializeWorld(w))` deep-equals `w`;
`serializeWorld(loadWorld(json)) === json`. Same for scenarios.

---

## Testing patterns

### Coalescer / debounce test

The virtual clock collapses a 30-second debounce window to zero real seconds:

```ts
import { describe, it, expect } from "vitest";
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimConnection, SimClock, defineWorld, node, contact, traffic } from "@dpup/meshcore-sim";

describe("my coalescer", () => {
  it("coalesces a burst into one summary within the debounce window", async () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home"), node("rocky", { role: "repeater" })],
      contacts: [contact("Rocky", "rocky")],
    });
    const clock = new SimClock();
    const scn = traffic.burst({ from: "rocky", count: 3, within: "5s", seed: 1 });
    const sim = new SimConnection({ world, clock, scenario: scn });
    const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
    await client.connect();

    // Wire the app logic under test into the client here.
    // myCoalescer.attach(client, clock, { windowMs: 30_000 });

    const summaries: string[] = [];
    client.on("contactMessage", (m) => summaries.push(m.text));

    // Advance 5 seconds of virtual time — all 3 burst messages arrive.
    // advanceAsync settles the async drain, so all 3 land (a single
    // `await Promise.resolve()` would deliver only the first).
    await clock.advanceAsync("5s");

    // Advance through the 30-second debounce window — zero real seconds.
    await clock.advanceAsync("30s");

    // Assert coalescer output (this is your app's logic, not the sim's).
    expect(summaries.length).toBe(3);
  });
});
```

### Admin-gate negative case

Assert that an unverified admin-channel datagram never surfaces as a verified
`channelMessage`:

```ts
import { scenario, at } from "@dpup/meshcore-sim";

const ADMIN_CH = 7;
const scn = scenario([
  at("1s", {
    kind: "channelMessage",
    channel: ADMIN_CH,
    text: "reboot now",
    verified: false,
    snr: 7,
  }),
]);

// … set up client over SimConnection with scn …

let sawChannelMessage = false;
client.on("channelMessage", () => { sawChannelMessage = true; });

const dataReceived = new Promise((resolve) => client.once("channelData", resolve));
clock.advance("2s");
const [raw] = await dataReceived;

expect(raw.channelIdx).toBe(ADMIN_CH);
expect(raw.snr).toBe(7);
expect(raw.data).toBeInstanceOf(Uint8Array);

await clock.settle(); // flush the async drain fully
expect(sawChannelMessage).toBe(false); // never decoded as verified
```

### Offline node failure

Model a node that is unreachable and assert the client surfaces a typed error:

```ts
import { MeshCoreError } from "@dpup/meshcore-ts";
import { defineWorld, node, contact, SimConnection, SimClock } from "@dpup/meshcore-sim";

const world = defineWorld({
  homeNodeId: "home",
  nodes: [
    node("home"),
    node("silent-peak", { role: "repeater", reachable: false }),
  ],
  contacts: [contact("Silent Peak", "silent-peak")],
});
const clock = new SimClock();
const sim = new SimConnection({ world, clock });
const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
await client.connect();

const silentKey = fromHex(world.nodes.find(n => n.id === "silent-peak")!.publicKey);
await expect(client.getStatus(silentKey)).rejects.toBeInstanceOf(MeshCoreError);
```

### Node going offline mid-timeline

Use a `nodeState` event to flip reachability during the test:

```ts
import { scenario, at } from "@dpup/meshcore-sim";

const scn = scenario([
  at("5s", { kind: "nodeState", nodeId: "rocky", reachable: false }),
]);

// … set up client over SimConnection with scn …

// Before: reachable, getStatus resolves.
const before = await client.getStatus(rockyKey);
expect(before.batteryMilliVolts).toBeGreaterThan(0);

clock.advance("6s");

// After: offline, getStatus rejects.
await expect(client.getStatus(rockyKey)).rejects.toBeInstanceOf(MeshCoreError);
```

---

## Integrating with your app

`SimConnection` is a drop-in wherever an app takes a raw meshcore.js
`Connection`. The integration is:

```ts
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimConnection, SimClock, defineWorld, traffic } from "@dpup/meshcore-sim";

// Build a world that matches what the app expects.
const world = defineWorld({ /* … */ });
const clock = new SimClock();
const scn = traffic.burst({ from: "rocky-ridge", count: 5, within: "10s" });
const sim = new SimConnection({ world, clock, scenario: scn });

// Inject the sim connection wherever the app takes a Connection.
const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
await client.connect();

// Drive the app with the virtual clock.
clock.advance("10s");
```

**Dependency direction.** Your app dev-depends on `@dpup/meshcore-sim`:

```json
{
  "devDependencies": {
    "@dpup/meshcore-sim": "^0.1.0"
  }
}
```

`meshcore-sim` never depends on your app. The simulator is a pure test-time tool;
it is never shipped in production bundles.

**meshcore-mcp.** If your app is `meshcore-mcp` (or any MeshCore app that
exposes a `Connection`-shaped seam), inject `sim.asConnection()` at that seam in
tests exactly as shown above.

---

## See also

- [API reference](./api.md) — every exported symbol with full signatures.
- [`examples/demo.ts`](../examples/demo.ts) — a runnable guided tour covering all
  major features: worlds, connecting, static reads, dynamic traffic, provenance,
  determinism, and freezing.
- [AGENTS.md](../AGENTS.md) — architecture, the `Connection` contract, and
  conventions.
