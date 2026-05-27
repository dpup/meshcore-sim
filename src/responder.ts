/**
 * Reactive replies — the "world reacts to the app's actions" half of the v1
 * goal (PRD §2). Where a {@link Scenario} is an *unconditional* timeline the
 * world produces, a {@link Responder} is *triggered by an outbound send*: the
 * app sends a message, a matching responder schedules a reply on the
 * {@link SimClock}, and the reply is delivered through the same device-queue
 * model as any other message (AGENTS.md "don't-regress" #1).
 *
 * This makes request/response round-trips testable and an interactive
 * sim-backed server usable: remote-admin (`login` → `sendTextMessage(...,
 * CliData)` → await the reply), echo bots, and command bots all become a few
 * lines of fixture rather than a pre-scripted, timing-guessed `message` event.
 *
 * Replies stay deterministic: each is scheduled at `clock.now() +
 * toMillis(after)` and fires as the clock advances — no wall-clock, no
 * `Date.now()`.
 */

import type { Duration } from "./duration.js";
import type { TxtType } from "@dpup/meshcore-ts";

/**
 * The outbound send a {@link Responder} matches against — a normalized view of
 * a `sendTextMessage` (`kind: "contact"`) or `sendChannelTextMessage`
 * (`kind: "channel"`) call.
 */
export interface OutboundMessage {
  /** Which send produced this: a direct contact message or a channel message. */
  kind: "contact" | "channel";
  /** The message text. */
  text: string;
  /**
   * Destination node id, for a direct (`contact`) send — resolved from the
   * `contactPublicKey` against the world. `undefined` for a channel send, or if
   * the key matches no known node.
   */
  to?: string;
  /** Text payload type, for a direct send (e.g. `TxtType.CliData`). */
  txtType?: number;
  /** Channel slot index, for a `channel` send. */
  channel?: number;
}

/**
 * A reply delivered as a direct `contactMessage` from a node — the request/
 * response and remote-admin shape. Surfaces (with `autoSync`) as the client's
 * `contactMessage` event keyed by `from`'s `pubKeyPrefix`.
 */
export interface ContactReply {
  /** Id of the {@link SimNode} the reply comes from. */
  from: string;
  /** The reply text. */
  text: string;
  /**
   * Delay before the reply is delivered, on the sim clock, relative to the send
   * (default `0` — delivered on the next clock advance). Use it to model a
   * round-trip latency.
   */
  after?: Duration;
  /** Text payload type. Defaults to `TxtType.Plain`. */
  txtType?: TxtType;
  /** Received signal strength, in dBm (rides on a `LogRxData` push). */
  rssi?: number;
  /** Received signal-to-noise ratio, in dB. */
  snr?: number;
}

/**
 * A reply delivered as channel traffic — for channel command/echo bots.
 * Surfaces as a verified `channelMessage` (default) or, with `verified: false`,
 * as unverified `channelData`.
 */
export interface ChannelReply {
  /** Channel slot index, or a channel name resolved against the world. */
  channel: number | string;
  /** The reply text. */
  text: string;
  /** Delay before delivery, on the sim clock (default `0`). See {@link ContactReply.after}. */
  after?: Duration;
  /** Whether the device decrypt-verifies the reply. Defaults to `true`. */
  verified?: boolean;
  /** Received signal strength, in dBm. */
  rssi?: number;
  /** Received signal-to-noise ratio, in dB. */
  snr?: number;
}

/**
 * One reply a responder produces — a direct {@link ContactReply} or a
 * {@link ChannelReply}. Discriminated structurally: a `channel` field marks a
 * channel reply, otherwise it is a contact reply.
 */
export type ResponderReply = ContactReply | ChannelReply;

/**
 * A reactive reply rule. On each matching outbound send, {@link reply} runs and
 * its result (one reply, several, or none) is scheduled on the clock.
 *
 * @example
 * ```ts
 * new SimConnection({
 *   world, clock,
 *   responders: [
 *     {
 *       to: "rocky-ridge",
 *       when: (m) => m.txtType === TxtType.CliData,
 *       reply: (m) => ({ from: "rocky-ridge", text: `OK - ${m.text}`, after: "2s" }),
 *     },
 *   ],
 * });
 * ```
 */
export interface Responder {
  /**
   * Match only sends to this destination node id (a direct-send target). When
   * omitted, the responder matches any send (subject to {@link when}) — useful
   * for an echo bot or a channel responder keyed purely on {@link when}.
   */
  to?: string;
  /**
   * Optional predicate over the outbound message. When omitted, every send that
   * passes {@link to} matches.
   */
  when?: (msg: OutboundMessage) => boolean;
  /**
   * Produce the reply (or replies) for a matched send. Return `undefined` (or an
   * empty array) to match without replying.
   */
  reply: (msg: OutboundMessage) => ResponderReply | ResponderReply[] | undefined;
}

/** Type guard: is this reply a {@link ChannelReply}? */
export function isChannelReply(reply: ResponderReply): reply is ChannelReply {
  return "channel" in reply;
}
