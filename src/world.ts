/**
 * The static fixture object model — the simulated world as a snapshot.
 *
 * These are *author-facing* types: friendly, hand-writable shapes describing
 * the mesh as observable through the home node (PRD §5, §7). They are
 * deliberately **not** the raw meshcore.js wire shapes (`RawSelfInfo`,
 * `RawContact`, `RawRepeaterStats`, …) — those are synthesized from this model
 * by the encode layer in a later milestone. Keeping authoring types separate
 * from wire types is what lets a test read as "a mesh where X has low battery"
 * with everything else defaulted away.
 *
 * Enums follow the meshcore-ts idiom: a frozen `const` object plus a matching
 * union type, so each value is both runtime-usable and type-safe.
 */

/**
 * The role a node advertises on the mesh.
 *
 * The encode layer maps these to meshcore's `AdvType`:
 * `companion → Chat`, `repeater → Repeater`, `roomserver → Room`.
 */
export const NodeRole = {
  Companion: "companion",
  Repeater: "repeater",
  RoomServer: "roomserver",
} as const;
export type NodeRole = (typeof NodeRole)[keyof typeof NodeRole];

/**
 * Whether a channel's secret is the well-known public key or a private one.
 *
 * Drives decrypt-verification outcomes in the dynamic layer: traffic on a
 * `private` channel the device cannot decrypt surfaces as unverified
 * `channelData`, never a verified `channelMessage` (PRD §5, the provenance
 * contract).
 */
export const ChannelKind = {
  Public: "public",
  Private: "private",
} as const;
export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

/**
 * A node's LoRa radio configuration.
 *
 * Mirrors the radio fields meshcore-ts surfaces on `SelfInfo`
 * (`radioFreq`/`radioBw`/`radioSf`/`radioCr`), so the encode layer can copy
 * them straight onto a `RawSelfInfo`.
 */
export interface RadioConfig {
  /** Centre frequency, in kHz. */
  freq: number;
  /** Bandwidth, in kHz. */
  bw: number;
  /** Spreading factor (an integer, typically 7–12). */
  sf: number;
  /** Coding rate denominator (an integer, typically 5–8). */
  cr: number;
  /** Transmit power, in dBm. */
  txPower?: number;
}

/**
 * A node in the simulated mesh — the home node or a reachable remote node.
 *
 * Carries everything the encode layer needs to synthesize a `RawSelfInfo`
 * (for the home node), a `RawContact` (for remote nodes), and a
 * `RawRepeaterStats` (for repeaters): identity, role, radio config, position,
 * battery, and firmware/model defaults.
 */
export interface SimNode {
  /** Stable, human-readable identifier, unique within a world. */
  id: string;
  /** Advertised display name. Defaults to {@link SimNode.id}. */
  name: string;
  /** Advertised role. */
  role: NodeRole;
  /**
   * Whether the node answers queries. An unreachable node rejects reads the
   * way an offline device would, so the app surfaces a typed error.
   */
  reachable: boolean;
  /** 32-byte public key, lowercase hex, derived deterministically from the id. */
  publicKey: string;
  /** Battery level as a percentage `0..100`. */
  battery?: number;
  /** LoRa radio configuration. */
  radioConfig?: RadioConfig;
  /** Admin commands this node accepts (drives admin-gate test cases). */
  adminCommands?: string[];
  /** Advertised latitude, in degrees. */
  lat?: number;
  /** Advertised longitude, in degrees. */
  lon?: number;
  /** Firmware version reported by the device. */
  firmwareVer?: number;
  /** Manufacturer / model string reported by the device. */
  model?: string;
}

/**
 * A configured channel slot on the home device.
 *
 * The `secret` is hex (the well-known public key for `public` channels, a
 * per-channel secret for `private` ones). Whether the device holds a usable
 * key for a channel determines whether traffic on it decrypt-verifies.
 */
export interface SimChannel {
  /** Channel slot index, unique within a world. */
  idx: number;
  /** Channel display name. */
  name: string;
  /** Whether the channel is public or private. */
  kind: ChannelKind;
  /** Channel secret, lowercase hex. */
  secret: string;
}

/** A contact stored on the home device, pointing at a node in the world. */
export interface SimContact {
  /** 32-byte public key, lowercase hex (matches the referenced node's key). */
  publicKey: string;
  /** Advertised display name. */
  name: string;
  /** Id of the {@link SimNode} this contact refers to. */
  nodeId: string;
}

/**
 * A simulated mesh as observable through the home node — the static fixture.
 *
 * Built and validated through `defineWorld`, never assembled by hand, so
 * hand-written and generated worlds are the same kind of validated object
 * (PRD §4, "one fixture object model").
 */
export interface MeshWorld {
  /** Id of the node the app connects to. Must reference a node in `nodes`. */
  homeNodeId: string;
  /** The home node plus reachable remote nodes. */
  nodes: SimNode[];
  /** Configured channels. */
  channels: SimChannel[];
  /** Contacts stored on the home device. */
  contacts: SimContact[];
}
