/**
 * `SimConnection` — the raw `@liamcottle/meshcore.js` `Connection` drop-in.
 *
 * This is the contract at the heart of the simulator (AGENTS.md, "The
 * contract"): a real `EventEmitter` exposing the same async method surface a
 * `MeshCoreClient` consumes, returning `Raw*` shapes synthesized from a
 * {@link MeshWorld}. It is the grown-up form of meshcore-ts's hand-written
 * `test/fake-connection.ts`: same drop-in point, a simulated world behind it
 * instead of canned returns. Cast it with {@link SimConnection.asConnection}
 * and pass it to `new MeshCoreClient(...)`.
 *
 * **This milestone (M3) implements the static-read half only.** Reads return
 * real world data resolved on the microtask queue (no clock gating — `await
 * client.getSelfInfo()` works without advancing time). The dynamic scenario
 * engine, the device message-queue, send→ack/reply behavior, and push-code
 * emission are M4: the mutation/send/config methods below are minimal resolving
 * stubs (marked `// M4/later`) so the cast `Connection` is complete and the
 * client never calls a missing method, and the queue reads return empty.
 *
 * **Unreachable nodes.** A remote read (`getStatus`/`getTelemetry`/
 * `getNeighbours`/`login`) against a node with `reachable === false`, or an
 * unknown key, rejects with `{ errCode: ErrorCode.NotFound }` — the shape
 * `normalizeRejection` maps to a `MeshCoreDeviceError` (a `MeshCoreError`
 * subclass). `MeshCoreClient` passes `timeoutMs: null` for these, so we must
 * reject ourselves rather than hang.
 */

import { EventEmitter } from "node:events";
import type {
  Connection,
  RawBatteryVoltage,
  RawChannel,
  RawContact,
  RawCurrTime,
  RawDeviceInfo,
  RawLoginSuccess,
  RawNeighboursResult,
  RawRepeaterStats,
  RawSelfInfo,
  RawSent,
  RawStats,
  RawTelemetryResponse,
  RawTraceData,
  RawWaitingMessage,
} from "@liamcottle/meshcore.js";
import { Constants } from "@liamcottle/meshcore.js";
import { ErrorCode, fromHex } from "@dpup/meshcore-ts";

import type { SimClock } from "./clock.js";
import {
  advertOf,
  batteryMilliVoltsOf,
  channelDataOf,
  channelMessageOf,
  channelOf,
  contactMessageOf,
  contactOf,
  coreStatsOf,
  deviceInfoOf,
  epochSecsOf,
  logRxDataOf,
  neighboursOf,
  packetStatsOf,
  pubKeyPrefixOf,
  radioStatsOf,
  repeaterStatsOf,
  selfInfoOf,
  telemetryOf,
  textToBytes,
} from "./encode.js";
import type {
  ChannelMessageEvent,
  MessageEvent,
  NodeStateEvent,
  Scenario,
  SimEvent,
  TelemetryEvent,
} from "./scenario.js";
import { toMillis } from "./duration.js";
import { SimError } from "./errors.js";
import type { MeshWorld, SimNode } from "./world.js";

/**
 * Options for constructing a {@link SimConnection}.
 *
 * M4 extends this with a `scenario` field; declaring it as an exported
 * interface now lets that addition be source-compatible.
 */
export interface SimConnectionOptions {
  /** The static world this connection answers reads from. */
  world: MeshWorld;
  /** The virtual clock driving deterministic timestamps (and M4 events). */
  clock: SimClock;
  /**
   * Optional dynamic-fixture timeline. When present, its events are scheduled
   * onto the clock in {@link SimConnection.connect}, each at `clock.now() +
   * toMillis(event.at)` (so `at` is relative to connect time), and fire as the
   * clock advances. See {@link Scenario}.
   */
  scenario?: Scenario;
}

/** Resolve on the microtask queue, mirroring an async device response. */
function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

/**
 * Reject the way the device would when a node is unreachable or unknown: with
 * an `{ errCode }` object, which `normalizeRejection` maps to a
 * `MeshCoreDeviceError`.
 */
function rejectNotFound(): Promise<never> {
  return Promise.reject({ errCode: ErrorCode.NotFound });
}

