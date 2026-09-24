import path from "node:path";
import type {
  ClusterReport,
  DirectoryClusterGroup,
  FunctionNode,
  ModuleNode,
  ScatteredCluster,
  SplitDirectory,
} from "../schema.js";
import { valueEdges } from "../smells/coupling.js";
import { type Edge, louvain } from "./louvain.js";

function dirOf(file: string): string {
  return path.posix.dirname(file);
}

function groupByDir(files: readonly string[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const bucket = byDir.get(dirOf(file));
    if (bucket === undefined) byDir.set(dirOf(file), [file]);
    else bucket.push(file);
  }
  return byDir;
}

function bump(weights: Map<string, number>, from: string, to: string): void {
  if (from === to) return;
  const key = from < to ? `${from}\t${to}` : `${to}\t${from}`;
  weights.set(key, (weights.get(key) ?? 0) + 1);
}

function callPairs(
  functions: readonly FunctionNode[],
  fileOf: ReadonlyMap<string, string>,
  weights: Map<string, number>,
): void {
  for (const fn of functions) {
    const from = fileOf.get(fn.id);
    if (from === undefined) continue;
    const seen = new Set<string>();
    for (const call of fn.edges?.calls ?? []) {
      const to = fileOf.get(call.calleeId);
      if (to === undefined || seen.has(call.calleeId)) continue;
      seen.add(call.calleeId);
      bump(weights, from, to);
    }
  }
}

function buildEdges(
  functions: readonly FunctionNode[],
  modules: ModuleNode[],
  nodes: ReadonlySet<string>,
): Edge[] {
  const weights = new Map<string, number>();
  for (const e of valueEdges(modules)) {
    if (nodes.has(e.from) && nodes.has(e.to)) bump(weights, e.from, e.to);
  }
  const fileOf = new Map<string, string>();
  for (const fn of functions) {
    if (nodes.has(fn.file)) fileOf.set(fn.id, fn.file);
  }
  callPairs(functions, fileOf, weights);

  const edges: Edge[] = [];
  for (const [key, weight] of weights) {
    const [a, b] = key.split("\t");
    if (a !== undefined && b !== undefined) edges.push({ a, b, weight });
  }
  edges.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return edges;
}

function groupMembers(membership: ReadonlyMap<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [file, community] of membership) {
    const bucket = groups.get(community);
    if (bucket === undefined) groups.set(community, [file]);
    else bucket.push(file);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => a.localeCompare(b));
  return groups;
}

function nameClusters(groups: Map<string, string[]>): Map<string, string> {
  const ordered = [...groups.entries()].sort(
    (x, y) => y[1].length - x[1].length || (x[1][0] ?? "").localeCompare(y[1][0] ?? ""),
  );
  const width = String(ordered.length).length;
  const names = new Map<string, string>();
  ordered.forEach(([community], i) => {
    names.set(community, `c${String(i + 1).padStart(width, "0")}`);
  });
  return names;
}

function scatteredClusters(
  groups: Map<string, string[]>,
  names: ReadonlyMap<string, string>,
): ScatteredCluster[] {
  const out: ScatteredCluster[] = [];
  for (const [community, files] of groups) {
    const byDir = groupByDir(files);
    if (byDir.size < 2) continue;
    const dirs = [...byDir.entries()]
      .map(([dir, dirFiles]) => ({ dir, files: dirFiles }))
      .sort((x, y) => y.files.length - x.files.length || x.dir.localeCompare(y.dir));
    out.push({
      id: names.get(community) ?? community,
      size: files.length,
      dirCount: byDir.size,
      dirs,
    });
  }
  out.sort((x, y) => y.dirCount - x.dirCount || y.size - x.size || x.id.localeCompare(y.id));
  return out;
}

function partitionDir(
  files: readonly string[],
  clusterOf: ReadonlyMap<string, string>,
): { grouped: Map<string, string[]>; isolatedFiles: string[] } {
  const grouped = new Map<string, string[]>();
  const isolatedFiles: string[] = [];
  for (const f of [...files].sort((a, b) => a.localeCompare(b))) {
    const id = clusterOf.get(f);
    if (id === undefined) {
      isolatedFiles.push(f);
      continue;
    }
    const bucket = grouped.get(id);
    if (bucket === undefined) grouped.set(id, [f]);
    else bucket.push(f);
  }
  return { grouped, isolatedFiles };
}

function splitDirectories(
  nodes: readonly string[],
  clusterOf: ReadonlyMap<string, string>,
): SplitDirectory[] {
  const out: SplitDirectory[] = [];
  for (const [dir, files] of groupByDir(nodes)) {
    const { grouped, isolatedFiles } = partitionDir(files, clusterOf);
    if (grouped.size < 2) continue;
    const clusters: DirectoryClusterGroup[] = [...grouped.entries()]
      .map(([clusterId, clusterFiles]) => ({ clusterId, files: clusterFiles }))
      .sort((x, y) => y.files.length - x.files.length || x.clusterId.localeCompare(y.clusterId));
    out.push({ dir, fileCount: files.length, clusterCount: grouped.size, clusters, isolatedFiles });
  }
  out.sort(
    (x, y) =>
      y.clusterCount - x.clusterCount || y.fileCount - x.fileCount || x.dir.localeCompare(y.dir),
  );
  return out;
}

export function buildClusterReport(
  functions: readonly FunctionNode[],
  modules: readonly ModuleNode[],
): ClusterReport {
  const production = modules.filter((m) => !m.isTest);
  const nodeSet = new Set(production.map((m) => m.file));
  const edges = buildEdges(
    functions.filter((fn) => !fn.isTest),
    production,
    nodeSet,
  );

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.a);
    connected.add(e.b);
  }
  const nodes = [...connected].sort((a, b) => a.localeCompare(b));
  const { membership, modularity } = louvain(nodes, edges);

  const groups = groupMembers(membership);
  const names = nameClusters(groups);
  const clusterOf = new Map<string, string>();
  for (const [file, community] of membership) {
    clusterOf.set(file, names.get(community) ?? community);
  }

  const allFiles = production.map((m) => m.file).sort((a, b) => a.localeCompare(b));
  return {
    algorithm: "louvain-deterministic",
    modularity: Number(modularity.toFixed(6)),
    clusterCount: groups.size,
    clusteredFileCount: nodes.length,
    isolatedFileCount: allFiles.length - nodes.length,
    excludedTestFileCount: modules.length - production.length,
    scatteredClusters: scatteredClusters(groups, names),
    splitDirectories: splitDirectories(allFiles, clusterOf),
  };
}
