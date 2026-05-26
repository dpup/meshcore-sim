# AGENTS.md

Guidance for AI agents (and humans) working on **meshcore-sim**. Keep this
current when architecture or conventions change.

## What this is

A deterministic, behavioral MeshCore network simulator for **testing**
meshcore.js / `@dpup/meshcore-ts` apps without radios. We model the *observable
behavior* of a mesh (arrival, ordering, loss, signal metadata, node state,
channel/decrypt outcomes) — **never RF physics, real crypto, or a digital twin**.

The companion project is [`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts),
the typed wrapper this simulator is tested against. Keep the two consistent in
stack, style, and tone.

## The contract (read this first)

`SimConnection` implements the **raw `@liamcottle/meshcore.js` `Connection`**
surface — the same one `@dpup/meshcore-ts`'s `MeshCoreClient` consumes via its
public constructor `new MeshCoreClient(connection, options)`. It is the grown-up
form of meshcore-ts's own `test/fake-connection.ts`. Concretely, `SimConnection`:

1. **Is an `EventEmitter`** that emits lifecycle strings (`connected`,
   `disconnected`, `rx`) and the **numeric push codes** from `Constants.PushCodes`
   (`MsgWaiting`, `Advert`, `NewAdvert`, …). meshcore-ts listens on those numbers.
2. **Returns `Raw*` shapes**, not models: `Uint8Array` keys, **epoch-seconds**
   numbers, integer flags. meshcore-ts normalizes them on the way out.
3. **Follows the device-queue model:** a scenario `message` enqueues a
   `RawWaitingMessage` and emits `PushCodes.MsgWaiting`; the client drains it via
   `getWaitingMessages()` and re-emits `contactMessage`/`channelMessage`/
   `channelData`.

### Provenance mapping (the admin-gate / decrypt-verification contract)

The wire has no `decryptVerified` boolean — it is expressed structurally:

| Concept | Raw expression |
|---|---|
| Direct message from a contact | `{ contactMessage }` keyed by sender `pubKeyPrefix` |
| Channel message, decrypt-verified | `{ channelMessage }` with `channelIdx` |
| Channel traffic, **not** verified | `{ channelData }` and/or `RawData`/`LogRxData`, no decoded text |
| Admin-gate negative case | unverified `channelData`/`rawData` on the admin channel idx that never surfaces as a verified `channelMessage` |

## Layout

```
src/
  index.ts        Public surface (re-exports).
  world.ts        MeshWorld / SimNode / SimChannel / SimContact types + NodeRole / ChannelKind enums.
  builders.ts     defineWorld / node / channel / contact + strong defaults.
  scenario.ts     Scenario / ScheduledEvent / SimEvent types + at / scenario builders.
  clock.ts        SimClock — the virtual clock; Clock interface; TimerHandle.
  connection.ts   SimConnection — the raw Connection drop-in.
  encode.ts       world/event model -> Raw* shapes (keys->bytes, dates->epoch).
  generate.ts     generateWorld() procedural generator.
  traffic.ts      traffic namespace + burst / crosstalk / quiet / outOfOrder generators.
  random.ts       SeededRandom — seeded PRNG (deterministic).
  serialize.ts    serializeWorld / loadWorld / serializeScenario / loadScenario (freeze fixture).
  errors.ts       SimError + device-error injection helpers.
  duration.ts     Duration type + toMillis() helper.
  keys.ts         deriveNodeKey() — deterministic public key from node id.
test/             Vitest unit + integration tests (driven through MeshCoreClient).
examples/demo.ts  The guided-tour demo (run with: bun examples/demo.ts).
docs/api.md       GENERATED API reference (TypeDoc) — do not hand-edit.
docs/guide.md     Hand-written concepts & recipes.
```

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit (strict, includes src/test/examples)
bun run test        # vitest run
bun run build       # tsc -p tsconfig.build.json
bun run docs        # regenerate docs/api.md
bun run docs:check  # verify docs/api.md is in sync with source
bun examples/demo.ts [--seed <n>]   # the guided tour
```

## Conventions

- **ESM-only, Node-only.** `module`/`moduleResolution: NodeNext`; `.js` import
  extensions; `verbatimModuleSyntax` on, so split type-only imports/exports.
- **strict + `noUncheckedIndexedAccess`.** Guard indexed reads.
- **Deterministic by construction.** Randomness is allowed but only **seeded** —
  `seed` in, identical fixture out. No wall-clock-derived variation; the
  simulated clock is `SimClock`, never `Date.now()`/`setTimeout`.
- **One fixture object model.** Generated and hand-written fixtures are the same
  validated objects, built through the same constructors (`defineWorld`,
  `scenario`).
- **Raw at the boundary.** `SimConnection` speaks `Raw*` shapes and numeric push
  codes; friendly types live in the fixture/authoring layer.
- **`Clock` interface.** `SimClock` satisfies the exported `Clock` interface
  structurally — the interface an app injects for time-domain logic. In
  production the app provides a real implementation; in tests it uses `SimClock`.

## Don't-regress list

1. **The device-queue model is the spine.** Messages are delivered via
   `MsgWaiting` + `getWaitingMessages()`, never pushed directly.
2. **Raw shapes, not models** at the `Connection` boundary (bytes, epoch secs).
3. **Determinism.** Same seed ⇒ identical world and scenario, byte for byte.
4. **The provenance table above** is the admin-gate test contract — don't
   collapse verified vs. unverified channel traffic.
5. **No RF physics / no real crypto** sneaking in via a "smart" generator.
6. **`sentAt`** on `MessageEvent` / `ChannelMessageEvent` overrides the
   `senderTimestamp` in the encoded raw shape — enabling out-of-order scenarios
   without touching arrival time. Don't conflate it with `at`.

## Testing

The centre of gravity is **integration tests that drive a real `MeshCoreClient`
over `SimConnection`** and assert on app-visible behavior — never on sim
internals. That is the proof of drop-in fidelity. No hardware needed.

Key test files and what they cover:

- `test/connection.dynamic.test.ts` — scenario delivery, node-state events,
  advert/telemetry push codes, the MsgWaiting + drain pattern.
- `test/provenance.test.ts` — verified vs. unverified channel traffic; the
  admin-gate negative case.
- `test/serialize.test.ts` — round-trip exact; frozen-fixture replay through
  `MeshCoreClient`.
- `test/traffic.test.ts` — `burst`, `crosstalk`, `quiet`, `outOfOrder` including
  the `sentAt` reordering model.
- `test/generate.test.ts` — `generateWorld` determinism; same-path validation.
