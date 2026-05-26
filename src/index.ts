/**
 * meshcore-sim — a deterministic, behavioral MeshCore network simulator for
 * testing `@dpup/meshcore-ts` / `@liamcottle/meshcore.js` apps without radios.
 *
 * It models the *observable behavior* of a mesh — message arrival, ordering,
 * loss, signal metadata, node state, channel and decrypt outcomes — not RF
 * physics. {@link SimConnection} is a drop-in for a meshcore.js `Connection`:
 * inject it where an app would use a real TCP/serial connection, drive a
 * {@link SimClock}, and assert on what the app observed.
 *
 * @example
 * ```ts
 * import { MeshCoreClient } from "@dpup/meshcore-ts";
 * import { SimConnection, defineWorld, SimClock } from "@dpup/meshcore-sim";
 *
 * const world = defineWorld({ homeNodeId: "home" });
 * const clock = new SimClock();
 * const sim = new SimConnection({ world, clock });
 * const client = new MeshCoreClient(sim.asConnection());
 * await client.connect();
 * ```
 *
 * @packageDocumentation
 */

/** The package version (kept in sync with package.json at release time). */
export const VERSION = "0.1.0";

// World builders (the single validated constructor path) + the seeded PRNG.
export { channel, contact, defineWorld, node } from "./builders.js";
export type { WorldSpec } from "./builders.js";
export { SeededRandom } from "./random.js";

// Deterministic helpers.
export { toMillis } from "./duration.js";
export type { Duration } from "./duration.js";
export { deriveNodeKey } from "./keys.js";

// Virtual clock — the test-time injectable for time-domain testing (§5).
export { SimClock } from "./clock.js";
export type { Clock, TimerHandle } from "./clock.js";

// The raw `Connection` drop-in — inject into a `MeshCoreClient`.
export { SimConnection } from "./connection.js";
export type { SimConnectionOptions } from "./connection.js";

// Dynamic-fixture timeline — the scenario engine (M4).
export { at, scenario } from "./scenario.js";
export type {
  AdvertEvent,
  ChannelMessageEvent,
  MessageEvent,
  NodeStateEvent,
  Scenario,
  ScheduledEvent,
  SimEvent,
  TelemetryEvent,
} from "./scenario.js";

// Errors.
export { SimError } from "./errors.js";

// Static fixture object model (value enums + types).
export { ChannelKind, NodeRole } from "./world.js";
export type {
  MeshWorld,
  RadioConfig,
  SimChannel,
  SimContact,
  SimNode,
} from "./world.js";
