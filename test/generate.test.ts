import { describe, expect, it } from "vitest";
import { generateWorld } from "../src/generate.js";
import { NodeRole } from "../src/world.js";

describe("generateWorld", () => {
  it("returns a world with the requested node count", () => {
    const world = generateWorld({ seed: 1, nodes: 20, repeaters: 3 });
    expect(world.nodes).toHaveLength(20);
  });

  it("first node is always the home companion (id='home')", () => {
    const world = generateWorld({ seed: 1, nodes: 5 });
    expect(world.homeNodeId).toBe("home");
    const home = world.nodes.find((n) => n.id === "home");
    expect(home).toBeDefined();
    expect(home?.role).toBe(NodeRole.Companion);
  });

  it("has exactly the requested number of repeaters", () => {
    const world = generateWorld({ seed: 1, nodes: 20, repeaters: 3 });
    const repeaters = world.nodes.filter((n) => n.role === NodeRole.Repeater);
    expect(repeaters).toHaveLength(3);
    // home node is a companion, not a repeater
    const home = world.nodes.find((n) => n.id === "home");
    expect(home?.role).toBe(NodeRole.Companion);
  });

  it("non-repeater remote nodes are companions", () => {
    const world = generateWorld({ seed: 42, nodes: 10, repeaters: 2 });
    const remotes = world.nodes.filter((n) => n.id !== "home");
    const companions = remotes.filter((n) => n.role === NodeRole.Companion);
    const repeaters = remotes.filter((n) => n.role === NodeRole.Repeater);
    expect(companions).toHaveLength(7); // 10 - 1 home - 2 repeaters
    expect(repeaters).toHaveLength(2);
  });

  it("all node ids are unique", () => {
    const world = generateWorld({ seed: 7, nodes: 20, repeaters: 3 });
    const ids = world.nodes.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("contacts reference real nodes (all remote nodes are contacts)", () => {
    const world = generateWorld({ seed: 5, nodes: 10, repeaters: 2 });
    const nodeIds = new Set(world.nodes.map((n) => n.id));
    expect(world.contacts).toHaveLength(9); // 10 - 1 home
    for (const c of world.contacts) {
      expect(nodeIds.has(c.nodeId)).toBe(true);
      expect(c.nodeId).not.toBe("home");
    }
  });

  it("same seed produces a deep-equal world (determinism)", () => {
    const a = generateWorld({ seed: 42, nodes: 20, repeaters: 3 });
    const b = generateWorld({ seed: 42, nodes: 20, repeaters: 3 });
    expect(a).toEqual(b);
  });

  it("different seed produces a different world", () => {
    const a = generateWorld({ seed: 1, nodes: 10 });
    const b = generateWorld({ seed: 2, nodes: 10 });
    // Node ids or batteries will differ
    expect(a).not.toEqual(b);
  });

  it("respects explicit channel count: 1 channel", () => {
    const world = generateWorld({ seed: 1, nodes: 5, channels: 1 });
    expect(world.channels).toHaveLength(1);
    expect(world.channels[0]?.name).toBe("public");
  });

  it("respects explicit channel count: 3 channels", () => {
    const world = generateWorld({ seed: 1, nodes: 5, channels: 3 });
    expect(world.channels).toHaveLength(3);
  });

  it("default channel count is 2 for worlds with remote nodes", () => {
    const world = generateWorld({ seed: 1, nodes: 5 });
    expect(world.channels).toHaveLength(2);
    expect(world.channels[0]?.name).toBe("public");
    expect(world.channels[1]?.name).toBe("ops");
  });

  it("all nodes are reachable by default", () => {
    const world = generateWorld({ seed: 3, nodes: 5 });
    for (const n of world.nodes) {
      expect(n.reachable).toBe(true);
    }
  });

  it("battery values are in [20, 100] for remote nodes", () => {
    const world = generateWorld({ seed: 9, nodes: 20 });
    const remotes = world.nodes.filter((n) => n.id !== "home");
    for (const n of remotes) {
      expect(n.battery).toBeGreaterThanOrEqual(20);
      expect(n.battery).toBeLessThanOrEqual(100);
    }
  });

  it("passes through defineWorld — is a valid world (no SimError thrown)", () => {
    // If defineWorld validation throws, the test will fail with that error.
    // This implicitly tests the 'one fixture object model' invariant.
    expect(() => generateWorld({ seed: 100, nodes: 20, repeaters: 3 })).not.toThrow();
  });

  it("repeaters=0 produces no repeaters", () => {
    const world = generateWorld({ seed: 1, nodes: 10, repeaters: 0 });
    const repeaters = world.nodes.filter((n) => n.role === NodeRole.Repeater);
    expect(repeaters).toHaveLength(0);
  });

  it("clamped repeaters: more repeaters than remotes is clamped", () => {
    const world = generateWorld({ seed: 1, nodes: 5, repeaters: 100 });
    const repeaters = world.nodes.filter((n) => n.role === NodeRole.Repeater);
    // Only 4 remote nodes, so max is 4
    expect(repeaters.length).toBeLessThanOrEqual(4);
  });

  it("nodes=1 produces just the home node with no contacts", () => {
    const world = generateWorld({ seed: 1, nodes: 1 });
    expect(world.nodes).toHaveLength(1);
    expect(world.nodes[0]?.id).toBe("home");
    expect(world.contacts).toHaveLength(0);
  });

  it("throws RangeError for nodes < 1", () => {
    expect(() => generateWorld({ seed: 1, nodes: 0 })).toThrow(RangeError);
  });
});
