import {
  type EntryReach,
  EntryReachSchema,
  type FunctionNode,
  type UnguardedEffect,
} from "../schema.js";
import { type Adjacency, invokedAdjacency } from "./reach.js";

function isGuard(node: FunctionNode | undefined): boolean {
  const kind = node?.nodeKind;
  if (kind === undefined || kind === null) return false;
  return kind.kind === "auth" || (kind.kind === "entry" && kind.guards.length > 0);
}

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

function entriesReached(functions: readonly FunctionNode[], reach: EntryReach): string[] {
  return functions
    .filter((f) => f.nodeKind?.kind === "entry" && f.nodeKind.reach === reach)
    .map((f) => f.id)
    .sort((a, b) => a.localeCompare(b));
}

function seed(entries: readonly string[]): Search {
  const search: Search = { parent: new Map(), nodeAt: new Map(), entryAt: new Map(), queue: [] };
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

type Walk = {
  byId: ReadonlyMap<string, FunctionNode>;
  adjacency: Adjacency;
  found: Map<string, UnguardedEffect>;
};

function walkFrom(walk: Walk, entries: readonly string[], reach: EntryReach): void {
  const search = seed(entries);
  let i = 0;
  while (i < search.queue.length) {
    const key = search.queue[i++];
    const id = key === undefined ? undefined : search.nodeAt.get(key);
    if (key === undefined || id === undefined) continue;
    const node = walk.byId.get(id);
    const guardedOut = key.startsWith("1 ") || isGuard(node);
    record(walk.found, search, key, node, guardedOut, reach);
    expand(search, walk.adjacency, key, id, guardedOut);
  }
}

export function findUnguarded(functions: readonly FunctionNode[]): UnguardedEffect[] {
  const walk: Walk = {
    byId: new Map(functions.map((f) => [f.id, f])),
    adjacency: invokedAdjacency(functions),
    found: new Map(),
  };
  for (const reach of EntryReachSchema.options)
    walkFrom(walk, entriesReached(functions, reach), reach);
  return [...walk.found.values()].sort((a, b) => a.effectId.localeCompare(b.effectId));
}

function record(
  found: Map<string, UnguardedEffect>,
  search: Search,
  key: string,
  node: FunctionNode | undefined,
  guarded: boolean,
  reach: EntryReach,
): void {
  if (guarded || node === undefined) return;
  if (node.nodeKind?.kind !== "effect" || found.has(node.id)) return;
  found.set(node.id, {
    effectId: node.id,
    file: node.file,
    startLine: node.startLine,
    entryId: search.entryAt.get(key) ?? node.id,
    path: witnessPath(search, key),
    reach,
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
