# meshcore-sim

> A deterministic, behavioral [MeshCore](https://meshcore.co.uk) network simulator for testing your apps without radios.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Types: included](https://img.shields.io/badge/types-included-blue.svg)](#)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#)
[![Module: ESM](https://img.shields.io/badge/module-ESM-f7df1e.svg)](#)

`meshcore-sim` simulates a MeshCore network so you can test
[`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts) /
[`@liamcottle/meshcore.js`](https://github.com/meshcore-dev/meshcore.js) apps
with **no radios attached** — in CI, deterministically, including the failure
and adversarial cases hardware can't stage.

It is deliberately **not a digital twin**. It models the *observable behavior* of
a mesh — message arrival, ordering, loss, signal metadata, node state, channel
and decrypt outcomes — not RF physics. `SimConnection` is a drop-in for a
meshcore.js `Connection`: inject it where an app would use a real TCP/serial
connection, drive a virtual clock, and assert on what the app observed. It is the
grown-up form of a hand-written connection stub — the same interface, a simulated
world behind it instead of canned returns.

```ts
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimConnection, defineWorld, SimClock, node, contact, traffic } from "@dpup/meshcore-sim";

const world = defineWorld({
  homeNodeId: "home",
  nodes: [node("home"), node("alice")],
  contacts: [contact("Alice", "alice")],
});
const clock = new SimClock();
const sim = new SimConnection({
  world,
  clock,
  scenario: traffic.burst({ from: "alice", count: 3, within: "10s" }),
});

const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
client.on("contactMessage", (m) => console.log(m.text));

await client.connect();
clock.advance("10s"); // 3 messages arrive in compressed virtual time
```

The three messages arrive in their (seeded, jittered) order — instantly, no real
seconds spent:

```text
msg 0
msg 2
msg 1
```

## Why

The most logic-dense, bug-prone parts of a MeshCore app are barely testable any
other way: time-domain debounce/coalescing (a controllable clock, not real
seconds), admin-channel gates (adversarial inputs you shouldn't produce on
hardware), and failure modes (offline nodes, packet loss, reconnection). This is
a **development/test dependency**, never shipped in production.

## Install

```sh
npm install -D @dpup/meshcore-sim      # or: bun add -d / pnpm add -D
```

ESM-only, **Node.js ≥ 18**. Bring your own `@dpup/meshcore-ts` and
`@liamcottle/meshcore.js` (peer dependencies).

## Documentation

- **[Guide](./docs/guide.md)** — concepts and recipes.
- **[API reference](./docs/api.md)** — the complete, generated reference.

## See it in action

[`examples/demo.ts`](examples/demo.ts) is a guided tour — it builds a world,
drives it through a real `MeshCoreClient`, and walks the whole feature set. No
hardware, fully deterministic:

```sh
bun examples/demo.ts          # or --seed <n> / a positional seed
```

```text
meshcore-sim — guided tour
a real MeshCoreClient driven over a simulated Connection (seed 42)

1. Build a world
────────────────────────────────────────────────────────────
   4 nodes (3 reachable, 1 offline), 2 channels, 3 contacts
     • Home Base    home       online
     • Rocky Ridge  repeater   online
     • Cedar Creek  companion  online
     • Silent Peak  repeater   offline
     # ch0 public   public
     # ch1 ops      private

2. Connect
────────────────────────────────────────────────────────────
   connected to "Home Base" d54ca596335b… freq=910525kHz sf=10
   a MeshCoreClient cannot tell this from a real radio.

3. Static reads
────────────────────────────────────────────────────────────
   3 contacts:
     • Rocky Ridge  3f997cdbe620…
     • Cedar Creek  3d4098fbaa16…
     • Silent Peak  ba14fa6ded11…
   2 channels:
     # ch0 public
     # ch1 ops
   ✓ status Rocky Ridge: battery=4.20V uptime=0s rx=0 tx=0
   ✗ status Silent Peak: unreachable (Device error: not found)

4. Dynamic traffic in virtual time
────────────────────────────────────────────────────────────
   scheduled a 4-message burst across a 10s window…
   t+04.482s  MESSAGE 3f997cdbe620 "msg 1"
   t+06.011s  MESSAGE 3f997cdbe620 "msg 0"
   t+06.697s  MESSAGE 3f997cdbe620 "msg 3"
   t+08.524s  MESSAGE 3f997cdbe620 "msg 2"
   ↑ 4 messages spanning 8.52s of mesh time replayed in zero real seconds — that is the virtual clock.

5. Provenance: verified vs. unverified
────────────────────────────────────────────────────────────
   t+03.000s  ✓ VERIFIED   decrypt-verified on ch1 (ops): "status: all green"
   t+03.000s  ⚠ UNVERIFIED raw datagram on admin ch7: 10 bytes (snr 7), never decoded
   the admin-gate point: the unverified datagram surfaces only as raw bytes — it
   can never arrive as a verified channelMessage, so a gate keyed on verification
   correctly rejects it.

6. Determinism & freezing
────────────────────────────────────────────────────────────
   ✓ two generateWorld(42) runs are identical — deterministic, byte for byte.
   ✓ loadWorld() round-trips the snapshot exactly — freeze once, replay forever.

✓ tour complete — a full mesh app workflow, no radio, fully reproducible.
```

> In a real terminal the tour is ANSI-colored; re-run it with any `--seed` and
> the output is identical every time.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit (strict)
bun run test        # vitest unit + integration tests (no hardware needed)
bun run build       # emit dist/ (ESM + .d.ts)
bun run docs        # regenerate docs/api.md from the source
```

See [AGENTS.md](./AGENTS.md) for architecture and contribution notes.

## License

[MIT](./LICENSE) © Dan Pupius
