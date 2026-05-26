import { describe, expect, it } from "vitest";
import { Constants } from "@liamcottle/meshcore.js";
import { fromHex, toHex } from "@dpup/meshcore-ts";

import { node } from "../src/builders.js";
import {
  advTypeOf,
  batteryMilliVoltsOf,
  contactOf,
  DEVICE_EPOCH_BASE_SECS,
  epochSecsOf,
  microDegrees,
  selfInfoOf,
} from "../src/encode.js";
import { defineWorld } from "../src/builders.js";

describe("key encoding", () => {
  it("round-trips a node's hex public key through fromHex/toHex", () => {
    const n = node("rocky-ridge");
    const raw = contactOf(n, 0);
    expect(raw.publicKey).toBeInstanceOf(Uint8Array);
    expect(raw.publicKey.length).toBe(32);
    expect(toHex(raw.publicKey)).toBe(n.publicKey);
    expect(fromHex(n.publicKey)).toEqual(raw.publicKey);
  });
});

describe("advTypeOf", () => {
  it("maps roles to meshcore AdvType integers", () => {
    expect(advTypeOf("companion")).toBe(Constants.AdvType.Chat);
    expect(advTypeOf("repeater")).toBe(Constants.AdvType.Repeater);
    expect(advTypeOf("roomserver")).toBe(Constants.AdvType.Room);
  });
});

describe("microDegrees", () => {
  it("converts degrees to integer micro-degrees", () => {
    expect(microDegrees(37.7749)).toBe(37_774_900);
    expect(microDegrees(-122.4194)).toBe(-122_419_400);
  });

  it("defaults undefined to 0", () => {
    expect(microDegrees(undefined)).toBe(0);
  });
});

describe("batteryMilliVoltsOf", () => {
  it("maps 0/50/100 percent on the linear 3000..4200 mV model", () => {
    expect(batteryMilliVoltsOf(node("n", { battery: 0 }))).toBe(3000);
    expect(batteryMilliVoltsOf(node("n", { battery: 50 }))).toBe(3600);
    expect(batteryMilliVoltsOf(node("n", { battery: 100 }))).toBe(4200);
  });

  it("clamps out-of-range percentages", () => {
    expect(batteryMilliVoltsOf(node("n", { battery: 150 }))).toBe(4200);
    expect(batteryMilliVoltsOf(node("n", { battery: -10 }))).toBe(3000);
  });
});

describe("epochSecsOf", () => {
  it("anchors at the fixed device epoch and advances with clock ms", () => {
    expect(epochSecsOf(0)).toBe(DEVICE_EPOCH_BASE_SECS);
    expect(epochSecsOf(30_000)).toBe(DEVICE_EPOCH_BASE_SECS + 30);
    // Sub-second precision is floored.
    expect(epochSecsOf(1_500)).toBe(DEVICE_EPOCH_BASE_SECS + 1);
  });
});

describe("selfInfoOf", () => {
  it("encodes the home node's identity and radio config", () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: [node("home", { name: "Base", lat: 1.5, lon: -2.5 })],
    });
    const self = selfInfoOf(world);
    expect(self.name).toBe("Base");
    expect(self.type).toBe(Constants.AdvType.Chat);
    expect(toHex(self.publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(self.radioFreq).toBe(910_525);
    expect(self.radioSf).toBe(10);
    expect(self.advLat).toBe(1_500_000);
    expect(self.advLon).toBe(-2_500_000);
  });
});
