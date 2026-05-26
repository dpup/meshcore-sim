import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package smoke test", () => {
  it("exports a version string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
