/**
 * Scenario generators — the cheap authoring path for dynamic timelines.
 *
 * Each generator returns a validated {@link Scenario} built through the same
 * {@link scenario} constructor every scenario passes through, so generated
 * timelines are the same kind of validated, sorted objects as hand-authored ones
 * (PRD §4, "one fixture object model").
 *
 * All timing jitter comes from a {@link SeededRandom}: **same seed ⇒ identical
 * scenario, byte for byte** (AGENTS.md "Determinism" rule). If `seed` is omitted
 * from an options object, a fixed default constant is used so the result is still
 * fully deterministic.
 *
 * ### Available generators
 *
 * - {@link burst} — `count` messages from one node spread across a window with
 *   seeded jitter. The canonical coalescer stressor ("a three-message burst").
 * - {@link crosstalk} — interleaved messages from multiple nodes in a window,
 *   seeded order and timing. Exercises concurrent-sender debounce logic.
 * - {@link quiet} — an empty timeline spanning a duration. Represents an idle
 *   span the test advances through; useful for asserting nothing spuriously fires.
 * - {@link outOfOrder} — messages whose **arrival** order differs from their
 *   **sender-timestamp** order. Models a burst where packets arrive out of send
 *   order, exercising reordering logic in a coalescer.
 *
 * ### `outOfOrder` modelling
 *
 * We use the **preferred `sentAt` approach** from the spec: {@link MessageEvent}
 * and {@link ChannelMessageEvent} gain an optional `sentAt?: Duration` field (a
 * sender-clock offset, relative to connect time). When present, `sentAt` is used
 * as the `senderTimestamp` in the encoded `RawContactMessage` / `RawChannelMessage`
 * instead of `clock.now()`.
 *
 * `outOfOrder` emits `count` messages whose **arrival** times (`at`) form one
 * ordering (seeded jitter within `within`) while their **sender timestamps**
 * (`sentAt`) form the reverse ordering — so arrival order ≠ send order. A
 * coalescer that trusts arrival order will see them in the "wrong" sequence; one
 * that reorders by `senderTimestamp` will see them in send order.
 *
 * The `sentAt` addition is **additive** — all existing tests that do not set
 * `sentAt` continue to use `clock.now()` for `senderTimestamp`, exactly as
 * before. See changes in `scenario.ts`, `encode.ts`, and `connection.ts`.
 *
 * ### Export shape
 *
 * The four generators are collected on a {@link traffic} namespace object so
 * they can be imported as:
 * ```ts
 * import { traffic } from "@dpup/meshcore-sim";
 * traffic.burst({ from: "rocky", count: 3, within: "5s" });
 * ```
 * Each generator is also a named export for tree-shaking / destructuring.
 */

import { at, scenario } from "./scenario.js";
import { SeededRandom } from "./random.js";
import { toMillis } from "./duration.js";
import type { Duration } from "./duration.js";
import type { Scenario } from "./scenario.js";

/** Default seed used when no `seed` is specified by the caller. */
const DEFAULT_SEED = 0xcafe_babe;

// ---------------------------------------------------------------------------
// burst
// ---------------------------------------------------------------------------

/** Options for {@link burst}. */
export interface BurstOptions {
  /** Id of the `SimNode` that sends all messages. */
  from: string;
  /** Number of messages to generate. Must be ≥ 1. */
  count: number;
  /**
   * Window in which all messages must arrive. Every generated event has
   * `at ≤ within` (with jitter placing messages anywhere inside the window).
   */
  within: Duration;
  /**
   * Optional seed for the PRNG. Same seed ⇒ identical scenario.
   * Defaults to a fixed constant so the result is always deterministic.
   */
  seed?: number;
  /**
   * Override the text for each message. Receives the 0-based index.
   * Defaults to `"msg <i>"`.
   */
  text?: (i: number) => string;
}