/**
 * A drop-in for a raw meshcore.js `Connection` backed by a {@link MeshWorld}.
 *
 * @example
 * ```ts
 * const world = defineWorld({ homeNodeId: "home" });
 * const sim = new SimConnection({ world, clock: new SimClock() });
 * const client = new MeshCoreClient(sim.asConnection());
 * await client.connect();
 * ```
 */
export class SimConnection extends EventEmitter {
  /** The world this connection reads from. */
  protected readonly world: MeshWorld;
  /** The virtual clock supplying deterministic timestamps. */
  protected readonly clock: SimClock;
  /** The dynamic timeline, if any, scheduled onto the clock in {@link connect}. */
  protected readonly scenario?: Scenario;

  /**
   * The device's internal message queue. The spine of the delivery model: a
   * scenario `message`/`channelMessage` event **enqueues** a `RawWaitingMessage`
   * here and emits `MsgWaiting`; the client then drains via
   * {@link getWaitingMessages} / {@link syncNextMessage}. The device never
   * pushes message contents directly (AGENTS.md "don't-regress" #1).
   */
  private readonly deviceQueue: RawWaitingMessage[] = [];

  constructor(opts: SimConnectionOptions) {
    super();
    this.world = opts.world;
    this.clock = opts.clock;
    this.scenario = opts.scenario;
  }

  /**
   * Cast to the `Connection` type the client expects. Mirrors
   * `FakeConnection.asConnection()`: `SimConnection` is structurally a
   * `Connection` but extends Node's `EventEmitter`, so the cast bridges the two.
   */
  asConnection(): Connection {
    return this as unknown as Connection;
  }

  // --- lifecycle ---

  /**
   * Open the connection. Resolves and emits `connected` so
   * `MeshCoreClient.connect()` resolves.
   *
   * The `connected` event fires on the microtask queue (via `queueMicrotask`),
   * not the `SimClock` — connect is test setup and must resolve promptly,
   * before any `clock.advance()`.
   */
  async connect(): Promise<void> {
    queueMicrotask(() => this.emit("connected"));
    this.scheduleScenario();
  }

  /**
   * Schedule each scenario event onto the clock, at `clock.now() +
   * toMillis(event.at)` (so `at` is relative to connect time — the device
   * starts producing traffic once connected). Each timer fires **synchronously
   * inside `clock.advance()`**, calling {@link fireEvent}, which enqueues +
   * emits the right numeric push code. The client's drain then runs on the
   * microtask queue after `advance()` returns.
   */
  private scheduleScenario(): void {
    if (this.scenario === undefined) return;
    const base = this.clock.now();
    for (const { at, event } of this.scenario.events) {
      const dueAt = base + toMillis(at);
      // setTimeout delay is relative to clock.now(); since we schedule all at
      // connect time, the delay is the absolute due offset from now.
      this.clock.setTimeout(() => this.fireEvent(event), dueAt - this.clock.now());
    }
  }

  /** Close the connection: emit `disconnected` and resolve. */
  async close(): Promise<void> {
    queueMicrotask(() => this.emit("disconnected"));
  }

  // --- device info & config (reads) ---

  async getSelfInfo(): Promise<RawSelfInfo> {
    return resolved(selfInfoOf(this.world));
  }

  async getDeviceTime(): Promise<RawCurrTime> {
    return resolved({ epochSecs: epochSecsOf(this.clock.now()) });
  }

  async getBatteryVoltage(): Promise<RawBatteryVoltage> {
    return resolved({ batteryMilliVolts: batteryMilliVoltsOf(this.homeNode()) });
  }

  async deviceQuery(_appTargetVer: number): Promise<RawDeviceInfo> {
    return resolved(deviceInfoOf(this.homeNode()));
  }

  // --- contacts (reads) ---

  /**
   * Return one `RawContact` per `world.contacts`, resolving each contact's
   * referenced node for role/position. This is the contacts model: a "contact"
   * the client sees is a `SimContact` pointing at a `SimNode`. Remote reads
   * (`getStatus`/`getTelemetry`/`getNeighbours`) resolve the same nodes by the
   * key passed in (which equals the contact's `publicKey`).
   */
  async getContacts(): Promise<RawContact[]> {
    const nowSecs = epochSecsOf(this.clock.now());
    return resolved(
      this.world.contacts.map((c) => contactOf(this.nodeForContactKey(c.publicKey), nowSecs)),
    );
  }

