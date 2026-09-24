import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ImportEdge, ModuleNode } from "../schema.js";
import { boundaryOf, crossBoundaryEdges, findCycles, rankModules, valueEdges } from "./coupling.js";

const BOUNDARIES = ["packages/a", "packages/b", "packages/c", "src", "graph"] as const;

const PACKAGE_ROOTS: readonly string[] = BOUNDARIES;

type EdgePair = readonly [number, number];

type GraphInput = {
  files: string[];
  valuePairs: EdgePair[];
  typePairs: EdgePair[];
  nodeKeys: number[];
};

const graphArb: fc.Arbitrary<GraphInput> = fc
  .array(fc.constantFrom(...BOUNDARIES), { minLength: 1, maxLength: 8 })
  // index suffix guarantees unique files; `boundaryOf(file) === boundary` by shape
  .map((boundaries) => boundaries.map((b, i) => `${b}/f${i}.ts`))
  .chain((files) => {
    const n = files.length;
    const idx = fc.nat({ max: n - 1 });
    const edge = fc.tuple(idx, idx);
    return fc.record({
      files: fc.constant(files),
      valuePairs: fc.array(edge, { maxLength: 3 * n }),
      typePairs: fc.array(edge, { maxLength: 3 * n }),
      nodeKeys: fc.array(fc.nat(), { minLength: n, maxLength: n }),
    });
  });

function normalize(files: string[], pairs: EdgePair[]): Set<string> {
  const out = new Set<string>();
  for (const [a, b] of pairs) {
    if (a === b) continue;
    out.add(`${files[a]}\t${files[b]}`);
  }
  return out;
}

function makeModules(input: GraphInput): ModuleNode[] {
  const { files } = input;
  const valueSet = normalize(files, input.valuePairs);
  const typeSet = new Set<string>();
  for (const key of normalize(files, input.typePairs)) {
    if (!valueSet.has(key)) typeSet.add(key);
  }

  const importedBy = new Map<string, Set<string>>();
  for (const f of files) importedBy.set(f, new Set());
  for (const key of valueSet) {
    const [from, to] = key.split("\t");
    if (from && to) importedBy.get(to)?.add(from);
  }

  const edgesFrom = (from: string, set: Set<string>, typeOnly: boolean): ImportEdge[] => {
    const edges: ImportEdge[] = [];
    for (const key of set) {
      const [a, to] = key.split("\t");
      if (a !== from || !to) continue;
      edges.push({ specifier: `./${to}`, kind: "static", typeOnly, target: to });
    }
    return edges;
  };

  return files.map((file) => {
    const importEdges = [...edgesFrom(file, valueSet, false), ...edgesFrom(file, typeSet, true)];
    return {
      file,
      loc: 10,
      commentLines: 0,
      functionIds: [],
      imports: importEdges.map((e) => e.specifier),
      importedBy: [...(importedBy.get(file) ?? [])].sort((a, b) => a.localeCompare(b)),
      importEdges,
      isTest: false,
      smells: [],
    };
  });
}

function shuffleModules(modules: ModuleNode[], keys: number[]): ModuleNode[] {
  return modules
    .map((m, i) => ({ m, k: keys[i] ?? 0, i }))
    .sort((x, y) => x.k - y.k || x.i - y.i)
    .map(({ m }) => m);
}

function canonCycles(cycles: { members: string[] }[]): string {
  return JSON.stringify(
    cycles
      .map((c) => [...c.members].sort((a, b) => a.localeCompare(b)))
      .sort((a, b) => a.join(",").localeCompare(b.join(","))),
  );
}

function reachability(files: string[], valuePairs: Set<string>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const f of files) adj.set(f, new Set());
  for (const key of valuePairs) {
    const [from, to] = key.split("\t");
    if (from && to) adj.get(from)?.add(to);
  }
  const reach = new Map<string, Set<string>>();
  for (const start of files) {
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      for (const nxt of adj.get(node) ?? []) stack.push(nxt);
    }
    reach.set(start, seen);
  }
  return reach;
}

const RUNS = { numRuns: 300 };

