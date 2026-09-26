import { describe, expect, it } from "vitest";
import { sccMembers, stronglyConnectedComponents } from "./scc.js";

describe("@demlik/code-graph/scc", () => {
  it("numbers components leaves-first and groups a cycle into one", () => {
    const nodes = ["root", "a", "b", "leaf"];
    const adj = new Map([
      ["root", ["a"]],
      ["a", ["b", "leaf"]],
      ["b", ["a"]],
    ]);
    const sccOf = stronglyConnectedComponents(nodes, adj);
    const members = sccMembers(nodes, sccOf);
    const number = (node: string) => sccOf.get(node) ?? -1;
    expect(number("a")).toBe(number("b"));
    expect(number("leaf")).toBeLessThan(number("a"));
    expect(number("a")).toBeLessThan(number("root"));
    expect(members.get(number("a"))).toEqual(["a", "b"]);
  });
});