/**
 * Generate `count` messages from node `from`, spread across `within` with
 * seeded jitter.
 *
 * This is the canonical coalescer stressor: `traffic.burst({ from: "rocky",
 * count: 3, within: "5s" })` gives you a scenario that fires three messages
 * across a 5-second window, with arrival offsets jittered by the PRNG (never
 * evenly spaced). Same seed ⇒ identical scenario.
 *
 * @throws {RangeError} If `count < 1`.
 */
export function burst(opts: BurstOptions): Scenario {
  if (opts.count < 1) {
    throw new RangeError(`burst: count must be >= 1, got ${opts.count}`);
  }
  const rng = new SeededRandom(opts.seed ?? DEFAULT_SEED);
  const windowMs = toMillis(opts.within);
  const textFn = opts.text ?? ((i: number) => `msg ${i}`);

  const events = Array.from({ length: opts.count }, (_, i) => {
    // Jitter is uniformly distributed over [0, windowMs]; different picks for
    // each message because rng.next() advances the state.
    const offsetMs = Math.floor(rng.next() * windowMs);
    return at(offsetMs, { kind: "message", from: opts.from, text: textFn(i) });
  });

  return scenario(events);
}

// ---------------------------------------------------------------------------
// crosstalk
// ---------------------------------------------------------------------------

/** Options for {@link crosstalk}. */
export interface CrosstalkOptions {
  /**
   * Ids of the `SimNode`s that send messages. At least one node is required.
   * Each node will send at least one message.
   */
  nodes: string[];
  /**
   * Total number of messages to generate across all nodes.
   *
   * Defaults to `nodes.length * 2` (each node sends ~2 messages on average).
   * Must be ≥ `nodes.length` so every node sends at least one message.
   */
  count?: number;
  /** Window in which all messages arrive. */
  within: Duration;
  /**
   * Optional seed. Same seed ⇒ identical scenario.
   * Defaults to a fixed constant.
   */
  seed?: number;
}

/**
 * Generate interleaved messages from multiple nodes within a window.
 *
 * Arrival times and node assignments are seeded so the same `seed` always
 * produces the same scenario. Every node in `nodes` sends at least one message.
 *
 * @throws {RangeError} If `nodes` is empty or `count < nodes.length`.
 */
export function crosstalk(opts: CrosstalkOptions): Scenario {
  if (opts.nodes.length === 0) {
    throw new RangeError("crosstalk: nodes must be non-empty");
  }
  const totalCount = opts.count ?? opts.nodes.length * 2;
  if (totalCount < opts.nodes.length) {
    throw new RangeError(
      `crosstalk: count (${totalCount}) must be >= nodes.length (${opts.nodes.length})`,
    );
  }

  const rng = new SeededRandom(opts.seed ?? DEFAULT_SEED);
  const windowMs = toMillis(opts.within);

  // Assign messages to nodes: first, give each node exactly one guaranteed
  // message, then distribute the remainder randomly. This ensures every node
  // appears in the output.
  const senders: string[] = [
    ...opts.nodes, // guaranteed one each
    ...Array.from({ length: totalCount - opts.nodes.length }, () => rng.pick(opts.nodes)),
  ];

  // Shuffle senders with the PRNG (Fisher-Yates) for a seeded interleaving.
  for (let i = senders.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = senders[i]!;
    senders[i] = senders[j]!;
    senders[j] = tmp;
  }

  // Assign seeded arrival offsets.
  const events = senders.map((from, i) => {
    const offsetMs = Math.floor(rng.next() * windowMs);
    return at(offsetMs, { kind: "message" as const, from, text: `msg ${i}` });
  });

  return scenario(events);
}

// ---------------------------------------------------------------------------
// quiet
// ---------------------------------------------------------------------------

/** Options for {@link quiet}. */
export interface QuietOptions {
  /**
   * How long the idle span lasts.
   *
   * The returned scenario has no events, but the `duration` is stored so a
   * test can use it with `clock.advance(opts.duration)` to represent the idle
   * period. It is intentionally not embedded in the Scenario itself (a Scenario
   * is just events); pass it to the clock separately.
   */
  duration: Duration;
}