describe("coupling properties (#2441): invariants over all import graphs", () => {
  it("findCycles yields the same cycle SET when nodes + adjacency are permuted", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const modules = makeModules({ ...input, typePairs: [] });
        const permuted = shuffleModules(modules, input.nodeKeys).map((m) => ({
          ...m,
          importEdges: [...m.importEdges].reverse(),
        }));
        expect(canonCycles(findCycles(permuted))).toBe(canonCycles(findCycles(modules)));
        expect(canonCycles(findCycles(modules))).toBe(canonCycles(findCycles(modules)));
      }),
      RUNS,
    );
  });

  it("type-only edges -- even ones that would close a cycle -- never change the cycle set", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const valueOnly = makeModules({ ...input, typePairs: [] });
        const baseline = findCycles(valueOnly);

        const valueSet = normalize(input.files, input.valuePairs);
        const reach = reachability(input.files, valueSet);
        const closers: EdgePair[] = [];
        for (let a = 0; a < input.files.length; a++) {
          for (let b = 0; b < input.files.length; b++) {
            if (a === b) continue;
            const fa = input.files[a];
            const fb = input.files[b];
            if (!fa || !fb) continue;
            if (reach.get(fb)?.has(fa) && !reach.get(fa)?.has(fb)) closers.push([a, b]);
          }
        }

        const withTypeEdges = makeModules({
          ...input,
          typePairs: [...input.typePairs, ...closers],
        });
        const withTypeCycles = findCycles(withTypeEdges);

        expect(canonCycles(withTypeCycles)).toBe(canonCycles(baseline));

        const valueReach = reachability(input.files, valueSet);
        for (const cycle of withTypeCycles) {
          for (const u of cycle.members) {
            for (const v of cycle.members) {
              if (u === v) continue;
              expect(valueReach.get(u)?.has(v)).toBe(true);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("every reported cross-boundary edge has distinct boundaryOf endpoints; no same-boundary edge is reported", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const modules = makeModules(input);
        const groups = crossBoundaryEdges(modules, PACKAGE_ROOTS);

        for (const g of groups) {
          for (const e of g.edges) {
            expect(boundaryOf(e.from, PACKAGE_ROOTS)).not.toBe(boundaryOf(e.to, PACKAGE_ROOTS));
            expect(boundaryOf(e.from, PACKAGE_ROOTS)).toBe(g.from);
            expect(boundaryOf(e.to, PACKAGE_ROOTS)).toBe(g.to);
          }
        }

        const reported = new Set(groups.flatMap((g) => g.edges).map((e) => `${e.from}\t${e.to}`));
        for (const e of valueEdges(modules)) {
          const crosses = boundaryOf(e.from, PACKAGE_ROOTS) !== boundaryOf(e.to, PACKAGE_ROOTS);
          expect(reported.has(`${e.from}\t${e.to}`)).toBe(crosses);
        }
      }),
      RUNS,
    );
  });

  it("every value edge A->B implies A in B.importedBy, and every importedBy entry has a forward edge", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const modules = makeModules(input);
        const byFile = new Map(modules.map((m) => [m.file, m]));
        const forward = valueEdges(modules);
        const forwardKeys = new Set(forward.map((e) => `${e.from}\t${e.to}`));

        for (const e of forward) {
          expect(byFile.get(e.to)?.importedBy).toContain(e.from);
        }
        for (const m of modules) {
          for (const src of m.importedBy) {
            expect(forwardKeys.has(`${src}\t${m.file}`)).toBe(true);
          }
        }
        const importedByCount = modules.reduce((sum, m) => sum + m.importedBy.length, 0);
        expect(importedByCount).toBe(forward.length);
      }),
      RUNS,
    );
  });

  it("|intra| + |cross| == |value edges|, and every value edge is exactly one of the two", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const modules = makeModules(input);
        const ve = valueEdges(modules);
        const cross = crossBoundaryEdges(modules, PACKAGE_ROOTS).flatMap((g) => g.edges);
        const intra = ve.filter(
          (e) => boundaryOf(e.from, PACKAGE_ROOTS) === boundaryOf(e.to, PACKAGE_ROOTS),
        );

        expect(cross.length + intra.length).toBe(ve.length);
        const crossKeys = new Set(cross.map((e) => `${e.from}\t${e.to}`));
        expect(crossKeys.size).toBe(cross.length);

        const intraKeys = new Set(intra.map((e) => `${e.from}\t${e.to}`));
        for (const e of ve) {
          const key = `${e.from}\t${e.to}`;
          expect(crossKeys.has(key) !== intraKeys.has(key)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("rankModules is deterministic, a strict total order (ties by file), and worst-first", () => {
    fc.assert(
      fc.property(graphArb, (input) => {
        const modules = makeModules(input);
        const ranked = rankModules(modules, PACKAGE_ROOTS);

        expect(rankModules(shuffleModules(modules, input.nodeKeys), PACKAGE_ROOTS)).toEqual(ranked);

        const files = ranked.map((r) => r.file);
        expect(new Set(files).size).toBe(files.length);

        for (let i = 0; i + 1 < ranked.length; i++) {
          const a = ranked[i];
          const b = ranked[i + 1];
          if (!a || !b) continue;
          expect(a.score).toBeGreaterThanOrEqual(b.score);
          if (a.score === b.score) expect(a.file.localeCompare(b.file)).toBeLessThan(0);
        }
        for (const r of ranked) expect(r.score).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });
});
