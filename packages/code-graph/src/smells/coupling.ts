import { sccMembers, stronglyConnectedComponents } from "../extract/scc.js";
import type { ModuleNode } from "../schema.js";

export function boundaryOf(file: string, packageRoots: readonly string[]): string {
  let best = "";
  for (const root of packageRoots) {
    if (root === "") continue;
    if ((file === root || file.startsWith(`${root}/`)) && root.length > best.length) best = root;
  }
  return best;
}

export type ValueEdge = { from: string; to: string };

export function valueEdges(modules: ModuleNode[]): ValueEdge[] {
  const known = new Set(modules.map((m) => m.file));
  const seen = new Set<string>();
  const edges: ValueEdge[] = [];
  for (const m of modules) {
    for (const e of m.importEdges) {
      if (e.typeOnly || e.target === null || !known.has(e.target) || e.target === m.file) continue;
      const key = `${m.file}\t${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: m.file, to: e.target });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return edges;
}

function adjacencyOf(
  modules: ModuleNode[],
  edges: ValueEdge[],
): {
  nodes: string[];
  adj: Map<string, string[]>;
} {
  const nodes = modules.map((m) => m.file).sort((a, b) => a.localeCompare(b));
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  return { nodes, adj };
}

export type Cycle = { members: string[] };

function cyclesOf(modules: ModuleNode[], edges: ValueEdge[]): Cycle[] {
  const { nodes, adj } = adjacencyOf(modules, edges);
  const sccOf = stronglyConnectedComponents(nodes, adj);
  const cycles: Cycle[] = [];
  for (const arr of sccMembers(nodes, sccOf).values()) {
    if (arr.length < 2) continue;
    cycles.push({ members: arr.slice().sort((a, b) => a.localeCompare(b)) });
  }
  cycles.sort((a, b) => (a.members[0] ?? "").localeCompare(b.members[0] ?? ""));
  return cycles;
}

export function findCycles(modules: ModuleNode[]): Cycle[] {
  return cyclesOf(modules, valueEdges(modules));
}

export type CrossBoundaryGroup = { from: string; to: string; edges: ValueEdge[] };

function crossBoundaryOf(
  edges: ValueEdge[],
  packageRoots: readonly string[],
): CrossBoundaryGroup[] {
  const groups = new Map<string, CrossBoundaryGroup>();
  for (const e of edges) {
    const from = boundaryOf(e.from, packageRoots);
    const to = boundaryOf(e.to, packageRoots);
    if (from === to) continue;
    const key = `${from}\t${to}`;
    const group = groups.get(key) ?? { from, to, edges: [] };
    group.edges.push(e);
    groups.set(key, group);
  }
  const out = [...groups.values()];
  for (const g of out)
    g.edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return out;
}

export function crossBoundaryEdges(
  modules: ModuleNode[],
  packageRoots: readonly string[],
): CrossBoundaryGroup[] {
  return crossBoundaryOf(valueEdges(modules), packageRoots);
}

export type CouplingFacts = {
  boundary: string;
  cycleSize: number;
  crossBoundaryOutCount: number;
};

function couplingOf(
  modules: ModuleNode[],
  edges: ValueEdge[],
  cycles: Cycle[],
  packageRoots: readonly string[],
): Map<string, CouplingFacts> {
  const cycleSizeByFile = new Map<string, number>();
  for (const cycle of cycles) {
    for (const member of cycle.members) cycleSizeByFile.set(member, cycle.members.length);
  }
  const crossOutByFile = new Map<string, number>();
  for (const e of edges) {
    if (boundaryOf(e.from, packageRoots) === boundaryOf(e.to, packageRoots)) continue;
    crossOutByFile.set(e.from, (crossOutByFile.get(e.from) ?? 0) + 1);
  }
  const out = new Map<string, CouplingFacts>();
  for (const m of modules) {
    out.set(m.file, {
      boundary: boundaryOf(m.file, packageRoots),
      cycleSize: cycleSizeByFile.get(m.file) ?? 0,
      crossBoundaryOutCount: crossOutByFile.get(m.file) ?? 0,
    });
  }
  return out;
}

export function couplingByFile(
  modules: ModuleNode[],
  packageRoots: readonly string[],
): Map<string, CouplingFacts> {
  const edges = valueEdges(modules);
  return couplingOf(modules, edges, cyclesOf(modules, edges), packageRoots);
}

export type ModuleRank = {
  file: string;
  cycleSize: number;
  crossBoundaryOutCount: number;
  score: number;
};

function rankOf(modules: ModuleNode[], coupling: Map<string, CouplingFacts>): ModuleRank[] {
  const ranked: ModuleRank[] = [];
  for (const m of modules) {
    const c = coupling.get(m.file);
    if (!c) continue;
    const score = c.cycleSize + c.crossBoundaryOutCount;
    if (score === 0) continue;
    ranked.push({
      file: m.file,
      cycleSize: c.cycleSize,
      crossBoundaryOutCount: c.crossBoundaryOutCount,
      score,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return ranked;
}

export function rankModules(modules: ModuleNode[], packageRoots: readonly string[]): ModuleRank[] {
  return rankOf(modules, couplingByFile(modules, packageRoots));
}

export type CouplingAnalysis = {
  cycles: Cycle[];
  crossBoundary: CrossBoundaryGroup[];
  ranked: ModuleRank[];
  coupling: Map<string, CouplingFacts>;
};

export function analyzeCoupling(
  modules: ModuleNode[],
  packageRoots: readonly string[],
): CouplingAnalysis {
  const edges = valueEdges(modules);
  const cycles = cyclesOf(modules, edges);
  const crossBoundary = crossBoundaryOf(edges, packageRoots);
  const coupling = couplingOf(modules, edges, cycles, packageRoots);
  const ranked = rankOf(modules, coupling);
  return { cycles, crossBoundary, ranked, coupling };
}
