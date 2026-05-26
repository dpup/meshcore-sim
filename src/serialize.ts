/**
 * Serialization and deserialization helpers for {@link MeshWorld} and
 * {@link Scenario} — the "freeze to a committed fixture" path (PRD §4, §6).
 *
 * A serialized fixture is a **self-describing, pretty-printed JSON string**:
 *
 * ```json
 * {
 *   "format": "meshcore-sim/world",
 *   "version": 1,
 *   "world": { … }
 * }
 * ```
 *
 * The envelope `format`/`version` fields let a reader (and `loadWorld`) detect
 * stale or mismatched fixtures at a glance and reject them with a clear error.
 *
 * ### Determinism / idempotency
 *
 * Serialization is deterministic by construction: the envelope keys are built
 * in a fixed order (`format`, `version`, then the payload key), and the world/
 * scenario objects themselves are built through the validated constructors
 * (`defineWorld`, `scenario`), whose output shapes have a fixed key order.
 * `JSON.stringify(…, null, 2)` then produces a stable string because V8
 * serializes object keys in insertion order. A serialize → load → serialize
 * cycle produces an identical string.
 *
 * ### `Uint8Array` encoding
 *
 * `TelemetryEvent.lppSensorData` is the one non-JSON-primitive field.
 * It is encoded as an object `{ "$uint8array": "<lowercase-hex>" }` so the
 * serialized form is unambiguous and human-readable. The decoder recognises
 * that sentinel and reconstructs the exact bytes.
 *
 * ### Re-validation on load
 *
 * `loadWorld` passes parsed nodes, channels, contacts, and `homeNodeId`
 * through `defineWorld` (the single validated constructor) so a loaded world
 * is the same validated object as any other. `loadScenario` passes all parsed
 * events through `scenario()` (the single validated, sorting constructor).
 */

import { SimError } from "./errors.js";
import { defineWorld } from "./builders.js";
import { scenario } from "./scenario.js";
import type { MeshWorld } from "./world.js";
import type { Scenario, ScheduledEvent, SimEvent, TelemetryEvent } from "./scenario.js";

// ---------------------------------------------------------------------------
// Format envelope constants
// ---------------------------------------------------------------------------

const WORLD_FORMAT = "meshcore-sim/world" as const;
const SCENARIO_FORMAT = "meshcore-sim/scenario" as const;
const SUPPORTED_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Internal types for the JSON wire shapes
// ---------------------------------------------------------------------------

/** Uint8Array encoded as a hex sentinel object. */
interface EncodedUint8Array {
  $uint8array: string;
}

