/**
 * Procedural world generator — the cheap authoring path for scale fixtures.
 *
 * {@link generateWorld} builds an N-node mesh through the **same validated
 * builder path** as hand-authored worlds ({@link defineWorld} from
 * `builders.ts`), so a generated world is the same kind of internally consistent
 * `MeshWorld` object as anything a test writes by hand (PRD §4, "one fixture
 * object model"). It cannot make an inconsistent world.
 *
 * Variety comes entirely from a {@link SeededRandom}: **same seed ⇒ identical
 * world, byte for byte** (AGENTS.md "Determinism" rule). No RF physics, no
 * topology simulation — only plausible-shaped attributes like display names and
 * battery jitter (PRD §6 guardrail: "plausible-shaped, never simulated").
 *
 * ### ID scheme and uniqueness
 *
 * Each remote node gets an id of the form `"<adjective>-<place>"` drawn from a
 * small, curated word list (see {@link ADJ_WORDS} and {@link PLACE_WORDS}). After
 * the word-pair pool is exhausted, a numeric suffix (`-2`, `-3`, …) ensures
 * uniqueness for any count. Because the PRNG is seeded and picks are sequential,
 * the same seed always selects the same name in the same position, so the node
 * ids are stable across runs.
 *
 * The home node always has id `"home"`.
 *
 * ### Knob count
 *
 * Only four knobs: `seed`, `nodes`, optional `repeaters`, optional `channels`.
 * A generator with thirty parameters is as much setup as hand-writing (PRD §6).
 */

import { channel, contact, defineWorld, node } from "./builders.js";
import { SeededRandom } from "./random.js";
import { ChannelKind, NodeRole } from "./world.js";
import type { MeshWorld } from "./world.js";

/**
 * Adjective portion of the generated name pool.
 *
 * Small and curated: evocative of physical places, varied in length. The list is
 * intentionally not too long — the pool is a product of adjectives × places, so
 * even a handful of each covers dozens of unique ids.
 */
const ADJ_WORDS: readonly string[] = [
  "rocky",
  "cedar",
  "summit",
  "river",
  "silver",
  "golden",
  "shadow",
  "pine",
  "iron",
  "granite",
] as const;

/**
 * Place-suffix portion of the generated name pool.
 */
const PLACE_WORDS: readonly string[] = [
  "ridge",
  "creek",
  "peak",
  "hollow",
  "falls",
  "crossing",
  "bluff",
  "valley",
  "grove",
  "point",
] as const;

/** Total unique word-pair combinations before numeric suffixes kick in. */
const WORD_POOL_SIZE = ADJ_WORDS.length * PLACE_WORDS.length;

/**
 * Generate a unique node id at index `i` using the seeded random's accumulated
 * state (call order matches generation order, so the same seed always produces
 * the same id at the same position).
 *
 * For `i < WORD_POOL_SIZE` we draw a pair from the pool, avoiding collisions by
 * tracking used pairs. Beyond the pool size, we append a numeric suffix so
 * uniqueness is always guaranteed.
 *
 * @param rng - The seeded PRNG (advanced in place; call order must be stable).
 * @param used - Set of already-used ids (mutated to track new id).
 */
