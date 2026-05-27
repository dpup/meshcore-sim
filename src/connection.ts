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
 * **Reads** return real world data resolved on the microtask queue (no clock
 * gating — `await client.getSelfInfo()` works without advancing time). The
 * **dynamic scenario engine** drives the device message-queue and push-code
 * emission as the clock advances; **sends** ack and may trigger a
 * {@link Responder} reply; and **config/action commands** are logged (see
 * {@link SimConnection.commandLog}) and, where a world effect is modeled
 * (`setTxPower`/`setRadioParams`/`setAdvertName`/`setAdvertLatLong`), applied so
 * a subsequent read reflects them. Commands without a modeled effect still
 * resolve benignly and are recorded, so the cast `Connection` is complete and
 * the client never calls a missing method.
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
import { isChannelReply } from "./responder.js";
import type { OutboundMessage, Responder, ResponderReply } from "./responder.js";
import { toMillis } from "./duration.js";
import { SimError } from "./errors.js";
import type { MeshWorld, RadioConfig, SimNode } from "./world.js";

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
  /**
   * Optional reactive-reply rules. Each outbound send (`sendTextMessage` /
   * `sendChannelTextMessage`) is matched against these; a matching responder's
   * reply is scheduled on the clock and delivered through the device-queue
   * model, so request/response round-trips (remote-admin, echo/command bots)
   * work without pre-scripting the reply on the timeline. See {@link Responder}.
   */
  responders?: Responder[];
}

/**
 * One entry in a {@link SimConnection.commandLog} — a write/config/action call
 * the app made on the connection. Reads (`getSelfInfo`, `getContacts`, …) are
 * not recorded; only commands that *do* something are. Lets a test assert the
 * app issued an action (`set-tx-power 20`, `sendAdvert`, …) even where a full
 * world-mutation model isn't worth it.
 */
export interface ReceivedCommand {
  /** The `Connection` method the app invoked (e.g. `"setTxPower"`). */
  method: string;
  /**
   * Named arguments, decoded into friendly values where useful (public keys as
   * lowercase hex, a resolved destination node id as `to`). Empty for no-arg
   * commands like `reboot`.
   */
  args: Record<string, unknown>;
  /** Virtual time (ms, `clock.now()`) at which the command was received. */
  at: number;
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
  /** Reactive-reply rules, if any, matched against each outbound send. */
  protected readonly responders: readonly Responder[];

  /**
   * The device's internal message queue. The spine of the delivery model: a
   * scenario `message`/`channelMessage` event **enqueues** a `RawWaitingMessage`
   * here and emits `MsgWaiting`; the client then drains via
   * {@link getWaitingMessages} / {@link syncNextMessage}. The device never
   * pushes message contents directly (AGENTS.md "don't-regress" #1).
   */
  private readonly deviceQueue: RawWaitingMessage[] = [];

  /**
   * Ordered log of write/config/action commands the app issued. Exposed
   * read-only via {@link commandLog}. The other half of "observable writes":
   * even where a command isn't modeled as a world mutation, the test can still
   * assert it happened.
   */
  private readonly commands: ReceivedCommand[] = [];

  /**
   * Per-node last-heard time (ms), keyed by node id, updated whenever a node
   * emits (advert / message / telemetry). Backs the contact roster's
   * `lastAdvert`: a node that has gone quiet keeps its old time rather than
   * reading "heard now" on every poll. Nodes never heard fall back to
   * {@link bootMs}.
   */
  private readonly lastHeardMs = new Map<string, number>();

  /** Virtual time at construction — the last-heard baseline for unheard nodes. */
  private readonly bootMs: number;

  constructor(opts: SimConnectionOptions) {
    super();
    // Clone the world so this connection owns its mutable state. Scenario
    // `nodeState` events flip `reachable` in place, and config mutations
    // (`setTxPower` etc.) write to the home node; without the clone, a world
    // reused across tests (the idiomatic `const world = defineWorld(...)` shared
    // at module scope) would be permanently corrupted by one test, leaking
    // state into later tests. The clone isolates every per-connection mutation
    // from the caller's object.
    this.world = structuredClone(opts.world);
    this.clock = opts.clock;
    this.scenario = opts.scenario;
    this.responders = opts.responders ?? [];
    this.bootMs = this.clock.now();
  }

