# meshcore-sim — A behavioral test simulator for MeshCore apps

**Spec · v0.2 · Draft**

## 1. What it is

`meshcore-sim` is a standalone TypeScript library that simulates a MeshCore
network for **testing meshcore.js-based apps without radios**. It is built to
test `meshcore-mcp` and `checkmate`, but coupled to neither — it is a general
MeshCore test tool.

It is deliberately **not a digital twin**. It models the *observable behavior* of
a mesh — message arrival, latency, ordering, loss, signal metadata, node state,
channel and decrypt outcomes — not RF physics. A test needs the shape of what the
device reports, not a faithful radio model.

## 2. What it is for

Some of the most logic-dense, bug-prone parts of this system are barely testable
any other way:

- **The coalescer / debounce** (checkmate §5) is pure time-domain logic —
  trailing debounce, max-wait, priority lane, per-thread windows. It cannot be
  tested with a static stub (no time) or reliably with hardware (real seconds,
  non-reproducible). A scripted timeline plus a controllable clock is the only
  good way.
- **The admin-channel gate** (checkmate §8) must be tested on its *negative*
  cases — a message that claims the admin channel but is not decrypt-verified, or
  comes from an unapproved sender. Those are adversarial inputs you cannot, and
  should not, produce on real hardware.
- **Failure modes** — node offline, packet loss, reconnection, an unreachable
  remote node — are hard to stage reliably with hardware.
- **CI and local development** run with no radio attached, deterministically.

`meshcore-sim` is what makes these testable. It is a development/test dependency,
never shipped in production.

## 3. Integration and dependency direction

`meshcore-sim` is **standalone**. It knows nothing of `meshcore-mcp` or
`checkmate`. It simulates a meshcore.js connection and depends only on the
**meshcore.js API contract** — the public surface any meshcore.js-based app
already consumes.

It slots in at the **SDK layer**: `SimConnection` is a drop-in for meshcore.js's
connection classes (`TCPConnection`, serial). Any meshcore.js-based app injects
it where it would use a real connection — `meshcore-mcp` does exactly that in its
tests. It is the natural grown-up form of a hand-written stub: the same
interface, a simulated world behind it instead of canned returns.

**Dependency direction:** `meshcore-mcp` depends on `meshcore-sim` (a dev/test
dependency); `meshcore-sim` never depends on `meshcore-mcp`. The contract between
them is meshcore.js's own connection API, owned by neither. Run through a
sim-backed `meshcore-mcp`, `checkmate`'s coalescer, gate, and conversation policy
are exercised the same way.

A **network-layer** integration — a fake device speaking the MeshCore wire
protocol, so unmodified `meshcore.js` connects to it — is deliberately *out of
scope for v1*. It buys only one extra thing: testing `meshcore.js` and the typed
wrapper themselves. It is a later fidelity tier (§8).

## 4. Design principles

