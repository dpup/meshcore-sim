/**
 * The dynamic-fixture timeline — a time-ordered sequence of events the simulated
 * world produces (PRD §5).
 *
 * Where {@link MeshWorld} is the static *snapshot*, a {@link Scenario} is the
 * *timeline*: messages arriving, a node going offline, telemetry updates,
 * adverts. It is what exercises the time-domain logic the simulator exists for
 * (PRD §2): a coalescer's debounce window, a burst arriving inside a window, the
 * admin-channel gate's negative cases, and failure modes.
 *
 * The discriminated union {@link SimEvent} is the core design surface. The
 * PRD's sketch (§7) carried a single `message` kind with `channelId` +
 * `decryptVerified` booleans; this refines that. **There is no
 * `decryptVerified` flag on the wire** — decrypt-verification is expressed
 * *structurally* (AGENTS.md, the provenance table), so the event model expresses
 * it structurally too:
 *
 * - {@link MessageEvent} is a *direct* message from a contact — it always
 *   surfaces as a verified `contactMessage`.
 * - {@link ChannelMessageEvent} carries an explicit `verified` flag (default
 *   `true`). A verified channel message surfaces as a `channelMessage` (the
 *   device held the key and decoded it); an *unverified* one surfaces as raw
 *   `channelData` (bytes the device could not decode) and **never** as a
 *   verified `channelMessage`. The unverified case on the admin channel index is
 *   exactly the admin-gate adversarial input you cannot make on hardware.
 *
 * Splitting "direct message" from "channel message" (rather than one `message`
 * kind tagged with a channel) makes the two provenance paths — keyed by sender
 * prefix vs. keyed by channel index — type-distinct at the authoring layer,
 * matching how the raw protocol distinguishes them.
 */

import { toMillis } from "./duration.js";
import { SimError } from "./errors.js";
import type { Duration } from "./duration.js";
import type { TxtType } from "@dpup/meshcore-ts";

/**
 * A direct message from a contact node — the verified-`contactMessage` path.
 *
 * Surfaces (with `autoSync`) as the client's `contactMessage` event, keyed by
 * the sender node's `pubKeyPrefix` (the first 6 bytes of its public key).
 */
export interface MessageEvent {
  kind: "message";
  /** Id of the {@link SimNode} that sent the message. */
  from: string;
  /** The message text. */
  text: string;
  /**
   * Text payload type. Defaults to `TxtType.Plain`; pass `TxtType.SignedPlain`
   * for a signed-plain message.
   */
  txtType?: TxtType;
  /**
   * Received signal strength, in dBm. Verified contact messages carry no
   * rssi/snr on the wire, so when set this rides on an additional `LogRxData`
   * push (see {@link SimConnection}).
   */
  rssi?: number;
  /** Received signal-to-noise ratio, in dB. See {@link MessageEvent.rssi}. */
  snr?: number;
  /**
   * Optional sender-clock offset (ms, relative to connect time) used as the
   * `senderTimestamp` in the encoded `RawContactMessage`.
   *
   * When absent (the normal case), `senderTimestamp` is derived from
   * `clock.now()` at the moment the event fires. When present, the supplied
   * offset is used instead — enabling out-of-order scenarios where arrival
   * order (`at`) differs from sender-timestamp order (`sentAt`). See
   * {@link outOfOrder} in `traffic.ts`.
   */
  sentAt?: number;
}

/**
 * Traffic on a channel — the channel-message path, verified or not.
 *
 * With `verified: true` (the default) it surfaces as the client's
 * `channelMessage` event with the decoded `text` and the channel's
 * `channelIdx` (the device held the key and decoded it). With `verified:
 * false` it surfaces as a `channelData` event carrying the raw bytes and `snr`
 * but **no decoded text**, and never as a verified `channelMessage` — the
 * admin-gate negative case.
 */
export interface ChannelMessageEvent {
  kind: "channelMessage";
  /** Channel slot index, or a channel name resolved against the world. */
  channel: number | string;
  /**
   * Optional sender node id (informational; channel traffic is not keyed by
   * sender on the wire).
   */
  from?: string;
  /** The message text (decoded, for verified; encoded to bytes, for unverified). */
  text: string;
  /**
   * Whether the device decrypt-verified this traffic. Defaults to `true`.
   * `false` produces unverified `channelData` — the admin-gate negative case.
   */
  verified?: boolean;
  /** Received signal strength, in dBm. Rides on the unverified/raw path. */
  rssi?: number;
  /** Received signal-to-noise ratio, in dB — carried on `channelData.snr`. */
  snr?: number;
  /**
   * Optional sender-clock offset (ms, relative to connect time) used as the
   * `senderTimestamp` in the encoded `RawChannelMessage`.
   *
   * When absent, `senderTimestamp` is derived from `clock.now()`. When present,
   * the supplied offset overrides it — enabling out-of-order channel scenarios.
   * See {@link outOfOrder} in `traffic.ts`.
   */
  sentAt?: number;
}