  /**
   * Cast to the `Connection` type the client expects. Mirrors
   * `FakeConnection.asConnection()`: `SimConnection` is structurally a
   * `Connection` but extends Node's `EventEmitter`, so the cast bridges the two.
   */
  asConnection(): Connection {
    return this as unknown as Connection;
  }

  // --- observable writes (the received-command log) -----------------------

  /**
   * The ordered log of write/config/action commands the app has issued so far,
   * oldest first. Read-only; assert against it to verify the app *did the
   * thing*, e.g. `expect(sim.commandLog).toContainEqual(expect.objectContaining(
   * { method: "setTxPower", args: { txPower: 20 } }))`.
   */
  get commandLog(): readonly ReceivedCommand[] {
    return this.commands;
  }

  /** The logged commands with the given method name, oldest first. */
  commandsOf(method: string): ReceivedCommand[] {
    return this.commands.filter((c) => c.method === method);
  }

  /** Append a command to {@link commandLog}, stamped at the current virtual time. */
  private record(method: string, args: Record<string, unknown> = {}): void {
    this.commands.push({ method, args, at: this.clock.now() });
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
    return resolved(
      this.world.contacts.map((c) => {
        const node = this.nodeForContactKey(c.publicKey);
        return contactOf(node, this.lastHeardSecsOf(node.id));
      }),
    );
  }

  async findContactByName(name: string): Promise<RawContact | undefined> {
    const match = this.world.contacts.find((c) => c.name === name);
    if (match === undefined) return resolved(undefined);
    const node = this.nodeForContactKey(match.publicKey);
    return resolved(contactOf(node, this.lastHeardSecsOf(node.id)));
  }

