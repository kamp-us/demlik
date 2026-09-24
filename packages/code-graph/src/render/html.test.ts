import { describe, expect, it } from "vitest";
import type {
  Edges,
  FunctionNode,
  Graph,
  ModuleNode,
  Smell,
  Summary,
  Thresholds,
} from "../schema.js";
import { ThresholdsSchema } from "../schema.js";
import { rankPlan } from "../smells/plan.js";
import { buildHtmlModel, type HtmlModel, renderHtml, type TreemapNode } from "./html.js";

const thresholds: Thresholds = ThresholdsSchema.parse({});

const smell = (over: Partial<Smell> & Pick<Smell, "kind" | "severity">): Smell => ({
  target: { type: "function", id: "x", file: "f.ts", startLine: 1 },
  value: 2,
  threshold: 1,
  ...over,
});

const edges = (over: Partial<Edges> = {}): Edges => ({
  calls: [],
  calledBy: [],
  callChainDepth: 0,
  ...over,
});

const fn = (over: Partial<FunctionNode> & Pick<FunctionNode, "id" | "file">): FunctionNode => ({
  name: over.id,
  kind: "function",
  startLine: 1,
  endLine: 10,
  loc: 10,
  commentLines: 0,
  nestingDepth: 1,
  complexity: 1,
  isExported: true,
  isTest: false,
  edges: edges(),
  nodeKind: null,
  smells: [],
  ...over,
});

const module = (over: Partial<ModuleNode> & Pick<ModuleNode, "file">): ModuleNode => ({
  loc: 50,
  commentLines: 0,
  functionIds: [],
  imports: [],
  importedBy: [],
  importEdges: [],
  isTest: false,
  smells: [],
  ...over,
});

const emptySummary = (over: Partial<Summary> = {}): Summary => ({
  health: "rough",
  fileCount: 0,
  functionCount: 0,
  smellCount: 0,
  highSeverityCount: 0,
  worstFile: null,
  worstFunction: null,
  topTargets: [],
  parseFailures: [],
  ...over,
});

function graphOf(parts: {
  root?: string;
  functions: FunctionNode[];
  modules: ModuleNode[];
  summary?: Partial<Summary>;
}): Graph {
  const smells = [
    ...parts.modules.flatMap((m) => m.smells),
    ...parts.functions.flatMap((f) => f.smells),
  ];
  return {
    root: parts.root ?? "pkg",
    provenance: { pass: "edges", tsConfig: "tsconfig.json", scope: "package" },
    crossRuntime: null,
    reachability: null,
    clusters: null,
    interfaceWidth: null,
    thresholds,
    summary: emptySummary(parts.summary),
    functions: parts.functions,
    modules: parts.modules,
    directories: [],
    smells,
    stats: {
      fileCount: parts.modules.length,
      functionCount: parts.functions.length,
      totalLoc: 0,
      totalCommentLines: 0,
      smellCount: smells.length,
      parseFailures: [],
    },
  };
}

function findLeaf(node: TreemapNode, file: string): TreemapNode | null {
  if (node.file === file) return node;
  for (const child of node.children ?? []) {
    const hit = findLeaf(child, file);
    if (hit) return hit;
  }
  return null;
}

describe("buildHtmlModel — treemap hierarchy + severity", () => {
  const model: HtmlModel = buildHtmlModel(
    graphOf({
      root: "pkg",
      modules: [
        module({ file: "a/clean.ts", loc: 30 }),
        module({
          file: "a/rotten.ts",
          loc: 80,
          smells: [smell({ kind: "big-file", severity: "high" })],
        }),
        module({ file: "b/warnish.ts", loc: 40 }),
      ],
      functions: [
        fn({
          id: "b/warnish.ts:slow",
          file: "b/warnish.ts",
          smells: [smell({ kind: "long-function", severity: "warn" })],
        }),
      ],
    }),
  );

  it("nests dir → file, root named after graph.root", () => {
    expect(model.treemap.name).toBe("pkg");
    const dirs = (model.treemap.children ?? []).map((c) => c.name);
    expect(dirs).toEqual(["a", "b"]);
  });

  it("leaf box size = module.loc", () => {
    expect(findLeaf(model.treemap, "a/rotten.ts")?.loc).toBe(80);
  });

  it("colors a clean file green (none), a high-smell file red (high)", () => {
    expect(findLeaf(model.treemap, "a/clean.ts")?.severity).toBe("none");
    expect(findLeaf(model.treemap, "a/rotten.ts")?.severity).toBe("high");
  });

  it("derives file severity from its functions' smells, not just module smells", () => {
    expect(findLeaf(model.treemap, "b/warnish.ts")?.severity).toBe("warn");
  });

  it("tooltip smellKinds are sorted + deduped", () => {
    const leaf = findLeaf(model.treemap, "b/warnish.ts");
    expect(leaf?.smellKinds).toEqual(["long-function"]);
  });
});

