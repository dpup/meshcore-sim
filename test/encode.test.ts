import { describe, expect, it } from "vitest";
import { Constants } from "@liamcottle/meshcore.js";
import { fromHex, toHex } from "@dpup/meshcore-ts";

import { node } from "../src/builders.js";
import {
  advTypeOf,
  batteryMilliVoltsOf,
  channelDataOf,
  channelMessageOf,
  contactMessageOf,
  contactOf,
  DEVICE_EPOCH_BASE_SECS,
  epochSecsOf,
  logRxDataOf,
  microDegrees,
  selfInfoOf,
  textToBytes,
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

describe("dynamic-event encoders", () => {
  it("contactMessageOf keys by the sender's 6-byte prefix with a Plain default", () => {
    const n = node("rocky", { role: "repeater" });
    const raw = contactMessageOf(n, "hello", 1_000);
    expect(raw.text).toBe("hello");
    expect(raw.txtType).toBe(Constants.TxtTypes.Plain);
    expect(raw.pubKeyPrefix).toEqual(fromHex(n.publicKey).subarray(0, 6));
    expect(raw.senderTimestamp).toBe(DEVICE_EPOCH_BASE_SECS + 1);
  });

  it("channelMessageOf (verified) carries the channelIdx and decoded text", () => {
    const raw = channelMessageOf(1, "status: green", 2_000);
    expect(raw.channelIdx).toBe(1);
    expect(raw.text).toBe("status: green");
    expect(raw.senderTimestamp).toBe(DEVICE_EPOCH_BASE_SECS + 2);
  });

  it("channelDataOf (unverified) carries raw bytes + snr and NO decoded text", () => {
    const bytes = textToBytes("reboot now");
    const raw = channelDataOf(7, bytes, 9);
    expect(raw.channelIdx).toBe(7);
    expect(raw.snr).toBe(9);
    expect(raw.data).toEqual(bytes);
    expect(raw.dataLen).toBe(bytes.length);
    expect("text" in raw).toBe(false);
  });

  it("logRxDataOf carries signal metadata, defaulting to zero", () => {
    expect(logRxDataOf(new Uint8Array(0))).toEqual({
      lastSnr: 0,
      lastRssi: 0,
      raw: new Uint8Array(0),
    });
    expect(logRxDataOf(new Uint8Array([1]), 5, -90)).toEqual({
      lastSnr: 5,
      lastRssi: -90,
      raw: new Uint8Array([1]),
    });
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
