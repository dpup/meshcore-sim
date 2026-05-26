/**
 * Pure encoders mapping the friendly fixture model (`MeshWorld`, `SimNode`,
 * `SimChannel`) to the raw meshcore.js wire shapes (`RawSelfInfo`, `RawContact`,
 * `RawRepeaterStats`, …) that `SimConnection` returns.
 *
 * "Raw at the boundary" (AGENTS.md): the wire speaks `Uint8Array` keys,
 * **epoch-seconds** integers, micro-degree lat/lon, and integer flags; the
 * friendly authoring model speaks hex strings, degrees, and percentages. These
 * functions are the single, side-effect-free translation between the two — so
 * they can be unit-tested in isolation (`test/encode.test.ts`) and reused by the
 * connection layer.
 *
 * Synthesized values are **plausible-shaped, never RF-simulated** (PRD
 * guardrail): a repeater's battery millivolts reflect its modeled percentage,
 * counters default to zero, neighbour/telemetry payloads are empty for now
 * (richer topology arrives in M5). Nothing here models radio physics.
 */

import { Constants } from "@liamcottle/meshcore.js";
import type {
  RawAdvert,
  RawChannel,
  RawChannelData,
  RawChannelMessage,
  RawContact,
  RawContactMessage,
  RawCoreStatsData,
  RawDeviceInfo,
  RawLogRxData,
  RawNeighboursResult,
  RawPacketStatsData,
  RawRadioStatsData,
  RawRepeaterStats,
  RawSelfInfo,
  RawStats,
  RawTelemetryResponse,
} from "@liamcottle/meshcore.js";
import { fromHex, TxtType } from "@dpup/meshcore-ts";

import { NodeRole, type MeshWorld, type SimChannel, type SimNode } from "./world.js";

/**
 * Fixed base epoch (seconds) for the simulator's device clock: `2024-01-01T00:00:00Z`.
 *
 * Raw timestamps are derived as `DEVICE_EPOCH_BASE_SECS + floor(clock.now() / 1000)`
 * so they are **deterministic** — never wall-clock-derived — and still advance as
 * the {@link import("./clock.js").SimClock | SimClock} does.
 */
export const DEVICE_EPOCH_BASE_SECS = 1_704_067_200;

/** Width of the fixed-size `outPath` buffer the device exposes, in bytes. */
const OUT_PATH_BYTES = 64;

/** Battery millivolts modeled at 0% charge (a flat 3.0 V floor). */
const BATTERY_MV_AT_EMPTY = 3000;
/** Battery millivolts modeled at 100% charge (a full 4.2 V cell). */
const BATTERY_MV_AT_FULL = 4200;

/** Length of a public-key prefix, in bytes (matches meshcore's `pubKeyPrefix`). */
const PUB_KEY_PREFIX_BYTES = 6;

/**
 * Convert a {@link SimClock}-style millisecond reading to a deterministic raw
 * epoch-seconds timestamp anchored at {@link DEVICE_EPOCH_BASE_SECS}.
 */
export function epochSecsOf(nowMs: number): number {
  return DEVICE_EPOCH_BASE_SECS + Math.floor(nowMs / 1000);
}

/** Convert degrees (the authoring unit) to integer micro-degrees (the wire unit). */
export function microDegrees(degrees: number | undefined): number {
  return Math.round((degrees ?? 0) * 1e6);
}

/**
 * Map a node's role to meshcore's `AdvType` integer:
 * `companion → Chat (1)`, `repeater → Repeater (2)`, `roomserver → Room (3)`.
 */
export function advTypeOf(role: SimNode["role"]): number {
  switch (role) {
    case NodeRole.Repeater:
      return Constants.AdvType.Repeater;
    case NodeRole.RoomServer:
      return Constants.AdvType.Room;
    case NodeRole.Companion:
    default:
      return Constants.AdvType.Chat;
  }
}

/**
 * Map a battery percentage (`0..100`) to millivolts with a simple linear model:
 * 3000 mV at 0% rising to 4200 mV at 100%. Undefined battery is treated as full.
 * The percentage is clamped to `[0, 100]` before mapping.
 */
export function batteryMilliVoltsOf(node: SimNode): number {
  const pct = Math.max(0, Math.min(100, node.battery ?? 100));
  return Math.round(BATTERY_MV_AT_EMPTY + (BATTERY_MV_AT_FULL - BATTERY_MV_AT_EMPTY) * (pct / 100));
}

/** First {@link PUB_KEY_PREFIX_BYTES} bytes of a node's public key. */
export function pubKeyPrefixOf(node: SimNode): Uint8Array {
  return fromHex(node.publicKey).subarray(0, PUB_KEY_PREFIX_BYTES);
}

