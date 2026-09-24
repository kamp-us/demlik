import { describe, expect, it } from "vitest";
import type { FunctionNode, Graph, ModuleNode } from "../schema.js";
import type { ChurnData } from "./churn.js";
import { computeHotspots } from "./render.js";

function fn(file: string, id: string, complexity: number): FunctionNode {
  return {
    id,
    name: id,
    kind: "function",
    file,
    startLine: 1,
    endLine: 2,
    loc: 2,
    commentLines: 0,
    nestingDepth: 0,
    complexity,
    isExported: true,
    isTest: false,
    edges: null,
    nodeKind: null,
    smells: [],
  };
}

function mod(file: string): ModuleNode {
  return {
    file,
    loc: 10,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: [],
    isTest: false,
    smells: [],
  };
}

function graphOf(functions: FunctionNode[], modules: ModuleNode[]): Graph {
  return {
    root: "/root",
    provenance: { pass: "cheap" },
    thresholds: {
      longFunctionLoc: 60,
      deepNesting: 4,
      highComplexity: 10,
      bigFileLoc: 400,
      highFanIn: 10,
      deepCallChain: 5,
      directorySprawl: 10,
      dependencyCycle: 1,
      crossBoundaryImports: 0,
    },
    summary: {
      health: "healthy",
      fileCount: modules.length,
      functionCount: functions.length,
      smellCount: 0,
      highSeverityCount: 0,
      worstFile: null,
      worstFunction: null,
      topTargets: [],
      parseFailures: [],
    },
    crossRuntime: null,
    reachability: null,
    clusters: null,
    interfaceWidth: null,
    functions,
    modules,
    directories: [],
    smells: [],
    stats: {
      fileCount: modules.length,
      functionCount: functions.length,
      totalLoc: 0,
      totalCommentLines: 0,
      smellCount: 0,
      parseFailures: [],
    },
  };
}

function churnOf(commitsByFile: Record<string, number>, trackedFiles: string[]): ChurnData {
  return {
    repoRoot: "/repo",
    headSha: "deadbeef",
    commitsByFile: new Map(Object.entries(commitsByFile)),
    trackedFiles: new Set(trackedFiles),
  };
}

describe("computeHotspots", () => {
  it("aggregates complexity per file (sum of its functions) and multiplies by churn", () => {
    const graph = graphOf(
      [fn("a.ts", "a.ts:f1", 3), fn("a.ts", "a.ts:f2", 4), fn("b.ts", "b.ts:f1", 2)],
      [mod("a.ts"), mod("b.ts")],
    );
    const churn = churnOf({ "a.ts": 5, "b.ts": 10 }, ["a.ts", "b.ts"]);
    const rows = computeHotspots(graph, churn);
    const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
    expect(byFile["a.ts"]).toEqual({ file: "a.ts", churn: 5, complexity: 7, product: 35 });
    expect(byFile["b.ts"]).toEqual({ file: "b.ts", churn: 10, complexity: 2, product: 20 });
  });

  it("a file with no functions has complexity 0, still ranked (product can be 0)", () => {
    const graph = graphOf([], [mod("empty.ts")]);
    const churn = churnOf({ "empty.ts": 3 }, ["empty.ts"]);
    const rows = computeHotspots(graph, churn);
    expect(rows).toEqual([{ file: "empty.ts", churn: 3, complexity: 0, product: 0 }]);
  });

  it("an untracked file (churn null) gets product null, never a fabricated number", () => {
    const graph = graphOf([fn("new.ts", "new.ts:f1", 20)], [mod("new.ts")]);
    const churn = churnOf({}, []);
    const rows = computeHotspots(graph, churn);
    expect(rows).toEqual([{ file: "new.ts", churn: null, complexity: 20, product: null }]);
  });

  it("sorts by product descending, null-product rows last, `file` as the total-order tiebreak", () => {
    const graph = graphOf(
      [
        fn("low.ts", "low.ts:f", 1),
        fn("high.ts", "high.ts:f", 10),
        fn("mid.ts", "mid.ts:f", 5),
        fn("untracked.ts", "untracked.ts:f", 99),
      ],
      [mod("low.ts"), mod("high.ts"), mod("mid.ts"), mod("untracked.ts")],
    );
    const churn = churnOf({ "low.ts": 1, "high.ts": 10, "mid.ts": 2 }, [
      "low.ts",
      "high.ts",
      "mid.ts",
    ]);
    const rows = computeHotspots(graph, churn);
    expect(rows.map((r) => r.file)).toEqual(["high.ts", "mid.ts", "low.ts", "untracked.ts"]);
  });

  it("ties on product break on `file` ascending — a total order, not sort-stability luck", () => {
    const graph = graphOf(
      [fn("zeta.ts", "zeta.ts:f", 2), fn("alpha.ts", "alpha.ts:f", 4)],
      [mod("zeta.ts"), mod("alpha.ts")],
    );
    const churn = churnOf({ "zeta.ts": 2, "alpha.ts": 1 }, ["zeta.ts", "alpha.ts"]);
    const rows = computeHotspots(graph, churn);
    expect(rows.map((r) => [r.file, r.product])).toEqual([
      ["alpha.ts", 4],
      ["zeta.ts", 4],
    ]);
  });
});
