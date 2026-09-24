import { describe, expect, it } from "vitest";
import type { ImportEdge, ModuleNode } from "../schema.js";
import { ThresholdsSchema } from "../schema.js";
import { boundaryOf, couplingByFile, crossBoundaryEdges, findCycles } from "./coupling.js";
import { smellsForModule } from "./evaluate.js";

const thresholds = ThresholdsSchema.parse({});

const repoPackageRoots = ["", "packages/a", "packages/b"];
const scopedPackageRoots = [""];

function mod(file: string, edges: { to: string; typeOnly?: boolean }[] = []): ModuleNode {
  const importEdges: ImportEdge[] = edges.map((e) => ({
    specifier: `./${e.to}`,
    kind: "static",
    typeOnly: e.typeOnly ?? false,
    target: e.to,
  }));
  return {
    file,
    loc: 10,
    commentLines: 0,
    functionIds: [],
    imports: edges.map((e) => e.to),
    importedBy: [],
    importEdges,
    isTest: false,
    smells: [],
  };
}

const valueCycle = [mod("src/a.ts", [{ to: "src/b.ts" }]), mod("src/b.ts", [{ to: "src/a.ts" }])];

const typeCycle = [
  mod("src/a.ts", [{ to: "src/b.ts", typeOnly: true }]),
  mod("src/b.ts", [{ to: "src/a.ts", typeOnly: true }]),
];

const crossBoundary = [
  mod("packages/a/x.ts", [{ to: "packages/b/y.ts" }]),
  mod("packages/b/y.ts", []),
];

const intraPackageCrossFile = [mod("graph/a.ts", [{ to: "nodes/b.ts" }]), mod("nodes/b.ts", [])];

const clean = [mod("src/a.ts", [{ to: "src/b.ts" }]), mod("src/b.ts", [])];

function moduleKinds(
  modules: ModuleNode[],
  file: string,
  packageRoots: readonly string[],
): string[] {
  const coupling = couplingByFile(modules, packageRoots);
  const target = modules.find((m) => m.file === file);
  if (!target) throw new Error(`no module ${file}`);
  return smellsForModule(target, thresholds, coupling.get(file) ?? null).map((s) => s.kind);
}

describe("boundaryOf — package boundary from the workspace layout (#2446)", () => {
  it("maps a file to the LONGEST package root that contains it", () => {
    expect(boundaryOf("packages/a/src/x.ts", repoPackageRoots)).toBe("packages/a");
    expect(boundaryOf("packages/b/y.ts", repoPackageRoots)).toBe("packages/b");
  });

  it('collapses every file of a single-package scoped run to the one "" boundary', () => {
    expect(boundaryOf("graph/a.ts", scopedPackageRoots)).toBe("");
    expect(boundaryOf("nodes/b.ts", scopedPackageRoots)).toBe("");
    expect(boundaryOf("index.ts", scopedPackageRoots)).toBe("");
  });

  it("prefers the innermost (nested) package over an enclosing one", () => {
    expect(boundaryOf("packages/a/sub/x.ts", ["", "packages/a", "packages/a/sub"])).toBe(
      "packages/a/sub",
    );
  });
});

describe("findCycles — Tarjan SCC over VALUE edges", () => {
  it("FLAGS a value-import cycle A→B→A, members listed", () => {
    const cycles = findCycles(valueCycle);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.members).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does NOT flag a type-only cycle (runtime-erased, harmless — the load-bearing exclusion)", () => {
    expect(findCycles(typeCycle)).toEqual([]);
  });

  it("does not flag an acyclic graph", () => {
    expect(findCycles(clean)).toEqual([]);
  });
});

describe("crossBoundaryEdges — value edges crossing a PACKAGE, grouped source→target", () => {
  it("FLAGS a cross-package edge, grouped by package boundary", () => {
    const groups = crossBoundaryEdges(crossBoundary, repoPackageRoots);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.from).toBe("packages/a");
    expect(groups[0]?.to).toBe("packages/b");
    expect(groups[0]?.edges).toEqual([{ from: "packages/a/x.ts", to: "packages/b/y.ts" }]);
  });

  it("does NOT flag an intra-package cross-FILE edge (the #2446 behavior change)", () => {
    expect(crossBoundaryEdges(intraPackageCrossFile, scopedPackageRoots)).toEqual([]);
  });

  it("does not flag an in-boundary edge", () => {
    expect(crossBoundaryEdges(clean, scopedPackageRoots)).toEqual([]);
  });
});

describe("coupling smells — wired into the module smell surface", () => {
  it("a value-cycle member is flagged `dependency-cycle`", () => {
    expect(moduleKinds(valueCycle, "src/a.ts", scopedPackageRoots)).toContain("dependency-cycle");
    expect(moduleKinds(valueCycle, "src/b.ts", scopedPackageRoots)).toContain("dependency-cycle");
  });

  it("a type-only cycle member is NOT flagged `dependency-cycle` (load-bearing exclusion)", () => {
    expect(moduleKinds(typeCycle, "src/a.ts", scopedPackageRoots)).not.toContain(
      "dependency-cycle",
    );
    expect(moduleKinds(typeCycle, "src/b.ts", scopedPackageRoots)).not.toContain(
      "dependency-cycle",
    );
  });

  it("a cross-PACKAGE source is flagged `cross-boundary-import`", () => {
    expect(moduleKinds(crossBoundary, "packages/a/x.ts", repoPackageRoots)).toContain(
      "cross-boundary-import",
    );
  });

  it("an intra-package cross-FILE source is NOT flagged `cross-boundary-import` (#2446)", () => {
    expect(moduleKinds(intraPackageCrossFile, "graph/a.ts", scopedPackageRoots)).not.toContain(
      "cross-boundary-import",
    );
  });

  it("a clean in-boundary acyclic module is flagged with neither coupling smell", () => {
    const kinds = moduleKinds(clean, "src/a.ts", scopedPackageRoots);
    expect(kinds).not.toContain("dependency-cycle");
    expect(kinds).not.toContain("cross-boundary-import");
  });

  it("no coupling claim on the cheap pass (coupling facts null → edges not computed)", () => {
    const target = valueCycle[0];
    if (!target) throw new Error("fixture");
    const kinds = smellsForModule(target, thresholds, null).map((s) => s.kind);
    expect(kinds).not.toContain("dependency-cycle");
    expect(kinds).not.toContain("cross-boundary-import");
  });
});