function generateNodeId(rng: SeededRandom, used: Set<string>): string {
  // Try up to 3 random picks before falling back to a guaranteed-unique id.
  for (let attempt = 0; attempt < 3; attempt++) {
    const adj = rng.pick(ADJ_WORDS);
    const place = rng.pick(PLACE_WORDS);
    const candidate = `${adj}-${place}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Fallback: find an unused suffixed id deterministically.
  const adj = rng.pick(ADJ_WORDS);
  const place = rng.pick(PLACE_WORDS);
  const base = `${adj}-${place}`;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix++;
  }
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

/** Options for {@link generateWorld}. */
export interface GenerateWorldOptions {
  /**
   * Seed for the PRNG. The same seed always produces a deep-equal world
   * (determinism guarantee, AGENTS.md).
   */
  seed: number;
  /**
   * Total number of nodes in the world, **including** the home companion.
   * Must be ≥ 1.
   */
  nodes: number;
  /**
   * How many of the remote nodes are {@link NodeRole.Repeater}s.
   *
   * Defaults to `max(0, floor(remotes / 4))` — a sensible ~25% fraction.
   * If greater than `nodes - 1`, it is clamped to the number of remote nodes.
   */
  repeaters?: number;
  /**
   * How many channel slots to generate.
   *
   * Defaults to `2`: a `"public"` channel at index 0 and an `"ops"` private
   * channel at index 1. Pass `1` for a public-only world; `0` for no channels.
   */
  channels?: number;
}

/**
 * Generate a plausible-shaped {@link MeshWorld} from a few knobs.
 *
 * The world is built through {@link defineWorld} (the single validated path) so
 * it is the same kind of validated, internally consistent object as a
 * hand-authored world — a generator can never produce an inconsistent world.
 *
 * Same seed ⇒ deep-equal world, byte for byte.
 *
 * @example
 * ```ts
 * const world = generateWorld({ seed: 42, nodes: 10, repeaters: 2 });
 * // → 1 home companion + 2 repeaters + 7 companions, 2 channels, 10 contacts
 * ```
 *
 * @throws {RangeError} If `nodes < 1`.
 */
export function generateWorld(opts: GenerateWorldOptions): MeshWorld {
  const { seed, nodes: totalNodes } = opts;

  if (totalNodes < 1) {
    throw new RangeError(`generateWorld: nodes must be >= 1, got ${totalNodes}`);
  }

  const rng = new SeededRandom(seed);

  // Number of remote nodes (everything except the home node).
  const remoteCount = totalNodes - 1;

  // Compute default repeater count: ~1/4 of remotes, min 0.
  const defaultRepeaters = Math.max(0, Math.floor(remoteCount / 4));
  const repeaterCount = Math.min(
    remoteCount,
    opts.repeaters !== undefined ? opts.repeaters : defaultRepeaters,
  );

  // Channel count: default to 2 (a public channel + an "ops" private one) when
  // there are remote nodes to talk to, or 1 (public only) for a lone home node.
  const effectiveChannelCount =
    opts.channels !== undefined ? opts.channels : remoteCount > 0 ? 2 : 1;

  // -------------------------------------------------------------------
  // Generate node ids (stable per seed, unique within this world).
  // -------------------------------------------------------------------
  const usedIds = new Set<string>(["home"]);
  const remoteIds: string[] = [];
  for (let i = 0; i < remoteCount; i++) {
    remoteIds.push(generateNodeId(rng, usedIds));
  }

  // -------------------------------------------------------------------
  // Build nodes with seeded battery jitter (20–100%).
  // -------------------------------------------------------------------
  const remoteNodes = remoteIds.map((id, idx) => {
    const isRepeater = idx < repeaterCount;
    const battery = rng.int(20, 100);
    return node(id, {
      role: isRepeater ? NodeRole.Repeater : NodeRole.Companion,
      battery,
      reachable: true,
    });
  });

  // -------------------------------------------------------------------
  // Generate channels.
  // -------------------------------------------------------------------
  const channels = [];
  if (effectiveChannelCount >= 1) {
    channels.push(channel(0, "public", { kind: ChannelKind.Public }));
  }
  if (effectiveChannelCount >= 2) {
    channels.push(channel(1, "ops", { kind: ChannelKind.Private }));
  }
  // For any extra channels beyond 2, generate numbered ones.
  for (let i = 2; i < effectiveChannelCount; i++) {
    channels.push(channel(i, `ch${i}`, { kind: ChannelKind.Private }));
  }

  // -------------------------------------------------------------------
  // Build contacts — all remote nodes are contacts of the home node.
  // Contact name = node id (already a friendly display name).
  // -------------------------------------------------------------------
  const contacts = remoteIds.map((id) => contact(id, id));

  // -------------------------------------------------------------------
  // Assemble through defineWorld — the single validated path.
  // -------------------------------------------------------------------
  return defineWorld({
    homeNodeId: "home",
    nodes: ["home", ...remoteNodes],
    channels,
    contacts,
  });
}