  async findContactByName(name: string): Promise<RawContact | undefined> {
    const match = this.world.contacts.find((c) => c.name === name);
    if (match === undefined) return resolved(undefined);
    return resolved(contactOf(this.nodeForContactKey(match.publicKey), epochSecsOf(this.clock.now())));
  }

  async findContactByPublicKeyPrefix(prefix: Uint8Array): Promise<RawContact | undefined> {
    const match = this.world.contacts.find((c) => hexStartsWith(c.publicKey, prefix));
    if (match === undefined) return resolved(undefined);
    return resolved(contactOf(this.nodeForContactKey(match.publicKey), epochSecsOf(this.clock.now())));
  }

  // --- channels (reads) ---

  async getChannel(channelIdx: number): Promise<RawChannel> {
    const ch = this.world.channels.find((c) => c.idx === channelIdx);
    if (ch === undefined) return rejectNotFound();
    return resolved(channelOf(ch));
  }

  async getChannels(): Promise<RawChannel[]> {
    return resolved(this.world.channels.map(channelOf));
  }

  async findChannelByName(name: string): Promise<RawChannel | undefined> {
    const ch = this.world.channels.find((c) => c.name === name);
    return resolved(ch ? channelOf(ch) : undefined);
  }

  async findChannelBySecret(secret: Uint8Array): Promise<RawChannel | undefined> {
    const hex = toHexLower(secret);
    const ch = this.world.channels.find((c) => c.secret === hex);
    return resolved(ch ? channelOf(ch) : undefined);
  }

  // --- local stats (reads) ---

  async getStats(statsType: number): Promise<RawStats> {
    const home = this.homeNode();
    switch (statsType) {
      case Constants.StatsTypes.Radio:
        return resolved(radioStatsOf(home));
      case Constants.StatsTypes.Packets:
        return resolved(packetStatsOf(home));
      case Constants.StatsTypes.Core:
      default:
        return resolved(coreStatsOf(home, this.clock.now()));
    }
  }

  async getStatsCore(): Promise<RawStats> {
    return this.getStats(Constants.StatsTypes.Core);
  }

  async getStatsRadio(): Promise<RawStats> {
    return this.getStats(Constants.StatsTypes.Radio);
  }

  async getStatsPackets(): Promise<RawStats> {
    return this.getStats(Constants.StatsTypes.Packets);
  }

  // --- remote-node reads (reject if unreachable / unknown) ---

  async getStatus(contactPublicKey: Uint8Array): Promise<RawRepeaterStats> {
    const node = this.reachableNodeByKey(contactPublicKey);
    if (node === undefined) return rejectNotFound();
    return resolved(repeaterStatsOf(node, this.clock.now()));
  }

  async getTelemetry(contactPublicKey: Uint8Array): Promise<RawTelemetryResponse> {
    const node = this.reachableNodeByKey(contactPublicKey);
    if (node === undefined) return rejectNotFound();
    return resolved(telemetryOf(node));
  }

  async getNeighbours(
    publicKey: Uint8Array,
    _count?: number,
    _offset?: number,
    _orderBy?: number,
    _pubKeyPrefixLength?: number,
  ): Promise<RawNeighboursResult> {
    const node = this.reachableNodeByKey(publicKey);
    if (node === undefined) return rejectNotFound();
    return resolved(neighboursOf(node));
  }

  // --- message queue (filled by the scenario engine) ---

  /**
   * Return **all** queued messages and clear the queue (FIFO), mirroring the
   * device draining its waiting-message queue. The client calls this from its
   * `MsgWaiting` handler under `autoSync`.
   *
   * Because the array is spliced atomically, a burst of events that all
   * enqueued before the drain's `await` resolves is returned together, in send
   * order — the burst-coalescing behaviour the time-domain tests rely on.
   */
  async getWaitingMessages(): Promise<RawWaitingMessage[]> {
    return resolved(this.deviceQueue.splice(0, this.deviceQueue.length));
  }

  /** Return and remove the oldest queued message, or `null` if the queue is empty. */
  async syncNextMessage(): Promise<RawWaitingMessage | null> {
    return resolved(this.deviceQueue.shift() ?? null);
  }

  // --- out-of-scope stubs (M4/later) -------------------------------------
  // These exist so the cast `Connection` is complete and the client never
  // calls a missing method. They have no real behavior yet; the dynamic
  // engine (sends, acks, replies, config mutation) is M4.

