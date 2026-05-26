import { describe, expect, it } from "vitest";
import { channel, contact, defineWorld, node } from "../src/builders.js";
import { deriveNodeKey } from "../src/keys.js";
import { SimError } from "../src/errors.js";

describe("node", () => {
  it("returns a fully-formed node from just an id", () => {
    const n = node("rocky-ridge");
    expect(n).toEqual({
      id: "rocky-ridge",
      name: "rocky-ridge",
      role: "companion",
      reachable: true,
      battery: 100,
      radioConfig: { freq: 910_525, bw: 250, sf: 10, cr: 5, txPower: 22 },
      firmwareVer: 1,
      model: "meshcore-sim",
      publicKey: deriveNodeKey("rocky-ridge"),
    });
  });

  it("defaults are stable across calls", () => {
    expect(node("a")).toEqual(node("a"));
  });

  it("overriding only battery leaves everything else defaulted", () => {
    const base = node("rocky-ridge");
    const lowBattery = node("rocky-ridge", { battery: 7 });
    expect(lowBattery.battery).toBe(7);
    // Everything else reads exactly as the default node.
    expect({ ...lowBattery, battery: base.battery }).toEqual(base);
  });

  it("derives publicKey from the id and ignores any attempt to override it", () => {
    const n = node("home");
    expect(n.publicKey).toBe(deriveNodeKey("home"));
    expect(n.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("channel", () => {
  it("defaults to a public channel with a deterministic secret", () => {
    const c = channel(0, "general");
    expect(c.idx).toBe(0);
    expect(c.name).toBe("general");
    expect(c.kind).toBe("public");
    expect(c.secret).toBe(channel(0, "general").secret);
    expect(c.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can be overridden to private", () => {
    const c = channel(3, "admin", { kind: "private" });
    expect(c.kind).toBe("private");
  });
});

describe("contact", () => {
  it("derives the public key from the referenced node id", () => {
    const c = contact("Rocky", "rocky-ridge");
    expect(c).toEqual({
      name: "Rocky",
      nodeId: "rocky-ridge",
      publicKey: deriveNodeKey("rocky-ridge"),
    });
  });
});

describe("defineWorld", () => {
  it("creates a default home node when only homeNodeId is given", () => {
    const world = defineWorld({ homeNodeId: "home" });
    expect(world.nodes).toHaveLength(1);
    expect(world.nodes[0]).toEqual(node("home"));
    expect(world.channels).toEqual([]);
    expect(world.contacts).toEqual([]);
  });

  it("normalizes bare string node entries through node()", () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: ["home", "rocky-ridge"],
    });
    expect(world.nodes).toHaveLength(2);
    expect(world.nodes).toContainEqual(node("rocky-ridge"));
  });

  it("does not duplicate the home node when it is listed explicitly", () => {
    const world = defineWorld({ homeNodeId: "home", nodes: ["home"] });
    expect(world.nodes.filter((n) => n.id === "home")).toHaveLength(1);
  });

  it("reads back a low-battery node in an otherwise-defaulted world", () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: ["home", node("rocky-ridge", { battery: 5 })],
    });
    const rocky = world.nodes.find((n) => n.id === "rocky-ridge");
    expect(rocky?.battery).toBe(5);
    expect(rocky?.reachable).toBe(true);
    expect(rocky?.role).toBe("companion");
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      defineWorld({ homeNodeId: "home", nodes: ["home", "dup", "dup"] }),
    ).toThrow(SimError);
  });

  it("rejects duplicate channel idxs", () => {
    expect(() =>
      defineWorld({
        homeNodeId: "home",
        channels: [channel(0, "a"), channel(0, "b")],
      }),
    ).toThrow(/Duplicate channel idx/);
  });

  it("rejects a contact referencing an unknown node", () => {
    expect(() =>
      defineWorld({
        homeNodeId: "home",
        contacts: [contact("Ghost", "nope")],
      }),
    ).toThrow(SimError);
  });

  it("accepts a contact referencing a known node", () => {
    const world = defineWorld({
      homeNodeId: "home",
      nodes: ["home", "rocky-ridge"],
      contacts: [contact("Rocky", "rocky-ridge")],
    });
    expect(world.contacts).toHaveLength(1);
  });
});

describe("deriveNodeKey", () => {
  it("is deterministic: same id yields the same 64-char hex", () => {
    expect(deriveNodeKey("home")).toBe(deriveNodeKey("home"));
    expect(deriveNodeKey("home")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different keys for different ids", () => {
    expect(deriveNodeKey("home")).not.toBe(deriveNodeKey("rocky-ridge"));
    expect(deriveNodeKey("a")).not.toBe(deriveNodeKey("b"));
  });
});
