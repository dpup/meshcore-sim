# meshcore-sim — Execution Plan

**Derived from:** [`2026-05-25-initial-prd.md`](./2026-05-25-initial-prd.md) (Spec v0.2)
**Status:** Ready to build
**Target package:** `@dpup/meshcore-sim`

This turns the PRD into a buildable sequence. It locks the technical contract
`meshcore-sim` implements, mirrors the stack and conventions of
[`@dpup/meshcore-ts`](https://github.com/dpup/meshcore-ts) so the two read as one
author's work, and breaks the work into checkpointed milestones with a demo
script as the headline acceptance test.

---

## 1. The central bridge: PRD model ↔ the meshcore-ts `Connection` contract

The PRD's §9 decisions settle the contract: `SimConnection` implements the
**`@liamcottle/meshcore.js` raw `Connection`** surface, and `@dpup/meshcore-ts`
is the typed lens over it. The single most important implementation fact, found
by reading meshcore-ts:

> `MeshCoreClient`'s constructor is **public** and takes a raw `Connection`:
> `new MeshCoreClient(connection, options)`. Its own tests already inject a
> hand-written double — `test/fake-connection.ts`, a bare `EventEmitter` with
> stubbed async methods, cast via `.asConnection()`.

**`SimConnection` is that `FakeConnection` grown up: the same drop-in point, a
simulated world behind it instead of canned returns.** Integration is therefore
exactly:

```ts
import { MeshCoreClient } from "@dpup/meshcore-ts";
import { SimConnection, defineWorld, SimClock, traffic } from "@dpup/meshcore-sim";

const world = defineWorld({ /* … */ });
const clock = new SimClock();
const sim = new SimConnection({ world, scenario, clock });

const client = new MeshCoreClient(sim.asConnection(), { autoSync: true });
await client.connect();
clock.advance("30s");
// assert on what the app observed
```

### What "conform to the contract" concretely means

`SimConnection` must satisfy the raw `Connection` shape in
meshcore-ts's `src/meshcore.d.ts` — **not** the normalized `MeshCoreClient`
surface. That means:

1. **It is an `EventEmitter`** that emits the lifecycle strings (`connected`,
   `disconnected`, `rx`) and the **numeric push codes** from
   `Constants.PushCodes` (e.g. `MsgWaiting`, `Advert`, `NewAdvert`,
   `PathUpdated`, `TraceData`, `TelemetryResponse`). meshcore-ts's `bindEvents`
   listens on these numbers; we must emit those same numbers.
2. **Its async methods return `Raw*` shapes**, not models: `Uint8Array` public
   keys, **epoch-seconds** numbers (not `Date`), integer flags. meshcore-ts
   normalizes them on the way out, so the sim must speak raw on the way in.
3. **Message delivery follows the device-queue model.** The real device does not
   push message contents; it emits `MsgWaiting`, and the client drains via
   `getWaitingMessages()` / `syncNextMessage()`. So a scenario `message` event
   must (a) enqueue a `RawWaitingMessage` and (b) emit `PushCodes.MsgWaiting`.
   With `autoSync: true` the client then drains and re-emits
   `contactMessage` / `channelMessage` / `channelData`. **This queue model is the
   spine of the dynamic fixture** and must be built deliberately, not bolted on.

### Mapping provenance (PRD §5) onto the raw protocol

The PRD's `SimEvent.message` carries `channelId` + `decryptVerified`. The raw
protocol expresses these structurally — there is no `decryptVerified` boolean on
the wire. The decisions:

| PRD concept | Raw `Connection` expression |
|---|---|
| Direct message from a contact | enqueue `{ contactMessage: RawContactMessage }` keyed by sender `pubKeyPrefix` |
| Channel message, **decrypt-verified** (device holds the key) | enqueue `{ channelMessage: RawChannelMessage }` with `channelIdx` |
| Channel traffic **not** decrypt-verified (claims a channel, no/invalid key) | enqueue `{ channelData: RawChannelData }` and/or emit `PushCodes.RawData` / `LogRxData` with `snr`/`rssi` but no decoded text |
| Admin-gate negative case (claims admin channel, unverified) | a `channelData`/`rawData` event tagged with the admin channel index but never surfacing as a verified `channelMessage` |

This mapping table is the contract for the admin-gate and decrypt-verification
test cases the PRD §2 calls out, and is the one design area to validate early
(see Milestone M4). RSSI/SNR ride on `RawChannelData.snr`, `RawData.lastSnr/
lastRssi`, and `LogRxData` — the behavioral signal metadata the PRD wants.

### Dependency graph (resolves PRD §9.1, §9.5)

- **`@dpup/meshcore-ts`** — runtime + dev dependency. The typed contract and the
  source of `Constants`, the `Connection` base class, and the ambient `Raw*`
  types (it ships the `meshcore.d.ts` shim). Pin `^0.1.1`.
- **`@liamcottle/meshcore.js`** — declared as a **peerDependency** (and dev
  dependency for tests). We must *produce* values its `Connection` consumer
  expects, so we depend on the same protocol library meshcore-ts wraps, exactly
  as meshcore-ts depends on it. This keeps `Constants`/`Raw*` types first-party
  rather than reached through a transitive import.
- `meshcore-sim` **never** depends on `meshcore-mcp` or `checkmate` (PRD §3).

---

## 2. Stack & conventions (mirror meshcore-ts exactly)

Same toolchain, same idioms — a reader should not be able to tell the repos
apart by their scaffolding.

- **Language/module:** TypeScript, ESM-only, `type: module`. `tsconfig` with
  `target/lib ES2022`, `module/moduleResolution NodeNext`, `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `declaration` + `declarationMap` + `sourceMap`. Node ≥ 18 (CI/release on 24).
- **Imports:** `.js` extensions on relative imports; split `import type` /
  `export type` (verbatim module syntax).
- **Runner/build:** `bun` for install/scripts; `tsc -p tsconfig.build.json` to
  emit `dist/` (`rootDir: src`, excludes test/examples). `vitest` for tests.
- **Scripts** (copy verbatim, adjust names): `build`, `clean`, `typecheck`,
  `test`, `test:watch`, `docs`, `docs:check`, `prepublishOnly`.
- **Docs:** three layers — `README.md` (landing), `docs/guide.md` (hand-written
  recipes), `docs/api.md` (**generated** by TypeDoc + `scripts/postdocs.mjs`,
  CI-gated by `scripts/docs-check.mjs`), plus `llms.txt` indexing all three.
- **Agent docs:** `AGENTS.md` (full) + `CLAUDE.md` (TL;DR pointing at it), in the
  same voice — architecture, conventions, a "don't-regress" list.
- **CI/release:** `.github/workflows/ci.yml` (typecheck/test/build/docs:check on
  bun) and `release.yml` (tag-driven, npm Trusted Publishing / OIDC +
  provenance). License MIT © Dan Pupius.
- **moat.yaml:** already present and correct for this repo (`name: meshcore-sim`,
  bun/typescript/node@24, github/npm grants, node-modules volume).

**Decision — do we need a `meshcore.d.ts` shim and `postbuild.mjs`?** Likely
**no**: meshcore-ts already ships the ambient shim for `@liamcottle/meshcore.js`
and we re-use it. We do **not** re-export the raw classes, so meshcore-sim's
`dist/*.d.ts` should not force a `TS7016` on consumers. Verify with the
meshcore-ts trick — compile a throwaway consumer against `dist/` — and only add a
postbuild shim step if that check fails.

---

## 3. Repository scaffold

```
meshcore-sim/
  package.json            name @dpup/meshcore-sim; deps as §1; scripts as §2
  tsconfig.json           mirror meshcore-ts
  tsconfig.build.json     mirror
  vitest.config.ts        mirror
  typedoc.json            mirror (entry src/index.ts)
  moat.yaml               (exists)
  README.md  AGENTS.md  CLAUDE.md  llms.txt  LICENSE
  .gitignore  .github/workflows/{ci,release}.yml
  scripts/{postdocs.mjs, docs-check.mjs}   (+ postbuild.mjs only if needed)
  src/
    index.ts              public surface (re-exports)
    world.ts              MeshWorld / SimNode / SimChannel / SimContact types
    builders.ts           defineWorld(), node(), channel(), contact() + defaults
    scenario.ts           Scenario / ScheduledEvent / SimEvent types + builders
    clock.ts              SimClock (virtual clock)
    connection.ts         SimConnection — the raw Connection drop-in
    encode.ts             world/event model -> Raw* shapes (keys->bytes, dates->epoch)
    generate.ts           generateWorld() procedural generator
    traffic.ts            traffic.burst / crosstalk / quiet / outOfOrder scenarios
    random.ts             seeded PRNG (deterministic)
    serialize.ts          serializeWorld/loadWorld (+ scenario)
    errors.ts             SimError (+ device-error injection helpers)
  test/
    builders.test.ts  clock.test.ts  connection.static.test.ts
    connection.dynamic.test.ts  provenance.test.ts  generate.test.ts
    traffic.test.ts  serialize.test.ts  drift.test.ts
  examples/
    demo.ts               the headline demo (see M7)
    coalescer-harness.ts  optional: shows time-domain testing pattern
  docs/
    guide.md  api.md(generated)
    plans/2026-05-25-initial-prd.md  2026-05-26-execution-plan.md
```

---

## 4. Milestones

Each milestone is independently green (`bun run typecheck && bun run test`).
Order is dependency-driven; M1–M3 unlock static-read testing, M4 unlocks the
hard time-domain cases the PRD exists for.

### M0 — Scaffold & toolchain parity
- Author `package.json`, the four `tsconfig`/`vitest`/`typedoc` configs,
  `.gitignore`, `LICENSE`, empty doc stubs, and both CI workflows.
- `bun install` (`@dpup/meshcore-ts`, `@liamcottle/meshcore.js`, dev:
  `typescript`, `vitest`, `@types/node`, `typedoc`, `typedoc-plugin-markdown`).
- **Done when:** `bun run typecheck`, `bun run test` (zero tests), `bun run
  build` all pass and a throwaway consumer compiles against `dist/` with no
  `TS7016`.

### M1 — Fixture object model + builders (static world)
- `world.ts`: the `MeshWorld` / `SimNode` / `SimChannel` / `SimContact` types
  from PRD §7, refined for internal consistency (e.g. derive a deterministic
  public key per node id so contacts/messages reference real keys).
- `builders.ts`: `defineWorld(spec)`, `node(id, overrides?)`, `channel(...)`,
  `contact(...)` — strong defaults, override-only-what-matters (PRD §6). One
  validated constructor path so generated and hand-written worlds are identical
  objects (PRD §4 "one fixture object model").
- `random.ts`: seeded PRNG (e.g. mulberry32/xorshift) — the determinism enabler.
- **Done when:** a test builds `defineWorld` with one low-battery node and reads
  back a fully-formed, internally consistent world; defaults are stable.

### M2 — SimClock (the virtual clock, PRD §5)
- `clock.ts`: `now()`, `advance(by: Duration)`, `runUntil(t)`, plus timer
  scheduling (`setTimeout`/`setInterval`-shaped) so the app-under-test's injected
  clock can be satisfied. `Duration` = ms number or string (`"30s"`).
- Deterministic ordering of callbacks scheduled for the same tick.
- **Done when:** scheduling N callbacks across a window and `advance`-ing fires
  them in time order; `runUntil` is exact; re-runs are identical.

### M3 — SimConnection: static reads (drop-in over raw `Connection`)
- `connection.ts` + `encode.ts`: implement the read/query half of the raw
  `Connection` — `connect`/`close`, `getSelfInfo`, `getContacts`,
  `findContactBy*`, `getChannel(s)`, `getDeviceTime`, `getBatteryVoltage`,
  `deviceQuery`, `getStatus`/`getTelemetry`/`getNeighbours` for reachable remote
  nodes — each returning the correct `Raw*` shape from the world.
- `asConnection()` cast helper, mirroring `FakeConnection`.
- Unreachable/offline nodes (`SimNode.reachable=false`) reject the way the device
  would (timeout/`{errCode}`), so meshcore-ts surfaces a typed error.
- **Done when:** driven through a real `MeshCoreClient`, `client.getSelfInfo()`,
  `getContacts()`, `getChannels()`, `getStatus(remote)` return the world's data;
  an unreachable node's `getStatus` produces a `MeshCoreError`. Covers most of
  PRD §5 "deterministic reads."

### M4 — Dynamic fixtures: scenario engine + event delivery + provenance
*The milestone the project exists for (PRD §2).*
- `scenario.ts`: `Scenario`/`ScheduledEvent`/`SimEvent` types (PRD §7).
- Wire the scenario into `SimConnection` + `SimClock`: as the clock advances,
  due events fire. `message` events enqueue a `RawWaitingMessage` and emit
  `PushCodes.MsgWaiting`; `node_state` flips reachability (and may emit adverts);
  `telemetry`/`advert` emit their push codes.
- Implement the **provenance mapping table from §1**: verified channel messages
  vs. unverified `channelData`/`rawData`, contact messages, admin-channel
  negative cases. RSSI/SNR populated.
- Model the §3 "world reacts to the app's actions": a `sendTextMessage` can
  trigger a scripted `sendConfirmed` ack and/or a scripted reply on the timeline.
- Latency/ordering knobs sufficient to exercise debounce/coalescer edges
  (out-of-order arrival, bursts within a window) — **without** drifting toward RF
  modeling (resolves PRD §9.3: model arrival times, not propagation).
- **Done when:** an end-to-end test drives a 3-message burst through
  `MeshCoreClient` with `autoSync`, advances the clock, and asserts the app
  received exactly the three `contactMessage`s in order; a separate test delivers
  an unverified admin-channel datagram and asserts it never arrives as a verified
  `channelMessage`.

### M5 — Generators (PRD §6)
- `generate.ts`: `generateWorld({ seed, nodes, repeaters?, topology? })` —
  procedural N-node mesh through the **same builders** as M1 (so a generator can
  never make an inconsistent world). Low knob count (PRD guardrail).
- `traffic.ts`: `traffic.burst / crosstalk / quiet / outOfOrder` returning
  `Scenario`s with seeded jitter (PRD §6 scenario generators).
- Guardrail enforced in review: generators produce *plausible-shaped*, never
  *RF-simulated*, fixtures.
- **Done when:** same seed ⇒ byte-identical world and scenario across runs;
  `generateWorld({seed, nodes:20, repeaters:3})` yields a valid, connected world;
  `traffic.burst` feeds M4's delivery path.

### M6 — Serialization / freeze (PRD §4, §6)
- `serialize.ts`: `serializeWorld`/`loadWorld` (and scenario equivalents) to a
  declarative JSON form — round-trip exact. "Generate once, inspect, snapshot to
  a committed file, replay deterministically."
- **Done when:** `loadWorld(serializeWorld(w))` deep-equals `w`; a frozen fixture
  drives the same assertions as its generated source.

### M7 — Demo script (headline deliverable)
`examples/demo.ts` — a self-contained, runnable narrative (no hardware, no app
under test) that proves the library does what the PRD promises. It is the
acceptance test a reader runs first. Structure:
1. Build a small world with `defineWorld` (a home node, two contacts, a public
   and a private channel, one offline repeater).
2. Construct `SimClock` + `SimConnection`, wrap in a **real** `MeshCoreClient`.
3. Static reads: print self info, contacts, channels, and show the offline node
   failing cleanly.
4. Dynamic: attach a `traffic.burst` scenario, subscribe to `contactMessage`,
   `advance` the clock, and watch messages arrive in compressed virtual time.
5. Provenance: deliver one decrypt-verified channel message and one unverified
   admin-channel datagram; show the app sees the difference.
6. Determinism: re-run with the same seed, show identical output.
- Color-coded, TTY-aware logging in the style of meshcore-ts's `monitor.ts`.
- **Also** demonstrates the "exercise real software with fake traffic" use case
  per the user's brief: because it drives an unmodified `MeshCoreClient`, the
  same `SimConnection` can front any meshcore.js-based app.
- Run line documented: `bun examples/demo.ts` (and `--seed`).
- **Done when:** `bun examples/demo.ts` runs deterministically end to end and its
  output is legible as a tour of the feature set.

### M8 — Docs
- `README.md`: badges, one-paragraph pitch ("a behavioral MeshCore simulator and
  the grown-up form of a hand-written connection stub"), the integration
  quickstart from §1, feature bullets, install, links, design notes, the demo.
- `docs/guide.md`: concepts & recipes — worlds, the clock, scenarios &
  provenance, generators, freezing fixtures, the coalescer-testing pattern,
  integrating with `MeshCoreClient`/`meshcore-mcp`.
- `docs/api.md`: generated via `bun run docs`; committed and CI-gated.
- `llms.txt`, `AGENTS.md`, `CLAUDE.md`: in meshcore-ts's voice, with a
  don't-regress list (queue model, raw-shape boundary, determinism/seeding, the
  provenance mapping table).
- **Done when:** `bun run docs:check` passes; README quickstart compiles.

### M9 — Drift guard, CI, release
- `test/drift.test.ts`: assert the `Constants.PushCodes`/`ResponseCodes` and the
  `Connection` method names we *implement* still exist in the installed
  `@liamcottle/meshcore.js` — the mirror image of meshcore-ts's drift test, so a
  dependency bump that changes the contract fails here.
- CI workflow green; release workflow staged (Trusted Publishing configured on
  npmjs.com for `@dpup/meshcore-sim`, repo `dpup/meshcore-sim`).
- **Done when:** CI passes on a PR; `npm version patch && git push --follow-tags`
  would publish.

---

## 5. Testing strategy

- **Unit** per module (builders, clock, random, serialize, encode).
- **Contract/integration** is the centre of gravity: drive a **real
  `MeshCoreClient`** over `SimConnection` and assert on the *app-visible*
  behavior (named events, normalized models, typed errors) — never on sim
  internals. This is what proves drop-in fidelity (PRD §9.2 "as close as
  feasible").
- **Provenance/adversarial:** the admin-gate negative cases and
  decrypt-verification outcomes get dedicated tests — the inputs you cannot
  safely make on hardware (PRD §2).
- **Determinism:** seeded generators and clock produce byte-identical output
  across runs; assert it.
- **Time-domain:** a representative coalescer-style harness test (debounce window
  collapsed via the virtual clock) to validate the clock is fit for its stated
  purpose, even though the real coalescer lives in `checkmate`.
- No hardware. Capture-and-replay (PRD §6) is a later add — note as a stub.

---

## 6. PRD open questions — decisions carried into the build

- **§9.1 typed contract:** use `@dpup/meshcore-ts` (+ peer `@liamcottle/
  meshcore.js` for raw types/Constants). *Settled.*
- **§9.2 fidelity:** conform to the raw `Connection` surface as closely as
  feasible; validate via real-`MeshCoreClient` integration tests.
- **§9.3 latency/ordering realism:** model **arrival time, order, and loss**
  only — enough for coalescer edges; explicitly no RF propagation. *Decided.*
- **§9.4 adverts/telemetry in v1:** **yes, model them** — they are cheap on the
  raw contract (push codes already exist) and the live-traffic stream the PRD
  cares about includes adverts. Telemetry as opaque LPP bytes (no sensor sim).
- **§9.5 packaging:** standalone repo `@dpup/meshcore-sim` (this repo). *Settled.*

---

## 7. Sequencing & checkpoints

```
M0 ──▶ M1 ──▶ M2 ──┐
                   ├─▶ M3 (static reads)  ─┐
                   └─▶ M4 (dynamic/provenance) ─┬─▶ M5 ─▶ M6 ─▶ M7 (demo) ─▶ M8 ─▶ M9
                                               
```
Natural PR boundaries: **(A)** M0–M3 — scaffold + static world drop-in;
**(B)** M4 — dynamic engine + provenance (the core value); **(C)** M5–M6 —
generation + freezing; **(D)** M7–M9 — demo, docs, release.

Suggested first PR: **(A)**, ending with a passing integration test that reads a
hand-built world through a real `MeshCoreClient`. That single test de-risks the
entire contract assumption before any generation work.

---

## 7a. Execution orchestration & human-involvement map

This plan is executed **autonomously, subagent-driven, fully hands-off to the
end** (decided 2026-05-26). Commits land per milestone directly on `main`
(local; no remote/GitHub repo yet).

**Loop, per milestone Mn:**
1. Orchestrator spawns one implementation subagent with the milestone spec +
   conventions + done-when, instructed to run `typecheck`/`test`/`build` and
   report. (M0 scaffold done by the orchestrator directly — precision-critical
   template-mirroring.)
2. Orchestrator **independently re-runs the validation gates** — self-reports are
   never trusted.
3. Green → commit. Red → fix directly or via a targeted fix subagent, **bounded
   to 2 attempts**, then escalate.

**Validation gates (the human's proxy):** `bun run typecheck`, `bun run test`,
`bun run build`, the `TS7016` throwaway-consumer probe, `bun run docs:check`,
plus each milestone's machine-checkable done-when. The spine is
**integration tests driving a real `MeshCoreClient` over `SimConnection`** —
the actual proof of drop-in fidelity.

**Human involvement — only these:**
- *Setup* (done): cadence + git strategy.
- *Mid-run escalation* (rare, by design): a validation gate that fails twice, or
  an unforeseen **public-API** design fork.
- *Final*: review the result; then the two things only a human can do —
  configure npm **Trusted Publishing** on npmjs.com for `@dpup/meshcore-sim`, and
  authorize the release tag/publish. (M9 stages the workflow; it does not
  publish.)

## 8. Out of scope (v1) — from PRD §8

- Network-layer simulator speaking the MeshCore wire protocol (a later fidelity
  tier).
- RF propagation, spreading-factor/range/collision/duty-cycle modeling.
- Generative/emergent node behavior; real cryptography; a faithful digital twin.
- Capture-and-replay from hardware (designed-for via serialization; not built in
  v1 — leave a typed stub + guide note).