  async findContactByPublicKeyPrefix(prefix: Uint8Array): Promise<RawContact | undefined> {
    const match = this.world.contacts.find((c) => hexStartsWith(c.publicKey, prefix));
    if (match === undefined) return resolved(undefined);
    const node = this.nodeForContactKey(match.publicKey);
    return resolved(contactOf(node, this.lastHeardSecsOf(node.id)));
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

  // --- sends, config & actions (logged; mutating where modeled) ----------
  // Every command here appends to the received-command log (so a test can
  // assert the app issued it), and the ones with a modeled world effect apply
  // it (so a subsequent read reflects it). The rest still resolve benignly —
  // accepted and recorded, with no world change.

  /**
   * Send a direct text message. Records the send, returns a benign `RawSent`
   * (the device accepted it), and on the next microtask emits a `SendConfirmed`
   * push so the client's `sendConfirmed` event fires — a minimal-but-real send
   * acknowledgement.
   *
   * The ack is deferred via `queueMicrotask` (not the clock) so a test can
   * `await client.sendTextMessage(...)` and observe `sendConfirmed` without
   * advancing time. Any configured {@link Responder} is then matched against the
   * send and its reply scheduled on the clock — the world reacts to the app's
   * action (PRD §2).
   */
  async sendTextMessage(
    contactPublicKey: Uint8Array,
    text: string,
    type?: number,
  ): Promise<RawSent> {
    const to = this.nodeIdByKey(contactPublicKey);
    this.record("sendTextMessage", { to, text, txtType: type });
    queueMicrotask(() =>
      this.emitPush(Constants.PushCodes.SendConfirmed, { ackCode: 0, roundTrip: 0 }),
    );
    this.dispatchResponders({ kind: "contact", text, to, txtType: type });
    return resolved({ result: Constants.ResponseCodes.Ok, expectedAckCrc: 0, estTimeout: 0 });
  }

  /**
   * Send a channel text message. Records the send, then matches configured
   * {@link Responder}s against it (a channel command/echo bot keys on
   * `msg.channel` via `when`) and schedules any reply on the clock.
   */
  async sendChannelTextMessage(channelIdx: number, text: string): Promise<void> {
    this.record("sendChannelTextMessage", { channelIdx, text });
    this.dispatchResponders({ kind: "channel", text, channel: channelIdx });
    return resolved(undefined);
  }

  // Device-time mutation — recorded; device time is driven by the SimClock.
  async setDeviceTime(epochSecs: number): Promise<void> {
    this.record("setDeviceTime", { epochSecs });
    return resolved(undefined);
  }

  async syncDeviceTime(): Promise<void> {
    this.record("syncDeviceTime");
    return resolved(undefined);
  }

  // Contact-table mutation — recorded; no contact model yet.
  async importContact(advertPacketBytes: Uint8Array): Promise<void> {
    this.record("importContact", { advertPacketBytes });
    return resolved(undefined);
  }

  async exportContact(pubKey?: Uint8Array | null): Promise<{ advertPacketBytes: Uint8Array }> {
    this.record("exportContact", { pubKey: pubKey ? toHexLower(pubKey) : undefined });
    return resolved({ advertPacketBytes: new Uint8Array(0) });
  }

  async shareContact(pubKey: Uint8Array): Promise<void> {
    this.record("shareContact", { pubKey: toHexLower(pubKey) });
    return resolved(undefined);
  }

  async removeContact(pubKey: Uint8Array): Promise<void> {
    this.record("removeContact", { pubKey: toHexLower(pubKey) });
    return resolved(undefined);
  }

  async addOrUpdateContact(
    publicKey: Uint8Array,
    type: number,
    flags: number,
    outPathLen: number,
    outPath: Uint8Array,
    advName: string,
    lastAdvert: number,
    advLat: number,
    advLon: number,
  ): Promise<void> {
    this.record("addOrUpdateContact", {
      publicKey: toHexLower(publicKey),
      type,
      flags,
      outPathLen,
      outPath,
      advName,
      lastAdvert,
      advLat,
      advLon,
    });
    return resolved(undefined);
  }

  // Path reset — recorded; no path model yet.
  async resetPath(pubKey: Uint8Array): Promise<void> {
    this.record("resetPath", { pubKey: toHexLower(pubKey) });
    return resolved(undefined);
  }

  // Device reboot — recorded; no lifecycle model.
  async reboot(): Promise<void> {
    this.record("reboot");
    return resolved(undefined);
  }

  // Key export — recorded (the key value is not logged); a zero-filled key
  // keeps the shape valid.
  async exportPrivateKey(): Promise<{ privateKey: Uint8Array }> {
    this.record("exportPrivateKey");
    return resolved({ privateKey: new Uint8Array(32) });
  }

  async importPrivateKey(_privateKey: Uint8Array): Promise<void> {
    this.record("importPrivateKey");
    return resolved(undefined);
  }

  /**
   * Advertise. Records the send and updates the home node's last-heard. It does
   * **not** emit a received-`Advert` push: on hardware a device does not receive
   * its own advert back, so the observable effect of self-advertising is the
   * command log, not an inbound event. (Remote nodes advertising → an inbound
   * `Advert` is a scenario `advert` event.)
   */
  async sendAdvert(type: number): Promise<void> {
    this.record("sendAdvert", { type });
    this.markHeard(this.world.homeNodeId);
    return resolved(undefined);
  }

  async sendFloodAdvert(): Promise<void> {
    this.record("sendFloodAdvert");
    this.markHeard(this.world.homeNodeId);
    return resolved(undefined);
  }

  async sendZeroHopAdvert(): Promise<void> {
    this.record("sendZeroHopAdvert");
    this.markHeard(this.world.homeNodeId);
    return resolved(undefined);
  }

  /** Set the advertised name — recorded and applied (reflected by `getSelfInfo`). */
  async setAdvertName(name: string): Promise<void> {
    this.record("setAdvertName", { name });
    this.homeNode().name = name;
    return resolved(undefined);
  }

  /** Set the advertised position — recorded and applied (reflected by `getSelfInfo`). */
  async setAdvertLatLong(latitude: number, longitude: number): Promise<void> {
    this.record("setAdvertLatLong", { latitude, longitude });
    const home = this.homeNode();
    home.lat = latitude;
    home.lon = longitude;
    return resolved(undefined);
  }

  /** Set transmit power — recorded and applied (reflected by `getSelfInfo`). */
  async setTxPower(txPower: number): Promise<void> {
    this.record("setTxPower", { txPower });
    this.homeRadio().txPower = txPower;
    return resolved(undefined);
  }

  /** Set radio parameters — recorded and applied (reflected by `getSelfInfo`). */
  async setRadioParams(
    radioFreq: number,
    radioBw: number,
    radioSf: number,
    radioCr: number,
  ): Promise<void> {
    this.record("setRadioParams", { radioFreq, radioBw, radioSf, radioCr });
    const radio = this.homeRadio();
    radio.freq = radioFreq;
    radio.bw = radioBw;
    radio.sf = radioSf;
    radio.cr = radioCr;
    return resolved(undefined);
  }

  // Remote login. Recorded; unreachable/unknown targets reject like other
  // remote reads, reachable ones return a benign success keyed by the prefix.
  async login(
    contactPublicKey: Uint8Array,
    _password: string,
    _extraTimeoutMillis?: number,
  ): Promise<RawLoginSuccess> {
    this.record("login", { to: this.nodeIdByKey(contactPublicKey) });
    const node = this.reachableNodeByKey(contactPublicKey);
    if (node === undefined) return rejectNotFound();
    return resolved({ reserved: 0, pubKeyPrefix: fromHex(node.publicKey).subarray(0, 6) });
  }

  // Binary request/response over the mesh — recorded; no model yet.
  async sendBinaryRequest(
    contactPublicKey: Uint8Array,
    requestCodeAndParams: Uint8Array,
    _extraTimeoutMillis?: number,
  ): Promise<Uint8Array> {
    this.record("sendBinaryRequest", {
      to: this.nodeIdByKey(contactPublicKey),
      requestCodeAndParams,
    });
    return resolved(new Uint8Array(0));
  }

  // Channel config mutation — recorded; no model yet.
  async setChannel(channelIdx: number, name: string, secret: Uint8Array): Promise<void> {
    this.record("setChannel", { channelIdx, name, secret: toHexLower(secret) });
    return resolved(undefined);
  }

  async deleteChannel(channelIdx: number): Promise<void> {
    this.record("deleteChannel", { channelIdx });
    return resolved(undefined);
  }

  // Signing — recorded (the data is not logged); no crypto.
  async sign(_data: Uint8Array): Promise<Uint8Array> {
    this.record("sign");
    return resolved(new Uint8Array(0));
  }

  // Path tracing — recorded; emits no TraceData yet.
  async tracePath(path: Uint8Array, _extraTimeoutMillis?: number): Promise<RawTraceData> {
    this.record("tracePath", { path });
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

  // Contact-add-mode config mutation — recorded; no model yet.
  async setOtherParams(manualAddContacts: boolean): Promise<void> {
    this.record("setOtherParams", { manualAddContacts });
    return resolved(undefined);
  }

  async setAutoAddContacts(): Promise<void> {
    this.record("setAutoAddContacts");
    return resolved(undefined);
  }

  async setManualAddContacts(): Promise<void> {
    this.record("setManualAddContacts");
    return resolved(undefined);
  }

  // Flood-scope config mutation — recorded; no model yet.
  async setFloodScope(transportKey: Uint8Array): Promise<unknown> {
    this.record("setFloodScope", { transportKey: toHexLower(transportKey) });
    return resolved(undefined);
  }

  async clearFloodScope(): Promise<unknown> {
    this.record("clearFloodScope");
    return resolved(undefined);
  }

  // --- internals ---

  /** The home node — the device this connection represents. */
  private homeNode(): SimNode {
    const home = this.world.nodes.find((n) => n.id === this.world.homeNodeId);
    if (home === undefined) {
      throw new SimError(`SimConnection: home node "${this.world.homeNodeId}" not found in world`);
    }
    return home;
  }

  /**
   * The home node's radio config, creating a zeroed one if the node has none,
   * so config mutations (`setTxPower` / `setRadioParams`) always have something
   * to write and `getSelfInfo` reflects them.
   */
  private homeRadio(): RadioConfig {
    const home = this.homeNode();
    if (home.radioConfig === undefined) {
      home.radioConfig = { freq: 0, bw: 0, sf: 0, cr: 0 };
    }
    return home.radioConfig;
  }

  /** Record that a node was just heard, for the contact roster's last-heard. */
  private markHeard(nodeId: string): void {
    this.lastHeardMs.set(nodeId, this.clock.now());
  }

  /**
   * Last-heard time for a node as device-epoch seconds: the stored time if the
   * node has emitted, else {@link bootMs} (heard as of connect). Unlike a
   * read-time `now()`, this lets a quiet node read as stale.
   */
  private lastHeardSecsOf(nodeId: string): number {
    return epochSecsOf(this.lastHeardMs.get(nodeId) ?? this.bootMs);
  }

  /**
   * Resolve the node referenced by a contact's public key (full hex match). A
   * contact always references a known node (validated by `defineWorld`), so a
   * miss is an internal inconsistency.
   */
  private nodeForContactKey(publicKey: string): SimNode {
    const node = this.world.nodes.find((n) => n.publicKey === publicKey);
    if (node === undefined) {
      throw new SimError(`SimConnection: contact key ${publicKey} references no node`);
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
   * Resolve a node id from a key passed to an outbound send (full key or prefix
   * match), regardless of reachability. Used to populate
   * {@link OutboundMessage.to} so a responder can match on destination. Returns
   * `undefined` if the key matches no known node.
   */
  private nodeIdByKey(key: Uint8Array): string | undefined {
    return this.world.nodes.find((n) => hexStartsWith(n.publicKey, key))?.id;
  }

  // --- reactive replies (responders) --------------------------------------

  /**
   * Match an outbound send against the configured {@link Responder}s and
   * schedule each resulting reply on the clock. A responder matches when its
   * `to` (if set) equals `msg.to` and its `when` predicate (if set) returns
   * true; its `reply` may produce one reply, several, or none. Replies are
   * delivered through the same {@link fireMessage} / {@link fireChannelMessage}
   * device-queue path as scenario events, so they stay deterministic.
   */
  private dispatchResponders(msg: OutboundMessage): void {
    for (const responder of this.responders) {
      if (responder.to !== undefined && responder.to !== msg.to) continue;
      if (responder.when !== undefined && !responder.when(msg)) continue;
      const produced = responder.reply(msg);
      if (produced === undefined) continue;
      const replies = Array.isArray(produced) ? produced : [produced];
      for (const reply of replies) this.scheduleReply(reply);
    }
  }

  /**
   * Schedule one responder reply at `clock.now() + after` (default `0`), firing
   * it through the matching scenario-event path so it flows through the
   * device-queue model. A `0` delay still goes through the clock, so the reply
   * is delivered on the next `advance` — never synchronously inside the send.
   */
  private scheduleReply(reply: ResponderReply): void {
    const delay = toMillis(reply.after ?? 0);
    if (isChannelReply(reply)) {
      this.clock.setTimeout(
        () =>
          this.fireChannelMessage({
            kind: "channelMessage",
            channel: reply.channel,
            text: reply.text,
            verified: reply.verified,
            rssi: reply.rssi,
            snr: reply.snr,
          }),
        delay,
      );
    } else {
      this.clock.setTimeout(
        () =>
          this.fireMessage({
            kind: "message",
            from: reply.from,
            text: reply.text,
            txtType: reply.txtType,
            rssi: reply.rssi,
            snr: reply.snr,
          }),
        delay,
      );
    }
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
        this.markHeard(event.nodeId);
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
    this.markHeard(event.from);
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
    if (event.from !== undefined) this.markHeard(event.from);
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
      // channelData carries `snr` but has no rssi field; surface rssi (when set)
      // on a LogRxData push, matching the verified path and scenario.ts's docs.
      if (event.rssi !== undefined) {
        this.emitPush(
          Constants.PushCodes.LogRxData,
          logRxDataOf(textToBytes(event.text), event.snr, event.rssi),
        );
      }
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
    this.markHeard(event.nodeId);
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
