import { describe, expect, it } from "vitest";
import type { FunctionNode } from "../schema.js";
import { ThresholdsSchema } from "../schema.js";
import { smellsForFunction } from "./evaluate.js";
import { RULES, smellKinds } from "./rules.js";

const thresholds = ThresholdsSchema.parse({});

function fn(overrides: Partial<FunctionNode>): FunctionNode {
  return {
    id: "f.ts:f",
    name: "f",
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
    ...overrides,
  };
}

function kindsOf(node: FunctionNode): string[] {
  return smellsForFunction(node, thresholds).map((s) => s.kind);
}

describe("RULES — boundary is strict > (not >=)", () => {
  it("long-function fires only ABOVE the threshold, not at it", () => {
    expect(kindsOf(fn({ loc: 60 }))).not.toContain("long-function");
    expect(kindsOf(fn({ loc: 61 }))).toContain("long-function");
  });

  it("deep-nesting fires only above 4", () => {
    expect(kindsOf(fn({ nestingDepth: 4 }))).not.toContain("deep-nesting");
    expect(kindsOf(fn({ nestingDepth: 5 }))).toContain("deep-nesting");
  });

  it("high-complexity fires only above 10", () => {
    expect(kindsOf(fn({ complexity: 10 }))).not.toContain("high-complexity");
    expect(kindsOf(fn({ complexity: 11 }))).toContain("high-complexity");
  });

  it("high-fan-in fires only above 10 callers", () => {
    const edges = (n: number) => ({
      calls: [],
      calledBy: Array.from({ length: n }, (_, i) => ({ callerId: `f.ts:c${i}`, line: i + 1 })),
      callChainDepth: 0,
    });
    expect(kindsOf(fn({ edges: edges(10) }))).not.toContain("high-fan-in");
    expect(kindsOf(fn({ edges: edges(11) }))).toContain("high-fan-in");
  });

  it("deep-call-chain fires only above 5", () => {
    expect(kindsOf(fn({ edges: { calls: [], calledBy: [], callChainDepth: 5 } }))).not.toContain(
      "deep-call-chain",
    );
    expect(kindsOf(fn({ edges: { calls: [], calledBy: [], callChainDepth: 6 } }))).toContain(
      "deep-call-chain",
    );
  });

  it("edge smells emit NOTHING when edges is null (cheap pass — no data, no claim)", () => {
    const kinds = kindsOf(fn({ edges: null }));
    expect(kinds).not.toContain("high-fan-in");
    expect(kinds).not.toContain("deep-call-chain");
  });
});

describe("dense-undocumented — reuses highComplexity", () => {
  it("fires when complex AND zero comments", () => {
    expect(kindsOf(fn({ complexity: 11, commentLines: 0 }))).toContain("dense-undocumented");
  });

  it("does not fire when documented", () => {
    expect(kindsOf(fn({ complexity: 11, commentLines: 1 }))).not.toContain("dense-undocumented");
  });

  it("does not fire when complexity is at or below highComplexity", () => {
    expect(kindsOf(fn({ complexity: 10, commentLines: 0 }))).not.toContain("dense-undocumented");
  });
});

describe("severity ladder", () => {
  it("severity is high when value >= 2 * threshold, else warn", () => {
    const warn = smellsForFunction(fn({ loc: 119 }), thresholds).find(
      (s) => s.kind === "long-function",
    );
    const high = smellsForFunction(fn({ loc: 120 }), thresholds).find(
      (s) => s.kind === "long-function",
    );
    expect(warn?.severity).toBe("warn");
    expect(high?.severity).toBe("high");
  });
});

describe("smellKinds() — one cast, all keys", () => {
  it("returns every RULES key", () => {
    expect(smellKinds().sort()).toEqual(Object.keys(RULES).sort());
  });
});
