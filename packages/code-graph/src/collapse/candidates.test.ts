import { describe, expect, it } from "vitest";
import type { FunctionNode } from "../schema.js";
import { findCollapseCandidates } from "./candidates.js";
import { collapseCost } from "./cost.js";
import { CollapseSettingsSchema } from "./settings.js";
import { nameTokens } from "./tokens.js";

const SETTINGS = CollapseSettingsSchema.parse({});

function fn(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id,
    kind: "function",
    file: "f.ts",
    startLine: 1,
    endLine: 20,
    loc: 20,
    commentLines: 0,
    nestingDepth: 2,
    complexity: 4,
    isExported: true,
    isTest: false,
    edges: { calls: [], calledBy: [], callChainDepth: 0 },
    nodeKind: null,
    smells: [],
    ...over,
  };
}

const calls = (...ids: string[]) =>
  ids.map((calleeId, i) => ({ calleeId, line: i + 1, constArgs: [] }));
const calledBy = (...ids: string[]) => ids.map((callerId, i) => ({ callerId, line: i + 1 }));

describe("nameTokens", () => {
  it("stems and drops the how-words so the WHAT survives", () => {
    expect(nameTokens("getUserMembership")).toEqual(["membership", "user"]);
    expect(nameTokens("fetchMembership")).toEqual(["fetch", "membership"]);
    expect(nameTokens("toCanonicalImpact")).toEqual(["canonical", "impact"]);
    expect(nameTokens("normalizeImpacts")).toEqual(["impact", "normal"]);
  });
});

