import path from "node:path";
import { discoverPackageRoots } from "../extract/project.js";
import type { Graph, Smell, Thresholds } from "../schema.js";
import {
  analyzeCoupling,
  type CouplingAnalysis,
  type CrossBoundaryGroup,
  type Cycle,
  type ModuleRank,
} from "../smells/coupling.js";
import { stableStringify } from "./json.js";

function locator(smell: Smell): string {
  const target = smell.target;
  switch (target.type) {
    case "function":
      return `${target.id} (${target.file}:${target.startLine})`;
    case "module":
      return target.file;
    case "directory":
      return target.dir;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function flagCoupling(
  analysis: CouplingAnalysis,
  thresholds: Thresholds,
): { cycles: Cycle[]; groups: CrossBoundaryGroup[]; ranked: ModuleRank[] } {
  const { dependencyCycle, crossBoundaryImports } = thresholds;
  const crossOutByFile = new Map(analysis.ranked.map((r) => [r.file, r.crossBoundaryOutCount]));
  const groups = analysis.crossBoundary
    .map((g) => ({
      ...g,
      edges: g.edges.filter((e) => (crossOutByFile.get(e.from) ?? 0) > crossBoundaryImports),
    }))
    .filter((g) => g.edges.length > 0);
  return {
    cycles: analysis.cycles.filter((c) => c.members.length > dependencyCycle),
    groups,
    ranked: analysis.ranked.filter(
      (r) => r.cycleSize > dependencyCycle || r.crossBoundaryOutCount > crossBoundaryImports,
    ),
  };
}

function renderCoupling(graph: Graph): string {
  const packageRoots = discoverPackageRoots(path.resolve(graph.root));
  const analysis = analyzeCoupling(graph.modules, packageRoots);
  const {
    cycles: flaggedCycles,
    groups: flaggedGroups,
    ranked: flaggedRanked,
  } = flagCoupling(analysis, graph.thresholds);
  if (flaggedCycles.length === 0 && flaggedGroups.length === 0) return "";

  const lines: string[] = ["Coupling"];
  if (flaggedCycles.length > 0) {
    lines.push(`  Dependency cycles (${flaggedCycles.length}):`);
    for (const c of flaggedCycles) lines.push(`    [${c.members.join(", ")}]`);
  }
  if (flaggedGroups.length > 0) {
    const total = flaggedGroups.reduce((n, g) => n + g.edges.length, 0);
    lines.push(`  Cross-boundary edges (${total}):`);
    for (const g of flaggedGroups) {
      lines.push(`    ${g.from} → ${g.to} (${g.edges.length})`);
      for (const e of g.edges) lines.push(`      ${e.from} → ${e.to}`);
    }
  }
  if (flaggedRanked.length > 0) {
    lines.push("  Worst-coupled modules:");
    for (const r of flaggedRanked.slice(0, 10)) {
      lines.push(
        `    ${r.file}  score=${r.score} (cycle=${r.cycleSize} cross=${r.crossBoundaryOutCount})`,
      );
    }
  }
  return lines.join("\n");
}

function renderHuman(graph: Graph): string {
  const coupling = renderCoupling(graph);
  if (graph.smells.length === 0) return coupling === "" ? "No smells found." : coupling;

  const byKind = new Map<string, Smell[]>();
  for (const s of graph.smells) {
    const arr = byKind.get(s.kind) ?? [];
    arr.push(s);
    byKind.set(s.kind, arr);
  }
  const kinds = Array.from(byKind.keys()).sort();

  const lines: string[] = [];
  for (const kind of kinds) {
    const group = byKind.get(kind) ?? [];
    lines.push(`${kind} (${group.length})`);
    for (const s of group) {
      lines.push(`  [${s.severity}] ${locator(s)}  value=${s.value} threshold=${s.threshold}`);
    }
    lines.push("");
  }
  if (coupling !== "") lines.push(coupling);
  return lines.join("\n").trimEnd();
}

export function renderSmells(graph: Graph, json: boolean, pretty: boolean): string {
  if (json) {
    return stableStringify(graph.smells, pretty);
  }
  return renderHuman(graph);
}