/**
 * Encode the home node as a {@link RawSelfInfo}.
 *
 * The home node is the one the app connects through; its radio config and
 * identity become the device's self info. `maxTxPower` defaults to the
 * configured `txPower` when no explicit ceiling is modeled.
 */
export function selfInfoOf(world: MeshWorld): RawSelfInfo {
  const home = world.nodes.find((n) => n.id === world.homeNodeId);
  if (home === undefined) {
    // defineWorld guarantees the home node exists; guard for a self-documenting
    // invariant rather than returning a malformed shape.
    throw new Error(`selfInfoOf: home node "${world.homeNodeId}" not found in world`);
  }
  const radio = home.radioConfig;
  const txPower = radio?.txPower ?? 0;
  return {
    type: advTypeOf(home.role),
    txPower,
    maxTxPower: txPower,
    publicKey: fromHex(home.publicKey),
    advLat: microDegrees(home.lat),
    advLon: microDegrees(home.lon),
    reserved: new Uint8Array(32),
    manualAddContacts: 0,
    radioFreq: radio?.freq ?? 0,
    radioBw: radio?.bw ?? 0,
    radioSf: radio?.sf ?? 0,
    radioCr: radio?.cr ?? 0,
    name: home.name,
  };
}

/**
 * Encode a node as a {@link RawContact} as it would appear in the home device's
 * contact table.
 *
 * `outPath` is the fixed-width 64-byte buffer with `outPathLen: 0` (direct, no
 * stored path) until path modeling arrives. `lastAdvert`/`lastMod` use the
 * supplied device-epoch seconds so reads are deterministic.
 */
export function contactOf(node: SimNode, nowSecs: number): RawContact {
  return {
    publicKey: fromHex(node.publicKey),
    type: advTypeOf(node.role),
    flags: 0,
    outPathLen: 0,
    outPath: new Uint8Array(OUT_PATH_BYTES),
    advName: node.name,
    lastAdvert: nowSecs,
    advLat: microDegrees(node.lat),
    advLon: microDegrees(node.lon),
    lastMod: nowSecs,
  };
}

/** Encode a configured channel slot as a {@link RawChannel}. */
export function channelOf(channel: SimChannel): RawChannel {
  return {
    channelIdx: channel.idx,
    name: channel.name,
    secret: fromHex(channel.secret),
  };
}

/** Encode device firmware / model info as a {@link RawDeviceInfo}. */
export function deviceInfoOf(node: SimNode): RawDeviceInfo {
  return {
    firmwareVer: node.firmwareVer ?? 1,
    reserved: new Uint8Array(0),
    firmware_build_date: "2024-01-01",
    manufacturerModel: node.model ?? "meshcore-sim",
  };
}

/**
 * Encode a node's status as a {@link RawRepeaterStats} (what `getStatus`
 * returns for a remote repeater).
 *
 * Battery millivolts reflect the node's modeled percentage; all counters and RF
 * metadata default to zero — plausible-shaped, never RF-simulated. Uptime is
 * derived from the device-epoch seconds so it advances deterministically with
 * the clock.
 */
export function repeaterStatsOf(node: SimNode, nowMs: number): RawRepeaterStats {
  return {
    batt_milli_volts: batteryMilliVoltsOf(node),
    curr_tx_queue_len: 0,
    noise_floor: 0,
    last_rssi: 0,
    n_packets_recv: 0,
    n_packets_sent: 0,
    total_air_time_secs: 0,
    total_up_time_secs: Math.floor(nowMs / 1000),
    n_sent_flood: 0,
    n_sent_direct: 0,
    n_recv_flood: 0,
    n_recv_direct: 0,
    err_events: 0,
    last_snr: 0,
    n_direct_dups: 0,
    n_flood_dups: 0,
  };
}

/** Encode local-device core stats as a {@link RawStats} of type `Core`. */
export function coreStatsOf(node: SimNode, nowMs: number): RawStats {
  const data: RawCoreStatsData = {
    batteryMilliVolts: batteryMilliVoltsOf(node),
    uptimeSecs: Math.floor(nowMs / 1000),
    queueLen: 0,
  };
  return { type: Constants.StatsTypes.Core, raw: new Uint8Array(0), data };
}

/** Encode local-device radio stats as a {@link RawStats} of type `Radio`. */
export function radioStatsOf(_node: SimNode): RawStats {
  const data: RawRadioStatsData = {
    noiseFloor: 0,
    lastRssi: 0,
    lastSnr: 0,
    txAirSecs: 0,
    rxAirSecs: 0,
  };
  return { type: Constants.StatsTypes.Radio, raw: new Uint8Array(0), data };
}

