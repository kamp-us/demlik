import { describe, expect, it } from "vitest";
import type { CallerSite, FunctionNode } from "../schema.js";
import { rankPlan } from "./plan.js";

function fn(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id,
    kind: "function",
    file: "f.ts",
    startLine: 1,
    endLine: 1,
    loc: 0,
    commentLines: 0,
    nestingDepth: 0,
    complexity: 0,
    isExported: false,
    isTest: false,
    edges: { calls: [], calledBy: [], callChainDepth: 0 },
    nodeKind: null,
    smells: [],
    ...over,
  };
}

const callerSites = (n: number): CallerSite[] =>
  Array.from({ length: n }, (_, i) => ({ callerId: `f.ts:c${i}`, line: i + 1 }));
const withCallers = (n: number, callChainDepth = 0) => ({
  calls: [],
  calledBy: callerSites(n),
  callChainDepth,
});
const smells = (n: number) =>
  Array.from({ length: n }, () => ({
    kind: "long-function" as const,
    target: { type: "function" as const, id: "x", file: "f.ts", startLine: 1 },
    value: 1,
    threshold: 1,
    severity: "warn" as const,
  }));

describe("rankPlan — per-axis ordering (edges computed)", () => {
  const nodes = [
    fn({ id: "lowAll", complexity: 1, smells: [], edges: withCallers(0), loc: 5 }),
    fn({ id: "bigLoc", complexity: 2, smells: smells(1), edges: withCallers(1), loc: 100 }),
    fn({ id: "manyCx", complexity: 50, smells: smells(1), edges: withCallers(1), loc: 10 }),
    fn({ id: "manyFanIn", complexity: 2, smells: smells(1), edges: withCallers(40), loc: 10 }),
    fn({ id: "manySmells", complexity: 2, smells: smells(5), edges: withCallers(1), loc: 10 }),
  ];

  it("rot leads on smells.length", () => {
    expect(rankPlan(nodes, "rot")[0].id).toBe("manySmells");
  });

  it("impact leads on calledBy.length", () => {
    expect(rankPlan(nodes, "impact")[0].id).toBe("manyFanIn");
  });

  it("complexity leads on complexity", () => {
    expect(rankPlan(nodes, "complexity")[0].id).toBe("manyCx");
  });

  it("size leads on loc", () => {
    expect(rankPlan(nodes, "size")[0].id).toBe("bigLoc");
  });
});

describe("rankPlan — cheap pass marks fanIn UNKNOWN (not 0)", () => {
  const cheap = fn({ id: "hub", complexity: 0, smells: [], edges: null, loc: 10 });
  const computed = fn({ id: "hub", complexity: 0, smells: [], edges: withCallers(40), loc: 10 });

  it("fanIn / calledByCount are null in cheap mode (edges not computed)", () => {
    const [row] = rankPlan([cheap], "rot");
    expect(row.components.fanIn).toBeNull();
    expect(row.calledByCount).toBeNull();
  });

  it("fanIn is a real number when edges were computed", () => {
    const [row] = rankPlan([computed], "rot");
    expect(row.components.fanIn).toBe(40);
    expect(row.calledByCount).toBe(40);
  });

  it("rot score DROPS the unknown fanIn term in cheap mode, keeps it with edges", () => {
    expect(rankPlan([cheap], "rot")[0].score).toBe(0);
    expect(rankPlan([computed], "rot")[0].score).toBe(40);
  });
});

describe("rankPlan — total order (file, startLine, then id)", () => {
  it("breaks ties by file then startLine", () => {
    const tied = [
      fn({ id: "a", file: "b.ts", startLine: 5 }),
      fn({ id: "b", file: "a.ts", startLine: 9 }),
      fn({ id: "c", file: "a.ts", startLine: 2 }),
    ];
    expect(rankPlan(tied, "rot").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks a (file, startLine) tie by id — defined order, not sort luck", () => {
    const tied = [
      fn({ id: "f.ts:x#1", file: "f.ts", startLine: 7 }),
      fn({ id: "f.ts:x#0", file: "f.ts", startLine: 7 }),
    ];
    expect(rankPlan(tied, "rot").map((r) => r.id)).toEqual(["f.ts:x#0", "f.ts:x#1"]);
  });
});

describe("rankPlan — edge pass yields a populated block with a real leaf depth", () => {
  it("a genuine leaf has callChainDepth 0, unambiguous because edges ran", () => {
    const leaf = fn({ id: "leaf", edges: { calls: [], calledBy: [], callChainDepth: 0 } });
    const [row] = rankPlan([leaf], "rot");
    expect(row.calledByCount).toBe(0);
    expect(leaf.edges?.callChainDepth).toBe(0);
  });
});
