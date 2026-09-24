import type { CallSite } from "../schema.js";
import { sccMembers, stronglyConnectedComponents } from "./scc.js";

function isExternal(id: string): boolean {
  return id.startsWith("external:");
}

type CallGraph = {
  adj: Map<string, string[]>;
  selfLoop: Set<string>;
};

type CondensedDag = {
  sccEdges: Map<number, Set<number>>;
  sccIsCyclic: Map<number, boolean>;
};

function buildCallGraph(ids: string[], callsById: Map<string, CallSite[]>): CallGraph {
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const id of ids) {
    const outs: string[] = [];
    for (const c of callsById.get(id) ?? []) {
      if (isExternal(c.calleeId) || !idSet.has(c.calleeId)) continue;
      if (c.calleeId === id) {
        selfLoop.add(id);
      } else {
        outs.push(c.calleeId);
      }
    }
    adj.set(id, [...new Set(outs)]);
  }
  return { adj, selfLoop };
}

function condenseToDag(ids: string[], graph: CallGraph, sccOf: Map<string, number>): CondensedDag {
  const membersByScc = sccMembers(ids, sccOf);
  const sccEdges = new Map<number, Set<number>>();
  const sccIsCyclic = new Map<number, boolean>();
  for (const [s, members] of membersByScc) {
    sccEdges.set(s, new Set());
    sccIsCyclic.set(s, members.length > 1 || members.some((m) => graph.selfLoop.has(m)));
  }
  for (const id of ids) {
    const from = sccOf.get(id);
    if (from === undefined) continue;
    for (const callee of graph.adj.get(id) ?? []) {
      const to = sccOf.get(callee);
      if (to === undefined || to === from) continue;
      sccEdges.get(from)?.add(to);
    }
  }
  return { sccEdges, sccIsCyclic };
}

function longestPathDepths(
  ids: string[],
  sccOf: Map<string, number>,
  dag: CondensedDag,
): Map<string, number> {
  const sccDepth = new Map<number, number>();
  function depthOf(s: number): number {
    const cached = sccDepth.get(s);
    if (cached !== undefined) return cached;
    sccDepth.set(s, 0);
    let maxChild = -1;
    for (const to of dag.sccEdges.get(s) ?? []) {
      maxChild = Math.max(maxChild, depthOf(to));
    }
    const base = maxChild < 0 ? 0 : maxChild + 1;
    const d = base + (dag.sccIsCyclic.get(s) ? 1 : 0);
    sccDepth.set(s, d);
    return d;
  }

  const out = new Map<string, number>();
  for (const id of ids) {
    const s = sccOf.get(id);
    out.set(id, s === undefined ? 0 : depthOf(s));
  }
  return out;
}

export function computeChainDepths(
  ids: string[],
  callsById: Map<string, CallSite[]>,
): Map<string, number> {
  const graph = buildCallGraph(ids, callsById);
  const sccOf = stronglyConnectedComponents(ids, graph.adj);
  const dag = condenseToDag(ids, graph, sccOf);
  return longestPathDepths(ids, sccOf, dag);
}