describe("buildHtmlModel — node inclusion rule + hiddenCount (HTML-VIEW §3.2)", () => {
  const smelly = fn({
    id: "f.ts:smelly",
    file: "f.ts",
    smells: [smell({ kind: "high-complexity", severity: "high" })],
  });
  const hub = fn({
    id: "f.ts:hub",
    file: "f.ts",
    edges: edges({
      calledBy: [
        { callerId: "f.ts:caller", line: 1 },
        { callerId: "f.ts:c2", line: 2 },
        { callerId: "f.ts:c3", line: 3 },
      ],
    }),
  });
  const caller = fn({
    id: "f.ts:caller",
    file: "f.ts",
    edges: edges({ calls: [{ calleeId: "f.ts:hub", line: 5, constArgs: [], declaration: null }] }),
  });
  const plain = fn({ id: "f.ts:plain", file: "f.ts" });

  const model = buildHtmlModel(
    graphOf({ functions: [smelly, hub, caller, plain], modules: [module({ file: "f.ts" })] }),
  );

  it("includes targets (≥1 smell OR fanIn≥3)", () => {
    const ids = model.graph.nodes.map((n) => n.id);
    expect(ids).toContain("f.ts:smelly");
    expect(ids).toContain("f.ts:hub");
  });

  it("pulls in one-hop neighbors of targets, tagged hidden", () => {
    const neighbor = model.graph.nodes.find((n) => n.id === "f.ts:caller");
    expect(neighbor).toBeDefined();
    expect(neighbor?.hidden).toBe(true);
  });

  it("omits functions that are neither target nor neighbor, counts them in hiddenCount", () => {
    expect(model.graph.nodes.find((n) => n.id === "f.ts:plain")).toBeUndefined();
    expect(model.graph.hiddenCount).toBe(1);
  });

  it("emits caller→callee edges within the included set", () => {
    expect(model.graph.edges).toContainEqual({ source: "f.ts:caller", target: "f.ts:hub" });
  });

  it("scales node fanIn off calledBy.length", () => {
    expect(model.graph.nodes.find((n) => n.id === "f.ts:hub")?.fanIn).toBe(3);
  });

  it("nodes are sorted by id (deterministic)", () => {
    const ids = model.graph.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("buildHtmlModel — plan rows", () => {
  it("are the default rot ranking over the graph's functions", () => {
    const a = fn({ id: "f.ts:a", file: "f.ts", complexity: 1 });
    const b = fn({
      id: "f.ts:b",
      file: "f.ts",
      complexity: 5,
      smells: [smell({ kind: "high-complexity", severity: "warn" })],
    });
    const g = graphOf({ functions: [a, b], modules: [module({ file: "f.ts" })] });
    const model = buildHtmlModel(g);
    expect(model.plan).toEqual(rankPlan(g.functions, "rot"));
    expect(model.plan[0].id).toBe("f.ts:b");
  });
});

describe("renderHtml — self-contained page smoke test", () => {
  const html = renderHtml(
    graphOf({
      root: "audit-agents",
      summary: { health: "rotten", fileCount: 2, functionCount: 1, smellCount: 1 },
      modules: [
        module({ file: "a/x.ts", smells: [smell({ kind: "big-file", severity: "high" })] }),
      ],
      functions: [fn({ id: "a/x.ts:f", file: "a/x.ts" })],
    }),
  );

  it("is an HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("inlines the DATA blob", () => {
    expect(html).toContain("const DATA = {");
    expect(html).toContain('"treemap"');
    expect(html).toContain('"hiddenCount"');
  });

  it("loads d3 + cytoscape + fcose from CDN", () => {
    expect(html).toContain("d3");
    expect(html).toMatch(/cytoscape@/);
    expect(html).toContain("cytoscape-fcose");
  });

  it("has the three sections", () => {
    expect(html).toContain("Hotspot treemap");
    expect(html).toContain("Hub call graph");
    expect(html).toContain("Top targets");
  });

  it("shows the health band in the header", () => {
    expect(html).toContain("rotten");
  });
});
