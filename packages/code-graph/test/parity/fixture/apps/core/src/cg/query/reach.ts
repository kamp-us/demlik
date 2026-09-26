import type { FunctionNode } from "../schema.js";

export type Adjacency = ReadonlyMap<string, readonly string[]>;

function isInternal(id: string, ids: ReadonlySet<string>): boolean {
  return ids.has(id);
}

export function invokedAdjacency(functions: readonly FunctionNode[]): Adjacency {
  const ids = new Set(functions.map((f) => f.id));
  const adj = new Map<string, string[]>();
  for (const fn of functions) {
    const outs = new Set<string>();
    for (const c of fn.edges?.calls ?? []) {
      if (isInternal(c.calleeId, ids)) outs.add(c.calleeId);
    }
    adj.set(
      fn.id,
      [...outs].sort((a, b) => a.localeCompare(b)),
    );
  }
  return adj;
}

export function fullAdjacency(
  functions: readonly FunctionNode[],
  referencesById: ReadonlyMap<string, readonly string[]>,
): Adjacency {
  const ids = new Set(functions.map((f) => f.id));
  const adj = new Map<string, string[]>();
  for (const fn of functions) {
    const outs = new Set<string>();
    for (const c of fn.edges?.calls ?? []) {
      if (isInternal(c.calleeId, ids)) outs.add(c.calleeId);
    }
    for (const r of referencesById.get(fn.id) ?? []) {
      if (isInternal(r, ids)) outs.add(r);
    }
    adj.set(
      fn.id,
      [...outs].sort((a, b) => a.localeCompare(b)),
    );
  }
  return adj;
}

export function reachableFrom(adj: Adjacency, roots: readonly string[]): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  let i = 0;
  while (i < queue.length) {
    const id = queue[i++];
    if (id === undefined) continue;
    for (const next of adj.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
