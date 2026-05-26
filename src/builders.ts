/**
 * Builders with strong defaults — the single validated path that produces every
 * world.
 *
 * Fixtures must be cheap to author or coverage stays thin (PRD §6). These
 * builders return fully-formed objects from a minimal spec, so a test overrides
 * only the one field it cares about and everything else is defaulted and
 * invisible. {@link defineWorld} is the *one validated constructor*: generated
 * worlds (a later milestone) go through this same path, so a generator can
 * never produce an internally inconsistent world (PRD §4).
 */

import { deriveNodeKey } from "./keys.js";
import { SimError } from "./errors.js";
import {
  ChannelKind,
  NodeRole,
  type MeshWorld,
  type SimChannel,
  type SimContact,
  type SimNode,
} from "./world.js";

/** Default LoRa radio config (the MeshCore US 910.525 MHz preset). */
const DEFAULT_RADIO = {
  freq: 910_525,
  bw: 250,
  sf: 10,
  cr: 5,
  txPower: 22,
} as const;

/** Default battery level, as a percentage. */
const DEFAULT_BATTERY = 100;

/** Default firmware version reported by a node. */
const DEFAULT_FIRMWARE_VER = 1;

/** Default manufacturer / model string. */
const DEFAULT_MODEL = "meshcore-sim";

/**
 * Build a fully-formed {@link SimNode} from an id, defaulting everything else.
 *
 * Defaults: `role: "companion"`, `reachable: true`, full battery, the standard
 * radio preset, `name` equal to `id`, and a `publicKey` derived
 * deterministically from `id`. Override only the fields a test cares about.
 *
 * `id` and `publicKey` cannot be overridden: the key is a pure function of the
 * id, so allowing either to diverge would break the world's internal
 * consistency.
 */
export function node(
  id: string,
  overrides: Partial<Omit<SimNode, "id" | "publicKey">> = {},
): SimNode {
  return {
    id,
    name: id,
    role: NodeRole.Companion,
    reachable: true,
    battery: DEFAULT_BATTERY,
    radioConfig: { ...DEFAULT_RADIO },
    firmwareVer: DEFAULT_FIRMWARE_VER,
    model: DEFAULT_MODEL,
    ...overrides,
    publicKey: deriveNodeKey(id),
  };
}

/**
 * Build a fully-formed {@link SimChannel} from a slot index and name.
 *
 * Defaults: `kind: "public"` and a deterministic `secret` derived from the
 * name (so the same channel name always yields the same secret).
 */
export function channel(
  idx: number,
  name: string,
  overrides: Partial<Omit<SimChannel, "idx" | "name">> = {},
): SimChannel {
  return {
    idx,
    name,
    kind: ChannelKind.Public,
    // Reuse the deterministic key derivation for a stable per-name secret; the
    // simulator does no real crypto, it only needs a stable identifier.
    secret: deriveNodeKey(`channel:${name}`),
    ...overrides,
  };
}

/**
 * Build a {@link SimContact} pointing at a node, deriving its public key from
 * the referenced node id so the contact and node line up.
 */
export function contact(name: string, nodeId: string): SimContact {
  return {
    name,
    nodeId,
    publicKey: deriveNodeKey(nodeId),
  };
}

/** Spec accepted by {@link defineWorld}. */
export interface WorldSpec {
  /** Id of the node the app connects to. */
  homeNodeId: string;
  /**
   * Nodes in the world. A bare string is normalized through {@link node} with
   * all defaults. If omitted, a default home node is created from `homeNodeId`.
   */
  nodes?: (SimNode | string)[];
  /** Channels. Defaults to none. */
  channels?: SimChannel[];
  /** Contacts. Defaults to none. */
  contacts?: SimContact[];
}

/**
 * Assemble and validate a {@link MeshWorld} — the single constructor every
 * world passes through.
 *
 * String node entries are normalized through {@link node}. If no node matches
 * `homeNodeId` (including when `nodes` is omitted entirely), a default home
 * node is created.
 *
 * Validates that node ids are unique, channel indices are unique, every
 * contact references a known node, and `homeNodeId` references a known node.
 *
 * @throws {SimError} On any validation failure.
 */
export function defineWorld(spec: WorldSpec): MeshWorld {
  const channels = spec.channels ?? [];
  const contacts = spec.contacts ?? [];

  // Normalize node entries (a bare string becomes a defaulted node).
  const nodes: SimNode[] = (spec.nodes ?? []).map((entry) =>
    typeof entry === "string" ? node(entry) : entry,
  );

  // Ensure unique node ids before doing anything else that indexes by id.
  const seenNodeIds = new Set<string>();
  for (const n of nodes) {
    if (seenNodeIds.has(n.id)) {
      throw new SimError(`Duplicate node id: "${n.id}"`);
    }
    seenNodeIds.add(n.id);
  }

  // Create a default home node if one was not supplied.
  if (!seenNodeIds.has(spec.homeNodeId)) {
    nodes.unshift(node(spec.homeNodeId));
    seenNodeIds.add(spec.homeNodeId);
  }

  // Unique channel indices.
  const seenChannelIdxs = new Set<number>();
  for (const c of channels) {
    if (seenChannelIdxs.has(c.idx)) {
      throw new SimError(`Duplicate channel idx: ${c.idx}`);
    }
    seenChannelIdxs.add(c.idx);
  }

  // Every contact must reference a known node.
  for (const c of contacts) {
    if (!seenNodeIds.has(c.nodeId)) {
      throw new SimError(
        `Contact "${c.name}" references unknown node id: "${c.nodeId}"`,
      );
    }
  }

  // The home node must exist (it always does after the default-creation step,
  // but assert it explicitly so the invariant is self-documenting).
  if (!seenNodeIds.has(spec.homeNodeId)) {
    throw new SimError(`Unknown homeNodeId: "${spec.homeNodeId}"`);
  }

  return {
    homeNodeId: spec.homeNodeId,
    nodes,
    channels,
    contacts,
  };
}
