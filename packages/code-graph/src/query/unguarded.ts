import type { FunctionNode, UnguardedEffect } from "../schema.js";
import { type Adjacency, invokedAdjacency } from "./reach.js";

function stateKey(id: string, guarded: boolean): string {
  return `${guarded ? "1" : "0"} ${id}`;
}

type Search = {
  parent: Map<string, string | null>;
  nodeAt: Map<string, string>;
  entryAt: Map<string, string>;
  queue: string[];
};

function witnessPath(search: Search, key: string): string[] {
  const path: string[] = [];
  let cursor: string | null | undefined = key;
  while (cursor !== null && cursor !== undefined) {
    const id = search.nodeAt.get(cursor);
    if (id !== undefined) path.push(id);
    cursor = search.parent.get(cursor) ?? null;
  }
  return path.reverse();
}

function seed(functions: readonly FunctionNode[]): Search {
  const search: Search = { parent: new Map(), nodeAt: new Map(), entryAt: new Map(), queue: [] };
  const entries = functions
    .filter((f) => f.nodeKind?.kind === "entry")
    .map((f) => f.id)
    .sort((a, b) => a.localeCompare(b));
  for (const id of entries) {
    const key = stateKey(id, false);
    if (search.parent.has(key)) continue;
    search.parent.set(key, null);
    search.nodeAt.set(key, id);
    search.entryAt.set(key, id);
    search.queue.push(key);
  }
  return search;
}

export function findUnguarded(functions: readonly FunctionNode[]): UnguardedEffect[] {
  const byId = new Map(functions.map((f) => [f.id, f]));
  const adjacency: Adjacency = invokedAdjacency(functions);
  const search = seed(functions);
  const found = new Map<string, UnguardedEffect>();

  let i = 0;
  while (i < search.queue.length) {
    const key = search.queue[i++];
    const id = key === undefined ? undefined : search.nodeAt.get(key);
    if (key === undefined || id === undefined) continue;
    const node = byId.get(id);
    const guardedOut = key.startsWith("1 ") || node?.nodeKind?.kind === "auth";
    record(found, search, key, node, guardedOut);
    expand(search, adjacency, key, id, guardedOut);
  }

  return [...found.values()].sort((a, b) => a.effectId.localeCompare(b.effectId));
}

function record(
  found: Map<string, UnguardedEffect>,
  search: Search,
  key: string,
  node: FunctionNode | undefined,
  guarded: boolean,
): void {
  if (guarded || node === undefined) return;
  if (node.nodeKind?.kind !== "effect" || found.has(node.id)) return;
  found.set(node.id, {
    effectId: node.id,
    file: node.file,
    startLine: node.startLine,
    entryId: search.entryAt.get(key) ?? node.id,
    path: witnessPath(search, key),
  });
}

function expand(
  search: Search,
  adjacency: Adjacency,
  key: string,
  id: string,
  guardedOut: boolean,
): void {
  for (const next of adjacency.get(id) ?? []) {
    const nextKey = stateKey(next, guardedOut);
    if (search.parent.has(nextKey)) continue;
    search.parent.set(nextKey, key);
    search.nodeAt.set(nextKey, next);
    search.entryAt.set(nextKey, search.entryAt.get(key) ?? next);
    search.queue.push(nextKey);
  }
}
