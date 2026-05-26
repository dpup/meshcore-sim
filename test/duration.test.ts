import { describe, expect, it } from "vitest";
import { toMillis } from "../src/duration.js";
import { SimError } from "../src/errors.js";

describe("toMillis", () => {
  it("passes a number of milliseconds through unchanged", () => {
    expect(toMillis(30000)).toBe(30000);
    expect(toMillis(0)).toBe(0);
  });

  it("parses unit-suffixed strings", () => {
    expect(toMillis("500ms")).toBe(500);
    expect(toMillis("30s")).toBe(30000);
    expect(toMillis("2m")).toBe(120000);
    expect(toMillis("1h")).toBe(3600000);
  });

  it("accepts fractional values and surrounding whitespace", () => {
    expect(toMillis("1.5s")).toBe(1500);
    expect(toMillis("  250ms  ")).toBe(250);
  });

  it("does not confuse the 'm' and 'ms' suffixes", () => {
    expect(toMillis("5m")).toBe(300000);
    expect(toMillis("5ms")).toBe(5);
  });

  it("throws on a negative number", () => {
    expect(() => toMillis(-1)).toThrow(SimError);
  });

  it("throws on non-finite numbers", () => {
    expect(() => toMillis(Number.NaN)).toThrow(SimError);
    expect(() => toMillis(Number.POSITIVE_INFINITY)).toThrow(SimError);
  });

  it("throws on an unknown unit", () => {
    expect(() => toMillis("30days")).toThrow(SimError);
    expect(() => toMillis("30")).toThrow(SimError);
  });

  it("throws on a missing or bad numeric part", () => {
    expect(() => toMillis("ms")).toThrow(SimError);
    expect(() => toMillis("abcs")).toThrow(SimError);
    expect(() => toMillis("-5s")).toThrow(SimError);
  });
});
