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

## Examples

- [`examples/demo.ts`](examples/demo.ts) — a guided tour: build a world, drive it
  through a real `MeshCoreClient`, watch traffic arrive in virtual time.

```sh
bun examples/demo.ts
```

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