  /**
   * Send a direct text message. Returns a benign `RawSent` (the device
   * accepted it) and, on the next microtask, emits a `SendConfirmed` push so
   * the client's `sendConfirmed` event fires — a minimal-but-real send
   * acknowledgement.
   *
   * The ack is deferred via `queueMicrotask` (not the clock) so a test can
   * `await client.sendTextMessage(...)` and observe `sendConfirmed` without
   * advancing time. *Reactive* scripted replies are out of scope: a reply is
   * just another scheduled `message` event on the timeline.
   */
  async sendTextMessage(
    _contactPublicKey: Uint8Array,
    _text: string,
    _type?: number,
  ): Promise<RawSent> {
    queueMicrotask(() =>
      this.emitPush(Constants.PushCodes.SendConfirmed, { ackCode: 0, roundTrip: 0 }),
    );
    return resolved({ result: Constants.ResponseCodes.Ok, expectedAckCrc: 0, estTimeout: 0 });
  }

  // M4/later: enqueue a channel message / channelData per the provenance table.
  async sendChannelTextMessage(_channelIdx: number, _text: string): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: device-time mutation.
  async setDeviceTime(_epochSecs: number): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: device-time mutation.
  async syncDeviceTime(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: contact-table mutation.
  async importContact(_advertPacketBytes: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: export self/contact as advert bytes.
  async exportContact(_pubKey?: Uint8Array | null): Promise<{ advertPacketBytes: Uint8Array }> {
    return resolved({ advertPacketBytes: new Uint8Array(0) });
  }

  // M4/later: contact-table mutation.
  async shareContact(_pubKey: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: contact-table mutation.
  async removeContact(_pubKey: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: contact-table mutation.
  async addOrUpdateContact(
    _publicKey: Uint8Array,
    _type: number,
    _flags: number,
    _outPathLen: number,
    _outPath: Uint8Array,
    _advName: string,
    _lastAdvert: number,
    _advLat: number,
    _advLon: number,
  ): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: path reset / PathUpdated push.
  async resetPath(_pubKey: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: device reboot.
  async reboot(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: key export. A zero-filled key keeps the shape valid.
  async exportPrivateKey(): Promise<{ privateKey: Uint8Array }> {
    return resolved({ privateKey: new Uint8Array(32) });
  }

  // M4/later: key import.
  async importPrivateKey(_privateKey: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: advertising emits Advert / NewAdvert push codes.
  async sendAdvert(_type: number): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: advertising.
  async sendFloodAdvert(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: advertising.
  async sendZeroHopAdvert(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: advert config mutation.
  async setAdvertName(_name: string): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: advert config mutation.
  async setAdvertLatLong(_latitude: number, _longitude: number): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: radio config mutation.
  async setTxPower(_txPower: number): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: radio config mutation.
  async setRadioParams(
    _radioFreq: number,
    _radioBw: number,
    _radioSf: number,
    _radioCr: number,
  ): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: remote login emits LoginSuccess / LoginFail. Unreachable/unknown
  // targets reject like other remote reads; reachable ones return a benign
  // success keyed by the node prefix.
  async login(
    contactPublicKey: Uint8Array,
    _password: string,
    _extraTimeoutMillis?: number,
  ): Promise<RawLoginSuccess> {
    const node = this.reachableNodeByKey(contactPublicKey);
    if (node === undefined) return rejectNotFound();
    return resolved({ reserved: 0, pubKeyPrefix: fromHex(node.publicKey).subarray(0, 6) });
  }

  // M4/later: binary request/response over the mesh.
  async sendBinaryRequest(
    _contactPublicKey: Uint8Array,
    _requestCodeAndParams: Uint8Array,
    _extraTimeoutMillis?: number,
  ): Promise<Uint8Array> {
    return resolved(new Uint8Array(0));
  }

  // M4/later: channel config mutation.
  async setChannel(_channelIdx: number, _name: string, _secret: Uint8Array): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: channel config mutation.
  async deleteChannel(_channelIdx: number): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: signing.
  async sign(_data: Uint8Array): Promise<Uint8Array> {
    return resolved(new Uint8Array(0));
  }

  // M4/later: path tracing emits TraceData.
  async tracePath(_path: Uint8Array, _extraTimeoutMillis?: number): Promise<RawTraceData> {
    return resolved({
      reserved: 0,
      pathLen: 0,
      flags: 0,
      tag: 0,
      authCode: 0,
      pathHashes: new Uint8Array(0),
      pathSnrs: new Uint8Array(0),
      lastSnr: 0,
    });
  }

  // M4/later: contact-add-mode config mutation.
  async setOtherParams(_manualAddContacts: boolean): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: contact-add-mode config mutation.
  async setAutoAddContacts(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: contact-add-mode config mutation.
  async setManualAddContacts(): Promise<void> {
    return resolved(undefined);
  }

  // M4/later: flood-scope config mutation.
  async setFloodScope(_transportKey: Uint8Array): Promise<unknown> {
    return resolved(undefined);
  }

  // M4/later: flood-scope config mutation.
  async clearFloodScope(): Promise<unknown> {
    return resolved(undefined);
  }

  // --- internals ---

  /** The home node — the device this connection represents. */
  private homeNode(): SimNode {
    const home = this.world.nodes.find((n) => n.id === this.world.homeNodeId);
    if (home === undefined) {
      throw new Error(`SimConnection: home node "${this.world.homeNodeId}" not found in world`);
    }
    return home;
  }

  /**
   * Resolve the node referenced by a contact's public key (full hex match). A
   * contact always references a known node (validated by `defineWorld`), so a
   * miss is an internal inconsistency.
   */
  private nodeForContactKey(publicKey: string): SimNode {
    const node = this.world.nodes.find((n) => n.publicKey === publicKey);
    if (node === undefined) {
      throw new Error(`SimConnection: contact key ${publicKey} references no node`);
    }
    return node;
  }

  /**
   * Resolve a node from a key passed to a remote read, matching by full key or
   * prefix, and return it only if it is reachable. Returns `undefined` for
   * unknown or unreachable nodes so the caller rejects with NotFound.
   */
  private reachableNodeByKey(key: Uint8Array): SimNode | undefined {
    const node = this.world.nodes.find((n) => hexStartsWith(n.publicKey, key));
    if (node === undefined || !node.reachable) return undefined;
    return node;
  }

  /**
   * Emit a numeric push code on the EventEmitter. The raw `Connection` contract
   * emits the integer `Constants.PushCodes` values that `MeshCoreClient` listens
   * on; Node's `EventEmitter.emit` accepts a number at runtime but its TS type
   * narrows to `string | symbol`, so this is the single, documented bridge.
   */
  private emitPush(code: number, payload?: unknown): void {
    if (payload === undefined) {
      this.emit(code as unknown as string);
    } else {
      this.emit(code as unknown as string, payload);
    }
  }

  // --- scenario event dispatch (the provenance mapping table) -------------

  /**
   * Encode and dispatch one scenario event, per the provenance mapping table
   * (AGENTS.md). Runs **synchronously inside `clock.advance()`** when its timer
   * fires: it mutates the world, enqueues `RawWaitingMessage`s, and emits the
   * matching numeric push code. Message enqueues happen before the
   * `MsgWaiting` emit, so the client drains them on the following microtask.
   */
  private fireEvent(event: SimEvent): void {
    switch (event.kind) {
      case "message":
        this.fireMessage(event);
        break;
      case "channelMessage":
        this.fireChannelMessage(event);
        break;
      case "nodeState":
        this.fireNodeState(event);
        break;
      case "telemetry":
        this.fireTelemetry(event);
        break;
      case "advert":
        this.emitPush(Constants.PushCodes.Advert, advertOf(this.nodeById(event.nodeId)));
        break;
    }
  }

  /**
   * Direct contact message → enqueue `{ contactMessage }` keyed by the sender's
   * `pubKeyPrefix`, then emit `MsgWaiting`. If the event carries rssi/snr (which
   * the verified queue shape has no field for), additionally emit a `LogRxData`
   * push so the signal metadata is observable.
   *
   * If the event has a `sentAt` field, it is passed to {@link contactMessageOf}
   * as the `sentAtMs` override, so the `senderTimestamp` in the encoded message
   * reflects the sender's clock rather than the arrival clock.
   */
  private fireMessage(event: MessageEvent): void {
    const node = this.nodeById(event.from);
    this.deviceQueue.push({
      contactMessage: contactMessageOf(
        node,
        event.text,
        this.clock.now(),
        event.txtType,
        event.sentAt,
      ),
    });
    this.emitPush(Constants.PushCodes.MsgWaiting);
    if (event.rssi !== undefined || event.snr !== undefined) {
      this.emitPush(
        Constants.PushCodes.LogRxData,
        logRxDataOf(textToBytes(event.text), event.snr, event.rssi),
      );
    }
  }

  /**
   * Channel traffic. Verified (the default) → enqueue `{ channelMessage }` with
   * the decoded text on the channel's idx. Unverified → enqueue `{ channelData }`
   * carrying the raw bytes + `snr` and **no decoded text**, so it can never
   * surface as a verified `channelMessage` (the admin-gate negative case). Both
   * then emit `MsgWaiting`.
   *
   * If the event has a `sentAt` field, it is passed to {@link channelMessageOf}
   * as the `sentAtMs` override (verified path only — unverified `channelData`
   * has no `senderTimestamp` field on the wire).
   */
  private fireChannelMessage(event: ChannelMessageEvent): void {
    const channelIdx = this.resolveChannelIdx(event.channel);
    const verified = event.verified ?? true;
    if (verified) {
      this.deviceQueue.push({
        channelMessage: channelMessageOf(
          channelIdx,
          event.text,
          this.clock.now(),
          undefined,
          event.sentAt,
        ),
      });
      this.emitPush(Constants.PushCodes.MsgWaiting);
      if (event.rssi !== undefined || event.snr !== undefined) {
        this.emitPush(
          Constants.PushCodes.LogRxData,
          logRxDataOf(textToBytes(event.text), event.snr, event.rssi),
        );
      }
    } else {
      this.deviceQueue.push({
        channelData: channelDataOf(channelIdx, textToBytes(event.text), event.snr ?? 0),
      });
      this.emitPush(Constants.PushCodes.MsgWaiting);
    }
  }

  /**
   * `nodeState` → mutate the referenced node's `reachable` flag in the world, so
   * subsequent remote reads reflect the change. Optionally surfaces as a
   * `PathUpdated` push so a listening app sees the topology change.
   */
  private fireNodeState(event: NodeStateEvent): void {
    const node = this.nodeById(event.nodeId);
    node.reachable = event.reachable;
    this.emitPush(Constants.PushCodes.PathUpdated, { publicKey: fromHex(node.publicKey) });
  }

  /** `telemetry` → emit a `TelemetryResponse` push keyed by the node's prefix. */
  private fireTelemetry(event: TelemetryEvent): void {
    const node = this.nodeById(event.nodeId);
    this.emitPush(Constants.PushCodes.TelemetryResponse, {
      reserved: 0,
      pubKeyPrefix: pubKeyPrefixOf(node),
      lppSensorData: event.lppSensorData ?? new Uint8Array(0),
    });
  }

  /** Resolve a node by id, or throw — a scenario referencing an unknown node is an authoring error. */
  private nodeById(nodeId: string): SimNode {
    const node = this.world.nodes.find((n) => n.id === nodeId);
    if (node === undefined) {
      throw new SimError(`scenario: event references unknown node id "${nodeId}"`);
    }
    return node;
  }

  /**
   * Resolve a channel reference (slot index or name) to its index. A number is
   * taken as the index directly (it need not be a configured slot — the
   * admin-gate negative case may target an unconfigured admin index); a string
   * is resolved by name against `world.channels` and throws if not found.
   */
  private resolveChannelIdx(channel: number | string): number {
    if (typeof channel === "number") return channel;
    const match = this.world.channels.find((c) => c.name === channel);
    if (match === undefined) {
      throw new SimError(`scenario: channel name "${channel}" not found in world`);
    }
    return match.idx;
  }
}

// --- key-matching helpers ---

/** Lowercase-hex encode bytes (local to avoid a runtime dep cycle in encoders). */
function toHexLower(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Whether the hex string's leading bytes equal `prefix`. An empty prefix never
 * matches (avoids matching every node by accident).
 */
function hexStartsWith(hex: string, prefix: Uint8Array): boolean {
  if (prefix.length === 0) return false;
  const prefixHex = toHexLower(prefix);
  return hex.startsWith(prefixHex);
}