/** Check whether a value is our Uint8Array sentinel. */
function isEncodedUint8Array(v: unknown): v is EncodedUint8Array {
  return (
    typeof v === "object" &&
    v !== null &&
    "$uint8array" in v &&
    typeof (v as Record<string, unknown>)["$uint8array"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Hex helpers (kept local — no new dependencies)
// ---------------------------------------------------------------------------

/** Encode a `Uint8Array` to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decode a lowercase hex string to a `Uint8Array`. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new SimError(
      `serialize: invalid hex string (odd length ${hex.length}): "${hex}"`,
    );
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new SimError(
        `serialize: invalid hex character at position ${i * 2}: "${hex.slice(i * 2, i * 2 + 2)}"`,
      );
    }
    out[i] = byte;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SimEvent encoding / decoding for JSON
// ---------------------------------------------------------------------------

/** Plain-JSON representation of a `SimEvent` (Uint8Array fields encoded). */
type SerializedSimEvent = Omit<TelemetryEvent, "lppSensorData"> & {
  lppSensorData?: EncodedUint8Array;
} | Exclude<SimEvent, TelemetryEvent>;

/**
 * Encode a `SimEvent` to a JSON-safe plain object.
 *
 * The only non-JSON-primitive field is `TelemetryEvent.lppSensorData`, encoded
 * as `{ "$uint8array": "<hex>" }`.
 */
function encodeEvent(event: SimEvent): SerializedSimEvent {
  if (event.kind === "telemetry" && event.lppSensorData !== undefined) {
    return {
      ...event,
      lppSensorData: { $uint8array: bytesToHex(event.lppSensorData) },
    };
  }
  // All other event kinds are already JSON-safe.
  return event as SerializedSimEvent;
}

/**
 * Decode a parsed JSON event back to a `SimEvent`, reconstructing `Uint8Array`
 * fields from their hex sentinels.
 */
function decodeEvent(raw: unknown): SimEvent {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("kind" in raw) ||
    typeof (raw as Record<string, unknown>)["kind"] !== "string"
  ) {
    throw new SimError(
      `serialize: expected a SimEvent object with a "kind" string, got: ${JSON.stringify(raw)}`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (obj["kind"] === "telemetry") {
    const lpps = obj["lppSensorData"];
    if (lpps !== undefined) {
      if (!isEncodedUint8Array(lpps)) {
        throw new SimError(
          `serialize: TelemetryEvent.lppSensorData must be a {"$uint8array":"<hex>"} object; got: ${JSON.stringify(lpps)}`,
        );
      }
      return {
        ...obj,
        lppSensorData: hexToBytes(lpps.$uint8array),
      } as SimEvent;
    }
  }

  return obj as unknown as SimEvent;
}

// ---------------------------------------------------------------------------
// World serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link MeshWorld} to a pretty-printed, deterministic JSON string.
 *
 * The output is wrapped in a self-describing envelope:
 * ```json
 * { "format": "meshcore-sim/world", "version": 1, "world": { … } }
 * ```
 *
 * The same world always serializes to the same string (deterministic), and a
 * serialize → load → serialize cycle yields the identical string (idempotent).
 */
export function serializeWorld(world: MeshWorld): string {
  // Build the envelope explicitly with a fixed key order so the output is
  // deterministic across runs regardless of how JS engines order object keys.
  const envelope = {
    format: WORLD_FORMAT,
    version: SUPPORTED_VERSION,
    world: {
      homeNodeId: world.homeNodeId,
      nodes: world.nodes,
      channels: world.channels,
      contacts: world.contacts,
    },
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse and validate a {@link MeshWorld} from a JSON string produced by
 * {@link serializeWorld}.
 *
 * The parsed nodes, channels, contacts, and `homeNodeId` are re-validated
 * through {@link defineWorld} — the single constructor — so the returned world
 * is exactly the same kind of validated, internally consistent object as any
 * other world.
 *
 * @throws {SimError} If the input is not valid JSON, uses the wrong `format`,
 *   an unsupported `version`, or fails `defineWorld` validation.
 */
export function loadWorld(json: string): MeshWorld {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new SimError(
      `loadWorld: input is not valid JSON: ${String(cause)}`,
      { cause },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new SimError(
      `loadWorld: expected a JSON object at the top level; got ${typeof parsed}`,
    );
  }

  const top = parsed as Record<string, unknown>;

  // Check format field.
  if (top["format"] !== WORLD_FORMAT) {
    throw new SimError(
      `loadWorld: expected format "${WORLD_FORMAT}", got "${String(top["format"])}"`,
    );
  }

  // Check version field.
  if (top["version"] !== SUPPORTED_VERSION) {
    throw new SimError(
      `loadWorld: unsupported version ${String(top["version"])}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const w = top["world"];
  if (typeof w !== "object" || w === null) {
    throw new SimError(
      `loadWorld: "world" field must be an object; got ${typeof w}`,
    );
  }

  const worldObj = w as Record<string, unknown>;

  const homeNodeId = worldObj["homeNodeId"];
  if (typeof homeNodeId !== "string") {
    throw new SimError(
      `loadWorld: "world.homeNodeId" must be a string; got ${typeof homeNodeId}`,
    );
  }

  const nodes = worldObj["nodes"];
  if (!Array.isArray(nodes)) {
    throw new SimError(
      `loadWorld: "world.nodes" must be an array; got ${typeof nodes}`,
    );
  }

  const channels = worldObj["channels"];
  if (!Array.isArray(channels)) {
    throw new SimError(
      `loadWorld: "world.channels" must be an array; got ${typeof channels}`,
    );
  }

  const contacts = worldObj["contacts"];
  if (!Array.isArray(contacts)) {
    throw new SimError(
      `loadWorld: "world.contacts" must be an array; got ${typeof contacts}`,
    );
  }

  // A serialized world always contains its home node. If the fixture is missing
  // it (truncated/hand-edited/corrupt), reject rather than let defineWorld
  // silently *fabricate* a fresh default home node — loadWorld must faithfully
  // reconstruct what was frozen, not invent data.
  const hasHomeNode = nodes.some(
    (n) => typeof n === "object" && n !== null && (n as Record<string, unknown>)["id"] === homeNodeId,
  );
  if (!hasHomeNode) {
    throw new SimError(
      `loadWorld: corrupt fixture — homeNodeId "${homeNodeId}" is not among the serialized nodes`,
    );
  }

  // Re-validate through defineWorld, passing nodes as full SimNode objects so
  // defineWorld does not re-apply defaults (string nodes would get defaulted
  // over the loaded values). The builder accepts `SimNode | string` entries
  // and passes through objects unchanged.
  try {
    return defineWorld({
      homeNodeId,
      nodes: nodes as Parameters<typeof defineWorld>[0]["nodes"],
      channels: channels as Parameters<typeof defineWorld>[0]["channels"],
      contacts: contacts as Parameters<typeof defineWorld>[0]["contacts"],
    });
  } catch (cause) {
    throw new SimError(
      `loadWorld: world validation failed: ${String(cause)}`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Scenario serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link Scenario} to a pretty-printed, deterministic JSON string.
 *
 * `Uint8Array` fields (e.g. `TelemetryEvent.lppSensorData`) are encoded as
 * `{ "$uint8array": "<lowercase-hex>" }` objects so the output is valid JSON
 * and fully round-trippable.
 *
 * Envelope:
 * ```json
 * { "format": "meshcore-sim/scenario", "version": 1, "scenario": { … } }
 * ```
 */
export function serializeScenario(s: Scenario): string {
  const serializedEvents = s.events.map((se: ScheduledEvent) => ({
    at: se.at,
    event: encodeEvent(se.event),
  }));

  const envelope = {
    format: SCENARIO_FORMAT,
    version: SUPPORTED_VERSION,
    scenario: {
      events: serializedEvents,
    },
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse and validate a {@link Scenario} from a JSON string produced by
 * {@link serializeScenario}.
 *
 * `Uint8Array` fields are decoded from their hex sentinel objects. The events
 * are re-validated and sorted through {@link scenario} — the single validated
 * constructor — so the returned scenario is exactly the same kind of validated,
 * sorted object as any other.
 *
 * @throws {SimError} If the input is not valid JSON, uses the wrong `format`,
 *   an unsupported `version`, or fails `scenario()` validation.
 */
export function loadScenario(json: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new SimError(
      `loadScenario: input is not valid JSON: ${String(cause)}`,
      { cause },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new SimError(
      `loadScenario: expected a JSON object at the top level; got ${typeof parsed}`,
    );
  }

  const top = parsed as Record<string, unknown>;

  // Check format field.
  if (top["format"] !== SCENARIO_FORMAT) {
    throw new SimError(
      `loadScenario: expected format "${SCENARIO_FORMAT}", got "${String(top["format"])}"`,
    );
  }

  // Check version field.
  if (top["version"] !== SUPPORTED_VERSION) {
    throw new SimError(
      `loadScenario: unsupported version ${String(top["version"])}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const s = top["scenario"];
  if (typeof s !== "object" || s === null) {
    throw new SimError(
      `loadScenario: "scenario" field must be an object; got ${typeof s}`,
    );
  }

  const scenarioObj = s as Record<string, unknown>;
  const eventsRaw = scenarioObj["events"];
  if (!Array.isArray(eventsRaw)) {
    throw new SimError(
      `loadScenario: "scenario.events" must be an array; got ${typeof eventsRaw}`,
    );
  }

  // Reconstruct ScheduledEvent array, decoding Uint8Array fields.
  const scheduledEvents: ScheduledEvent[] = eventsRaw.map(
    (entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null) {
        throw new SimError(
          `loadScenario: events[${i}] must be an object; got ${typeof entry}`,
        );
      }
      const e = entry as Record<string, unknown>;
      const at = e["at"];
      if (typeof at !== "number" && typeof at !== "string") {
        throw new SimError(
          `loadScenario: events[${i}].at must be a number or string; got ${typeof at}`,
        );
      }
      const event = decodeEvent(e["event"]);
      return { at, event } as ScheduledEvent;
    },
  );

  // Re-validate and sort through scenario() — the single validated constructor.
  try {
    return scenario(scheduledEvents);
  } catch (cause) {
    throw new SimError(
      `loadScenario: scenario validation failed: ${String(cause)}`,
      { cause },
    );
  }
}
