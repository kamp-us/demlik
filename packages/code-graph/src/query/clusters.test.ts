import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { NodeKindRulesSchema } from "../kinds/rules.js";
import { stableStringify } from "../render/json.js";
import { type FunctionNode, type ModuleNode, ThresholdsSchema } from "../schema.js";
import { buildClusterReport } from "./clusters.js";
import { type Edge, louvain } from "./louvain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "..");
const thresholds = ThresholdsSchema.parse({});

function fn(id: string, file: string, calls: string[]): FunctionNode {
  return {
    id,
    name: id.split(":")[1] ?? id,
    kind: "function",
    file,
    startLine: 1,
    endLine: 2,
    loc: 2,
    commentLines: 0,
    nestingDepth: 0,
    complexity: 1,
    isExported: true,
    isTest: false,
    edges: {
      calls: calls.map((calleeId) => ({ calleeId, line: 1, constArgs: [], declaration: null })),
      calledBy: [],
      callChainDepth: 0,
    },
    nodeKind: null,
    smells: [],
  };
}

function mod(file: string, isTest = false): ModuleNode {
  return {
    file,
    loc: 10,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: [],
    isTest,
    smells: [],
  };
}

describe("--clusters is deterministic", () => {
  it("serializes byte-identically when clustered twice on the same input", () => {
    const loaded = loadEdgeProject(SRC_DIR, "package", path.resolve(SRC_DIR, "..", "..", ".."));
    const options = {
      crossRuntime: true,
      kinds: false,
      reach: false,
      clusters: true,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse({}),
      repoRoot: path.resolve(SRC_DIR, "..", "..", ".."),
    };
    const first = assembleGraphWithEdges(
      loaded,
      thresholds,
      "package",
      loaded.tsConfigPath,
      options,
    );
    const second = assembleGraphWithEdges(
      loaded,
      thresholds,
      "package",
      loaded.tsConfigPath,
      options,
    );

    expect(first.clusters).not.toBeNull();
    expect(first.clusters?.clusterCount).toBeGreaterThan(0);
    expect(stableStringify(second.clusters, false)).toBe(stableStringify(first.clusters, false));
  });

  it("is invariant to the input node order the partition is derived from", () => {
    const edges: Edge[] = [
      { a: "a.ts", b: "b.ts", weight: 3 },
      { a: "b.ts", b: "c.ts", weight: 3 },
      { a: "a.ts", b: "c.ts", weight: 3 },
      { a: "c.ts", b: "d.ts", weight: 1 },
      { a: "d.ts", b: "e.ts", weight: 3 },
      { a: "e.ts", b: "f.ts", weight: 3 },
      { a: "d.ts", b: "f.ts", weight: 3 },
    ];
    const nodes = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    const forward = louvain(nodes, edges);
    const reversed = louvain([...nodes].reverse(), [...edges].reverse());

    const asObject = (m: ReadonlyMap<string, string>): Record<string, string> =>
      Object.fromEntries([...m].sort((x, y) => x[0].localeCompare(y[0])));
    expect(asObject(reversed.membership)).toEqual(asObject(forward.membership));
    expect(reversed.modularity).toBe(forward.modularity);
  });

  it("finds the two triangles a barbell is made of", () => {
    const edges: Edge[] = [
      { a: "a", b: "b", weight: 1 },
      { a: "b", b: "c", weight: 1 },
      { a: "a", b: "c", weight: 1 },
      { a: "c", b: "d", weight: 1 },
      { a: "d", b: "e", weight: 1 },
      { a: "e", b: "f", weight: 1 },
      { a: "d", b: "f", weight: 1 },
    ];
    const { membership, modularity } = louvain(["a", "b", "c", "d", "e", "f"], edges);
    expect(membership.get("a")).toBe(membership.get("b"));
    expect(membership.get("a")).toBe(membership.get("c"));
    expect(membership.get("d")).toBe(membership.get("e"));
    expect(membership.get("d")).toBe(membership.get("f"));
    expect(membership.get("a")).not.toBe(membership.get("d"));
    expect(modularity).toBeGreaterThan(0.2);
  });
});

describe("--clusters report shape", () => {
  it("holds edgeless files out of the partition instead of making them singletons", () => {
    const modules = ["d/a.ts", "d/b.ts", "d/c.ts"].map((f) => mod(f));
    const report = buildClusterReport([], modules);
    expect(report.isolatedFileCount).toBe(3);
    expect(report.clusterCount).toBe(0);
    expect(report.splitDirectories).toEqual([]);
  });

  it("names the files and the cluster they actually belong to, both ways round", () => {
    const files = [
      "left/one.ts",
      "left/two.ts",
      "right/three.ts",
      "right/four.ts",
      "right/five.ts",
      "left/six.ts",
    ];
    const functions = [
      fn("left/one.ts:a", "left/one.ts", ["left/two.ts:b", "right/three.ts:c"]),
      fn("left/two.ts:b", "left/two.ts", ["left/one.ts:a", "right/three.ts:c"]),
      fn("right/three.ts:c", "right/three.ts", ["left/one.ts:a", "left/two.ts:b"]),
      fn("right/four.ts:d", "right/four.ts", ["right/five.ts:e", "left/six.ts:f"]),
      fn("right/five.ts:e", "right/five.ts", ["right/four.ts:d", "left/six.ts:f"]),
      fn("left/six.ts:f", "left/six.ts", ["right/four.ts:d", "right/five.ts:e"]),
    ];
    const report = buildClusterReport(
      functions,
      files.map((f) => mod(f)),
    );

    expect(report.clusterCount).toBe(2);
    expect(report.splitDirectories.map((d) => d.dir)).toEqual(["left", "right"]);
    for (const d of report.splitDirectories) expect(d.clusterCount).toBe(2);
    expect(report.scatteredClusters).toHaveLength(2);
    for (const c of report.scatteredClusters) {
      expect(c.dirCount).toBe(2);
      expect(c.dirs.flatMap((d) => d.files)).toHaveLength(3);
    }
  });

  it("excludes test files from the node set and counts what it excluded", () => {
    const modules = [mod("a.ts"), mod("a.test.ts", true), mod("b.spec.ts", true)];
    const report = buildClusterReport([], modules);
    expect(report.excludedTestFileCount).toBe(2);
    expect(report.isolatedFileCount).toBe(1);
  });
});