/**
 * A node's reachability changing mid-timeline — a failure mode (PRD §2).
 *
 * Mutates the referenced node's `reachable` flag in the world, so a subsequent
 * remote read (`getStatus`/`getTelemetry`/`getNeighbours`) against it begins
 * rejecting (offline) or resolving (back online).
 */
export interface NodeStateEvent {
  kind: "nodeState";
  /** Id of the {@link SimNode} whose state changes. */
  nodeId: string;
  /** The node's new reachability. */
  reachable: boolean;
}

/**
 * A telemetry report from a node — emits a `TelemetryResponse` push, surfacing
 * as the client's `telemetryResponse` event keyed by the node's prefix.
 */
export interface TelemetryEvent {
  kind: "telemetry";
  /** Id of the {@link SimNode} reporting telemetry. */
  nodeId: string;
  /** Opaque LPP sensor bytes (no sensor simulation — telemetry is opaque). */
  lppSensorData?: Uint8Array;
}

/**
 * An advertisement from a node — emits an `Advert` push, surfacing as the
 * client's `advert` event with the node's hex public key.
 */
export interface AdvertEvent {
  kind: "advert";
  /** Id of the {@link SimNode} advertising. */
  nodeId: string;
}

/**
 * One thing the simulated world does at a point on the timeline.
 *
 * A discriminated union on `kind`; see the per-member docs and the module
 * overview for how each maps onto the raw protocol (the provenance table).
 */
export type SimEvent =
  | MessageEvent
  | ChannelMessageEvent
  | NodeStateEvent
  | TelemetryEvent
  | AdvertEvent;

/**
 * A {@link SimEvent} bound to a time offset.
 *
 * `at` is **relative to connect time** — the moment `client.connect()` resolves
 * — so a scenario reads as "at +2s a message arrives", independent of the
 * clock's absolute start.
 */
export interface ScheduledEvent {
  /** When the event fires, relative to connect time. */
  at: Duration;
  /** The event to fire. */
  event: SimEvent;
}

/**
 * A dynamic fixture — a validated, time-sorted list of {@link ScheduledEvent}s.
 *
 * Build one with {@link scenario}; never assemble by hand, so every scenario is
 * the same validated, sorted object.
 */
export interface Scenario {
  /** The events, sorted ascending by `at` (stable for equal offsets). */
  readonly events: ReadonlyArray<ScheduledEvent>;
}

/**
 * Ergonomic helper: pair a time offset with an event.
 *
 * @example
 * ```ts
 * scenario([
 *   at("1s", { kind: "message", from: "rocky", text: "hi" }),
 *   at("2s", { kind: "advert", nodeId: "rocky" }),
 * ]);
 * ```
 */
export function at(d: Duration, event: SimEvent): ScheduledEvent {
  return { at: d, event };
}

/**
 * Assemble and validate a {@link Scenario} — the single constructor every
 * scenario passes through.
 *
 * Validates each `at` is a well-formed {@link Duration} (via {@link toMillis})
 * and sorts the events ascending by offset. The sort is **stable**: events with
 * the same offset keep their authoring order, so a burst authored in send order
 * fires in send order.
 *
 * @throws {SimError} If any event has an invalid `at` duration.
 */
export function scenario(events: ScheduledEvent[]): Scenario {
  // Validate every offset up front so authoring errors surface immediately,
  // not lazily when the clock reaches them.
  const decorated = events.map((e, index) => {
    try {
      return { ms: toMillis(e.at), index, event: e };
    } catch (cause) {
      throw new SimError(
        `scenario: event #${index} (kind "${e.event.kind}") has an invalid \`at\`: ${String(cause)}`,
        { cause },
      );
    }
  });

  // Stable ascending sort by offset, breaking ties by authoring index.
  decorated.sort((a, b) => a.ms - b.ms || a.index - b.index);

  return { events: decorated.map((d) => d.event) };
}
