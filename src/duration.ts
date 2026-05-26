/**
 * The {@link Duration} type and its parser.
 *
 * A duration is either a raw millisecond count or a human-friendly string like
 * `"30s"`. Both the virtual clock (`SimClock`) and the scenario timeline use it
 * to describe spans of *simulated* time, so it lives standalone with no other
 * dependencies.
 */

import { SimError } from "./errors.js";

/**
 * A span of simulated time.
 *
 * Either a number of milliseconds, or a string with a unit suffix:
 * `"500ms"`, `"30s"`, `"2m"`, `"1h"`. The numeric part may be fractional
 * (e.g. `"1.5s"`).
 */
export type Duration = number | string;

/** Unit suffixes recognized by {@link toMillis}, longest-first. */
const UNITS: ReadonlyArray<readonly [suffix: string, millis: number]> = [
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
];

/**
 * Resolve a {@link Duration} to a millisecond count.
 *
 * A number is returned as-is (after validation); a string is parsed by its
 * unit suffix. The result must be a finite, non-negative number.
 *
 * @throws {SimError} If the value is not a valid, non-negative duration.
 */
export function toMillis(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) {
      throw new SimError(`Invalid duration: ${d} (expected a finite, non-negative number of ms)`);
    }
    return d;
  }

  const trimmed = d.trim();
  for (const [suffix, scale] of UNITS) {
    if (trimmed.endsWith(suffix)) {
      const numeric = trimmed.slice(0, -suffix.length).trim();
      const value = Number(numeric);
      if (numeric === "" || !Number.isFinite(value) || value < 0) {
        throw new SimError(`Invalid duration: "${d}" (bad numeric part before "${suffix}")`);
      }
      return value * scale;
    }
  }

  throw new SimError(
    `Invalid duration: "${d}" (expected a number of ms or a string like "30s", "500ms", "2m", "1h")`,
  );
}