describe("findCollapseCandidates", () => {
  it("emits a pair only when minSignals of the four fire", () => {
    const twoSignals = [
      fn({
        id: "a.ts:normalizeImpact",
        name: "normalizeImpact",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
      fn({
        id: "b.ts:toCanonicalImpact",
        name: "toCanonicalImpact",
        file: "b.ts",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
    ];
    expect(findCollapseCandidates(twoSignals, [""], SETTINGS).candidates).toHaveLength(1);

    const oneSignal = [
      fn({ id: "a.ts:alpha", name: "alpha" }),
      fn({ id: "b.ts:beta", name: "beta", file: "b.ts" }),
    ];
    expect(findCollapseCandidates(oneSignal, [""], SETTINGS).candidates).toEqual([]);
  });

  it("ranks the cheaper collapse first at equal confidence", () => {
    const shared = { edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 } };
    const cheap = [
      fn({ id: "a.ts:normalizeImpact", name: "normalizeImpact", ...shared }),
      fn({ id: "a.ts:canonicalImpact", name: "canonicalImpact", ...shared }),
    ];
    const expensive = [
      fn({
        id: "packages/one/normalizeImpact",
        name: "normalizeImpact",
        file: "packages/one/x.ts",
        edges: {
          calls: calls("x", "y"),
          calledBy: calledBy("c1", "c2", "c3", "c4"),
          callChainDepth: 0,
        },
      }),
      fn({
        id: "packages/two/canonicalImpact",
        name: "canonicalImpact",
        file: "packages/two/x.ts",
        edges: {
          calls: calls("x", "y"),
          calledBy: calledBy("c5", "c6", "c7", "c8"),
          callChainDepth: 0,
        },
      }),
    ];
    const cheapRank = findCollapseCandidates(cheap, [""], SETTINGS).candidates[0];
    const expensiveRank = findCollapseCandidates(
      expensive,
      ["", "packages/one", "packages/two"],
      SETTINGS,
    ).candidates[0];
    expect(cheapRank).toBeDefined();
    expect(expensiveRank).toBeDefined();
    expect(expensiveRank?.costInputs.crossesPackage).toBe(true);
    expect((cheapRank?.rank ?? 0) > (expensiveRank?.rank ?? 0)).toBe(true);
  });

  it("is deterministic — same input, same bytes", () => {
    const nodes = [
      fn({
        id: "a.ts:normalizeImpact",
        name: "normalizeImpact",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
      fn({
        id: "b.ts:canonicalImpact",
        name: "canonicalImpact",
        file: "b.ts",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
      fn({
        id: "c.ts:canonicalImpactRow",
        name: "canonicalImpactRow",
        file: "c.ts",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
    ];
    const first = JSON.stringify(findCollapseCandidates(nodes, [""], SETTINGS));
    const second = JSON.stringify(findCollapseCandidates(nodes, [""], SETTINGS));
    expect(first).toBe(second);
  });

  it("never pairs a branchless function — a data literal has no logic to collapse", () => {
    const nodes = [
      fn({
        id: "a.ts:inputFields",
        name: "inputFields",
        complexity: 1,
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
      fn({
        id: "b.ts:inputFields",
        name: "inputFields",
        file: "b.ts",
        complexity: 1,
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
    ];
    expect(findCollapseCandidates(nodes, [""], SETTINGS).candidates).toEqual([]);
    expect(
      findCollapseCandidates(nodes, [""], CollapseSettingsSchema.parse({ minComplexity: 1 }))
        .candidates,
    ).toHaveLength(1);
  });

  it("groups a clique into ONE finding but never chains a~b~c into one blob", () => {
    const twin = (id: string, file: string) =>
      fn({
        id,
        name: "canonicalImpact",
        file,
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      });
    const clique = findCollapseCandidates(
      [
        twin("a.ts:canonicalImpact", "a.ts"),
        twin("b.ts:canonicalImpact", "b.ts"),
        twin("c.ts:canonicalImpact", "c.ts"),
      ],
      [""],
      SETTINGS,
    );
    expect(clique.clusters).toHaveLength(1);
    expect(clique.clusters[0]?.members).toHaveLength(3);
    expect(clique.candidates).toHaveLength(3);

    const chain = findCollapseCandidates(
      [
        fn({
          id: "a.ts:impactBudget",
          name: "impactBudget",
          edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
        }),
        fn({
          id: "b.ts:impactSeverity",
          name: "impactSeverity",
          file: "b.ts",
          edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
        }),
        fn({
          id: "c.ts:severityBand",
          name: "severityBand",
          file: "c.ts",
          edges: { calls: calls("p", "q"), calledBy: [], callChainDepth: 0 },
        }),
      ],
      [""],
      SETTINGS,
    );
    expect(chain.candidates.map((c) => [c.aId, c.bId])).toEqual([
      ["a.ts:impactBudget", "b.ts:impactSeverity"],
      ["b.ts:impactSeverity", "c.ts:severityBand"],
    ]);
    expect(chain.clusters.every((c) => c.members.length === 2)).toBe(true);
  });

  it("never pairs a test function", () => {
    const nodes = [
      fn({
        id: "a.test.ts:normalizeImpact",
        name: "normalizeImpact",
        isTest: true,
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
      fn({
        id: "b.ts:canonicalImpact",
        name: "canonicalImpact",
        file: "b.ts",
        edges: { calls: calls("x", "y"), calledBy: [], callChainDepth: 0 },
      }),
    ];
    expect(findCollapseCandidates(nodes, [""], SETTINGS).candidates).toEqual([]);
  });
});

describe("CollapseSettingsSchema", () => {
  it("refuses minSignals 1 — the blocking is only exhaustive at 2 or more", () => {
    expect(CollapseSettingsSchema.partial().safeParse({ minSignals: 1 }).success).toBe(false);
    expect(CollapseSettingsSchema.partial().safeParse({ minSignals: 3 }).success).toBe(true);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(CollapseSettingsSchema.partial().safeParse({ minSignal: 2 }).success).toBe(false);
  });
});

describe("collapseCost", () => {
  it("is at least 1, so the ratio is always defined", () => {
    const free = { callerUnion: 0, packagesSpanned: 1, crossesPackage: false, effectOnPath: false };
    expect(collapseCost(free, SETTINGS)).toBe(1);
  });

  it("charges for callers, packages, the package crossing, and an effect path", () => {
    const base = { callerUnion: 0, packagesSpanned: 1, crossesPackage: false, effectOnPath: false };
    expect(collapseCost({ ...base, effectOnPath: true }, SETTINGS)).toBeGreaterThan(1);
    expect(collapseCost({ ...base, crossesPackage: true }, SETTINGS)).toBeGreaterThan(
      collapseCost({ ...base, effectOnPath: true }, SETTINGS),
    );
    expect(collapseCost({ ...base, callerUnion: 7 }, SETTINGS)).toBe(4);
  });
});
