/**
 * Drift guard: assert the slice of `@liamcottle/meshcore.js` that `SimConnection`
 * targets still matches the *installed* library. The simulator hand-conforms to
 * the raw `Connection` contract and reads numeric constants straight from
 * `Constants`; the moment the dependency is bumped, any divergence (a renamed
 * constant, a removed method the client calls, a method we forgot to implement)
 * fails here instead of silently shipping a sim that no longer fronts the client.
 *
 * This is the mirror image of meshcore-ts's own `test/drift.test.ts`: that one
 * guards the *consumer* side (the wrapper still delegates to real methods); this
 * one guards the *producer* side (the sim still implements what the wrapper
 * calls, and the constants it emits still exist).
 *
 * It can only check runtime *values and method presence* — the erased `Raw*`
 * type shapes in meshcore-ts's `meshcore.d.ts` must be reconciled by hand from
 * the upstream diff when this (or meshcore-ts's drift guard) flags a release.
 */
import { Connection, Constants } from "@liamcottle/meshcore.js";
import { describe, expect, it } from "vitest";

import { defineWorld } from "../src/builders.js";
import { SimClock } from "../src/clock.js";
import { SimConnection } from "../src/connection.js";

describe("constants the simulator emits/reads still exist upstream", () => {
  // Every Constants.<group>.<key> referenced in src/ (connection.ts, encode.ts).
  // Keep this in sync with `grep -rhoE 'Constants\.[A-Za-z]+\.[A-Za-z]+' src/`.
  const USED: Record<string, string[]> = {
    PushCodes: ["Advert", "LogRxData", "MsgWaiting", "PathUpdated", "SendConfirmed", "TelemetryResponse"],
    StatsTypes: ["Core", "Radio", "Packets"],
    ResponseCodes: ["Ok"],
    AdvType: ["Chat", "Repeater", "Room"],
    DataTypes: ["Dev"],
  };

  for (const [group, keys] of Object.entries(USED)) {
    it(`Constants.${group} defines ${keys.join(", ")}`, () => {
      const table = (Constants as unknown as Record<string, Record<string, number> | undefined>)[
        group
      ];
      if (table === undefined) {
        throw new Error(`Constants.${group} is missing upstream`);
      }
      const missing = keys.filter((k) => typeof table[k] !== "number");
      expect(
        missing,
        `Constants.${group} no longer defines ${JSON.stringify(missing)} — upstream renamed/removed them; reconcile src/encode.ts & src/connection.ts.`,
      ).toEqual([]);
    });
  }
});

// The high-level methods MeshCoreClient invokes on its raw connection (the
// `this.raw.<method>(...)` calls in meshcore-ts's client.ts). SimConnection must
// implement all of these to stay a drop-in, and they must still exist upstream.
const CLIENT_METHODS = [
  "getSelfInfo",
  "getContacts",
  "findContactByName",
  "findContactByPublicKeyPrefix",
  "sendTextMessage",
  "sendChannelTextMessage",
  "syncNextMessage",
  "getWaitingMessages",
  "getDeviceTime",
  "setDeviceTime",
  "getBatteryVoltage",
  "deviceQuery",
  "reboot",
  "exportPrivateKey",
  "importPrivateKey",
  "sendAdvert",
  "sendFloodAdvert",
  "sendZeroHopAdvert",
  "setAdvertName",
  "setAdvertLatLong",
  "setTxPower",
  "setRadioParams",
  "importContact",
  "exportContact",
  "shareContact",
  "removeContact",
  "addOrUpdateContact",
  "resetPath",
  "setAutoAddContacts",
  "setManualAddContacts",
  "getChannel",
  "getChannels",
  "setChannel",
  "deleteChannel",
  "findChannelByName",
  "findChannelBySecret",
  "login",
  "getStatus",
  "getTelemetry",
  "sendBinaryRequest",
  "getNeighbours",
  "getStats",
  "getStatsCore",
  "getStatsRadio",
  "getStatsPackets",
  "sign",
  "tracePath",
] as const;

describe("the Connection methods MeshCoreClient calls still exist upstream", () => {
  const proto = Connection.prototype as unknown as Record<string, unknown>;

  it("all client-called methods are present on Connection.prototype", () => {
    const missing = CLIENT_METHODS.filter((name) => typeof proto[name] !== "function");
    expect(
      missing,
      `Connection no longer defines: ${JSON.stringify(missing)} — upstream renamed/removed them.`,
    ).toEqual([]);
  });
});

describe("SimConnection implements the full surface MeshCoreClient drives", () => {
  const sim = new SimConnection({
    world: defineWorld({ homeNodeId: "home" }),
    clock: new SimClock(),
  });

  // Everything the client calls, plus the lifecycle methods it invokes directly
  // (connect/close live on the transport subclasses upstream, not the base
  // Connection, so they are checked here rather than against Connection.prototype).
  const REQUIRED = [...CLIENT_METHODS, "connect", "close"] as const;

  it("a SimConnection instance implements every required method", () => {
    const missing = REQUIRED.filter(
      (name) => typeof (sim as unknown as Record<string, unknown>)[name] !== "function",
    );
    expect(
      missing,
      `SimConnection is missing: ${JSON.stringify(missing)} — it is no longer a complete drop-in for MeshCoreClient.`,
    ).toEqual([]);
  });

  it("asConnection() returns the instance typed as a Connection", () => {
    expect(sim.asConnection()).toBe(sim);
  });
});
