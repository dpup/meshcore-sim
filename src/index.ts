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
