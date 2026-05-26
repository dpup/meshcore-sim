import { describe, expect, it } from "vitest";
import { SeededRandom } from "../src/random.js";

describe("SeededRandom", () => {
  it("reproduces the same next() sequence for the same seed", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("next() stays in [0, 1)", () => {
    const r = new SeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int() is deterministic and respects inclusive bounds", () => {
    const a = new SeededRandom(99);
    const b = new SeededRandom(99);
    for (let i = 0; i < 1000; i++) {
      const v = a.int(3, 9);
      expect(v).toBe(b.int(3, 9));
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("int() can return both bounds and handles a single-value range", () => {
    const r = new SeededRandom(123);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      seen.add(r.int(0, 1));
    }
    expect(seen).toEqual(new Set([0, 1]));
    expect(r.int(5, 5)).toBe(5);
  });

  it("int() throws when min > max", () => {
    expect(() => new SeededRandom(1).int(5, 1)).toThrow(RangeError);
  });

  it("pick() returns an in-range element and throws on empty", () => {
    const items = ["a", "b", "c"] as const;
    const r = new SeededRandom(55);
    for (let i = 0; i < 100; i++) {
      expect(items).toContain(r.pick(items));
    }
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it("bool() honours probability extremes", () => {
    const r = new SeededRandom(3);
    for (let i = 0; i < 50; i++) {
      expect(r.bool(0)).toBe(false);
      expect(r.bool(1)).toBe(true);
    }
  });

  it("bytes() is deterministic, the right length, and in 0..255", () => {
    const a = new SeededRandom(2024);
    const b = new SeededRandom(2024);
    const bytesA = a.bytes(32);
    const bytesB = b.bytes(32);
    expect(bytesA).toEqual(bytesB);
    expect(bytesA).toHaveLength(32);
    for (const byte of bytesA) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});