/** Encode local-device packet stats as a {@link RawStats} of type `Packets`. */
export function packetStatsOf(_node: SimNode): RawStats {
  const data: RawPacketStatsData = {
    recv: 0,
    sent: 0,
    nSentFlood: 0,
    nSentDirect: 0,
    nRecvFlood: 0,
    nRecvDirect: 0,
    nRecvErrors: 0,
  };
  return { type: Constants.StatsTypes.Packets, raw: new Uint8Array(0), data };
}

/**
 * Encode a node's neighbour table as a {@link RawNeighboursResult}.
 *
 * Empty for now — neighbour topology is synthesized from world links in M5.
 */
export function neighboursOf(_node: SimNode): RawNeighboursResult {
  return { totalNeighboursCount: 0, neighbours: [] };
}

/**
 * Encode a node's telemetry as a {@link RawTelemetryResponse}.
 *
 * `lppSensorData` is empty for now (no sensor simulation — telemetry is opaque
 * LPP bytes per the PRD); the verified prefix lets the client key the response.
 */
export function telemetryOf(node: SimNode, lppSensorData?: Uint8Array): RawTelemetryResponse {
  return {
    reserved: 0,
    pubKeyPrefix: pubKeyPrefixOf(node),
    lppSensorData: lppSensorData ?? new Uint8Array(0),
  };
}

// ---------------------------------------------------------------------------
// Dynamic-event encoders (M4) — message-queue and push payloads
// ---------------------------------------------------------------------------

/**
 * UTF-8 encode message text to the raw byte payload the unverified channel-data
 * path carries. The device, lacking the key, would only ever see the encrypted
 * bytes; the simulator does no real crypto, so it carries the plaintext bytes
 * verbatim — what matters for testing is that the *shape* is raw bytes with no
 * decoded `text` field, never a verified `channelMessage`.
 */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Encode a direct contact message as a {@link RawContactMessage} (the
 * verified-`contactMessage` queue shape).
 *
 * Keyed by the sender node's `pubKeyPrefix` (first 6 bytes of its key).
 * `senderTimestamp` is the device-epoch seconds of the supplied clock reading,
 * so arrival timestamps advance deterministically with the {@link
 * import("./clock.js").SimClock}. `txtType` defaults to `TxtType.Plain`.
 */
export function contactMessageOf(
  node: SimNode,
  text: string,
  nowMs: number,
  txtType: TxtType = TxtType.Plain,
): RawContactMessage {
  return {
    pubKeyPrefix: pubKeyPrefixOf(node),
    pathLen: 0,
    txtType,
    senderTimestamp: epochSecsOf(nowMs),
    text,
  };
}

/**
 * Encode a decrypt-verified channel message as a {@link RawChannelMessage} (the
 * verified-`channelMessage` queue shape).
 *
 * Carries the channel slot index and the *decoded* `text` — the device held the
 * key and decoded it. `txtType` defaults to `TxtType.Plain`.
 */
export function channelMessageOf(
  channelIdx: number,
  text: string,
  nowMs: number,
  txtType: TxtType = TxtType.Plain,
): RawChannelMessage {
  return {
    channelIdx,
    pathLen: 0,
    txtType,
    senderTimestamp: epochSecsOf(nowMs),
    text,
  };
}

/**
 * Encode unverified channel traffic as a {@link RawChannelData} (the
 * *unverified* queue shape — the admin-gate negative case).
 *
 * Carries the raw `bytes` and `snr` but **no decoded text** — the device could
 * not decrypt-verify it, so it must never surface as a verified
 * `channelMessage`. `dataType` is `DataTypes.Dev`; `pathLen` and the reserved
 * fields are zero.
 */
export function channelDataOf(
  channelIdx: number,
  bytes: Uint8Array,
  snr: number,
): RawChannelData {
  return {
    snr,
    reserved1: 0,
    reserved2: 0,
    channelIdx,
    pathLen: 0,
    dataType: Constants.DataTypes.Dev,
    dataLen: bytes.length,
    data: bytes,
  };
}

/**
 * Build an {@link RawAdvert} push payload for a node (the `Advert` push shape:
 * just the advertiser's full public key).
 */
export function advertOf(node: SimNode): RawAdvert {
  return { publicKey: fromHex(node.publicKey) };
}

/**
 * Build a {@link RawLogRxData} push payload carrying receive signal metadata.
 *
 * Verified `contactMessage`/`channelMessage` queue shapes have no rssi/snr
 * field (faithful to the wire), so when a verified message event specifies
 * signal metadata the connection additionally emits this `LogRxData` push to
 * carry it. `lastSnr`/`lastRssi` default to `0` when unspecified.
 */
export function logRxDataOf(raw: Uint8Array, snr?: number, rssi?: number): RawLogRxData {
  return { lastSnr: snr ?? 0, lastRssi: rssi ?? 0, raw };
}