- **Behavioral, not physical.** Model observable outputs — latency, ordering,
  loss, RSSI/SNR, channel identity, decrypt-verification — never RF propagation
  or real cryptography. Model the *outcome* ("this event is decrypt-verified on
  channel X"), not the mechanism.
- **Deterministic.** Every run is reproducible. Randomness is allowed, but only
  **seeded** — `seed` in, identical fixture out. No AI, no wall-clock-derived
  variation.
- **Fixtures must be cheap to author**, or coverage stays thin and the hard
  pieces stay under-tested (§6).
- **One fixture object model.** Generated and hand-written fixtures are the same
  kind of object, built through the same validated constructors — so a generator
  can never produce an internally inconsistent world.
- **Fixtures are serializable.** Any fixture, generated or not, can be dumped to
  a declarative form, inspected, and committed.

## 5. Fixtures and the virtual clock

A fixture comes in two kinds. They are not separate subsystems — they describe
the same simulated world, one as a snapshot and one as a timeline.

**Static fixture — a world snapshot.** The mesh as observable through the home
node: nodes (the home node plus reachable remote nodes), their health and radio
config, contacts, and channels. Deterministic reads run against it — "given this
world, `get_node_health('rocky-ridge')` returns X." Covers most of
`meshcore-mcp`'s read surface.

**Dynamic fixture — a timeline.** A time-ordered sequence of events the world
produces — messages arriving, a node going offline, telemetry updates, adverts —
plus the world's reactions to the app's own actions (a sent message propagates,
contacts receive it, a scripted reply returns). This is what exercises the
coalescer, the live-traffic subscription, reconnection, and failure handling.

Every event carries **provenance** — message id, sender, and, critically,
**channel identity and decrypt-verification status** — matching what
`meshcore-mcp`'s live-traffic stream is required to surface. Producing events
with arbitrary provenance, including invalid combinations, is what makes the
admin gate's negative cases testable.

**The virtual clock.** Dynamic fixtures run on a simulated clock the test
controls — advance it, jump it, run until a time. Without this, a 30-second
debounce window means a 30-second test. `meshcore-sim` provides this clock as
`SimClock`. Correspondingly, it is a **settled design rule** that `meshcore-mcp`
and `checkmate` take their time from an **injected clock** — a small, generic
abstraction (a `now()` plus timer scheduling), never raw `setTimeout` /
`Date.now()`. In production that clock is a real implementation; in tests it is
`SimClock`. A clock shape is universal, so this is an interface the apps own and
`SimClock` satisfies — not a coupling to `meshcore-sim`.

## 6. Fixture generation

Generation is an **authoring path, not a third fixture kind** — a cheap way to
produce either a static world or a dynamic timeline. It is what makes the sim
actually get used. All of it is deterministic; none of it needs AI.

- **Builders with strong defaults.** `node('rocky-ridge')` returns a fully-formed
  node — default battery, radio config, last-heard — and a test overrides only
  the field it cares about. The test then reads as "a mesh where rocky-ridge has
  low battery"; everything else is defaulted and invisible.
- **Parameterized procedural generators** for scale — an N-node mesh with a given
  number of repeaters and a sensible topology, from a few knobs, rather than
  hand-placing every node.
- **Seeded randomness** is the enabler: a generator may use a PRNG for variety —
  names, battery levels, traffic jitter — and stay perfectly reproducible because
  the seed is fixed. Deterministic does not mean no randomness; it means seeded.
- **Scenario generators** for timelines — `burst`, `crosstalk`, `quiet`,
  `out-of-order` — emit timed event sequences with seeded jitter. Generating "a
  three-message burst" cheaply is exactly what makes the coalescer well-tested.
- **Capture-and-replay** — record a real mesh session once from hardware and
  freeze it to a fixture. Authored by reality, replayed deterministically.

Because fixtures are serializable, a generated fixture can be **frozen**:
generate once, inspect, snapshot to a committed file, and use it as a stable
regression fixture thereafter. Generation and committed fixtures are not at odds
— generation is how you author the committed ones cheaply.

Two guardrails. Generators produce *plausible-shaped* fixtures — sensible
defaults, seeded jitter — never *simulated* ones; a generator that "knows" LoRa
propagation is the RF-physics over-build returning by the side door. And keep the
knob count low: a generator with thirty parameters is as much setup as
hand-writing.

## 7. Interface sketches

Illustrative TypeScript — shapes, not final signatures. `Duration` is a
millisecond count or a string like `"30s"`.

```ts
// --- The simulated world (static fixture) ---

interface MeshWorld {
  homeNodeId: string;          // the node meshcore-mcp connects to
  nodes: SimNode[];            // home node + reachable remote nodes
  channels: SimChannel[];
  contacts: SimContact[];
}

interface SimNode {
  id: string;
  name: string;
  role: "companion" | "repeater" | "roomserver";
  reachable: boolean;          // for offline / unreachable testing
  battery?: number;
  radioConfig?: Record<string, number>;
  adminCommands?: string[];    // enumerated admin commands this node accepts
}

interface SimChannel {
  id: string;
  name: string;
  kind: "public" | "private";  // drives decrypt-verification outcomes
}

interface SimContact { publicKey: string; name: string; nodeId: string; }

// --- The timeline (dynamic fixture) ---

interface Scenario { events: ScheduledEvent[]; }

interface ScheduledEvent { at: Duration; event: SimEvent; }

type SimEvent =
  | { kind: "message"; from: string; channelId: string;
      decryptVerified: boolean; text: string; rssi?: number; snr?: number }
  | { kind: "node_state"; nodeId: string; reachable: boolean }
  | { kind: "telemetry"; nodeId: string; data: Record<string, unknown> }
  | { kind: "advert"; nodeId: string };

// --- The virtual clock (test-time impl of the clock the apps inject; §5) ---

interface SimClock {
  now(): number;
  advance(by: Duration): void;
  runUntil(t: number): void;   // fire all scheduled events up to t
}

// --- The connection (SDK-layer integration) ---
// A drop-in for meshcore.js's connection classes (TCPConnection, serial). Any
// meshcore.js-based app injects this in place of a real connection.
// meshcore-sim conforms to the meshcore.js API contract — no knowledge of
// meshcore-mcp.

class SimConnection /* conforms to the meshcore.js connection API */ {
  constructor(opts: { world: MeshWorld; scenario?: Scenario; clock: SimClock });
}

// --- Authoring: builders and generators ---

function defineWorld(spec: Partial<MeshWorld>): MeshWorld;          // builder + defaults
function generateWorld(opts: {                                      // procedural
  seed: number; nodes: number; repeaters?: number;
}): MeshWorld;

const traffic: {
  burst(opts: { from: string; count: number; within: Duration; seed?: number }): Scenario;
  crosstalk(opts: { nodes: string[]; within: Duration; seed?: number }): Scenario;
  quiet(opts: { duration: Duration }): Scenario;
};

function serializeWorld(w: MeshWorld): string;   // freeze to a committed fixture
function loadWorld(json: string): MeshWorld;
```

A test then reads roughly: build or generate a `MeshWorld` and optional
`Scenario`, construct a `SimClock` and a `SimConnection` over them, hand the
connection to `meshcore-mcp`, advance the clock, and assert.

## 8. Scope boundaries

- **Core — v1.** SDK-layer `SimConnection`; static and dynamic fixtures; the
  virtual clock; deterministic, seeded generation; modeling observable behavior
  (latency, ordering, loss, signal metadata, channel and decrypt outcomes).
- **Later — optional.** A network-layer simulator speaking the MeshCore wire
  protocol, to exercise `meshcore.js` and the typed wrapper end to end.
- **Out of scope.** A real RF propagation model (spreading factor, range,
  collisions, duty cycle); generative or emergent node behavior; a faithful
  "digital twin." Those are a research-grade simulator, not a test tool.

## 9. Open questions

1. meshcore.js ships untyped. `meshcore-sim` needs a typed description of the
   meshcore.js connection API to implement against. Decide whether that typed
   contract is the standalone typed-meshcore.js-wrapper package (shared with
   `meshcore-mcp`) or lives within `meshcore-sim` — it belongs to neither
   `meshcore-mcp` nor `checkmate`. DECISION: use our own ``@dpup/meshcore-ts` lib
2. How faithfully `SimConnection` must mirror meshcore.js's exact event and
   method surface for true drop-in compatibility. DECISION: As close as feasible.
3. How much latency and ordering realism the dynamic model needs — enough to
   exercise the coalescer's edge cases, without drifting toward RF simulation.
4. Whether v1 models adverts and telemetry, or only messages and node-state
   changes.
5. Packaging — its own repository, or a workspace package alongside
   `meshcore-mcp`. DECISION: `@dpup/meshcore-sim`