/**
 * Return an empty {@link Scenario} representing an idle span.
 *
 * Use it together with `clock.advance(opts.duration)` to represent a period
 * during which nothing should arrive. Useful for asserting that debounce timers
 * don't fire spuriously, or that the world stays quiet between bursts.
 *
 * @example
 * ```ts
 * const silence = traffic.quiet({ duration: "10s" });
 * // silence.events is empty; advance the clock separately:
 * clock.advance("10s");
 * expect(received).toHaveLength(0);
 * ```
 */
export function quiet(_opts: QuietOptions): Scenario {
  return scenario([]);
}

// ---------------------------------------------------------------------------
// outOfOrder
// ---------------------------------------------------------------------------

/** Options for {@link outOfOrder}. */
export interface OutOfOrderOptions {
  /** Id of the `SimNode` that sends all messages. */
  from: string;
  /** Number of messages to generate. Must be ≥ 2 (otherwise "out of order" is trivial). */
  count: number;
  /**
   * Arrival window. All messages arrive within `within` ms of connect time.
   */
  within: Duration;
  /**
   * Optional seed. Same seed ⇒ identical scenario.
   * Defaults to a fixed constant.
   */
  seed?: number;
}

/**
 * Generate messages whose **arrival** order differs from their **sender-timestamp** order.
 *
 * **Model (preferred `sentAt` approach):** Each message has two time offsets:
 * - `at` — the arrival offset (when the message enters the device queue). These
 *   are jittered within `within` in **ascending** order (earliest arrival first).
 * - `sentAt` — the sender's clock offset at send time. These are set to the
 *   **reverse** of the arrival offsets — so the last message to arrive has the
 *   smallest `sentAt` and the first to arrive has the largest `sentAt`.
 *
 * Concretely: if arrivals are `[t1 < t2 < t3]` then `sentAt` values are
 * `[t3, t2, t1]`. A consumer that trusts arrival order sees them in ascending-
 * arrival order; a consumer that reorders by `senderTimestamp` will see them in
 * *descending*-arrival order — the intended reorder stress.
 *
 * The `sentAt` field is an optional extension on {@link MessageEvent} (see
 * `scenario.ts`); when absent the connection uses `clock.now()` as before.
 *
 * @throws {RangeError} If `count < 2`.
 */
export function outOfOrder(opts: OutOfOrderOptions): Scenario {
  if (opts.count < 2) {
    throw new RangeError(`outOfOrder: count must be >= 2, got ${opts.count}`);
  }

  const rng = new SeededRandom(opts.seed ?? DEFAULT_SEED);
  const windowMs = toMillis(opts.within);

  // Generate `count` distinct arrival offsets in [0, windowMs) and sort them.
  const arrivalOffsets: number[] = Array.from(
    { length: opts.count },
    () => Math.floor(rng.next() * windowMs),
  );
  arrivalOffsets.sort((a, b) => a - b);

  // sentAt values are the same set of offsets but in reversed order, so
  // arrival[0] has sentAt = arrival[count-1], arrival[1] has sentAt = arrival[count-2], etc.
  // This guarantees arrival order ≠ sender-timestamp order (for count >= 2 with
  // distinct offsets; duplicates are possible but the reversal still inverts).
  const sentAtOffsets = [...arrivalOffsets].reverse();

  const events = arrivalOffsets.map((arrivalMs, i) => {
    const sentAtMs = sentAtOffsets[i]!;
    return at(arrivalMs, {
      kind: "message" as const,
      from: opts.from,
      text: `msg ${i}`,
      sentAt: sentAtMs,
    });
  });

  return scenario(events);
}

// ---------------------------------------------------------------------------
// traffic namespace object
// ---------------------------------------------------------------------------

/**
 * A namespace collecting all scenario generators.
 *
 * @example
 * ```ts
 * import { traffic } from "@dpup/meshcore-sim";
 * const scn = traffic.burst({ from: "rocky-ridge", count: 5, within: "10s", seed: 42 });
 * ```
 */
export const traffic = {
  burst,
  crosstalk,
  quiet,
  outOfOrder,
} as const;
