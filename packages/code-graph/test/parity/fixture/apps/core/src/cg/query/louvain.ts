export type Edge = { a: string; b: string; weight: number };

type Weights = Map<string, number>;

type Level = {
  order: string[];
  adj: Map<string, Weights>;
  self: Map<string, number>;
  k: Map<string, number>;
  m2: number;
};

const EPS = 1e-12;
const MAX_PASSES = 20;
const MAX_LEVELS = 10;

function addWeight(adj: Map<string, Weights>, from: string, to: string, weight: number): void {
  const bucket = adj.get(from);
  if (bucket === undefined) adj.set(from, new Map([[to, weight]]));
  else bucket.set(to, (bucket.get(to) ?? 0) + weight);
}

function makeLevel(adj: Map<string, Weights>, self: Map<string, number>): Level {
  const k = new Map<string, number>();
  let m2 = 0;
  for (const [node, bucket] of adj) {
    let strength = 2 * (self.get(node) ?? 0);
    for (const w of bucket.values()) strength += w;
    k.set(node, strength);
    m2 += strength;
  }
  const order = [...adj.keys()].sort(
    (x, y) => (k.get(y) ?? 0) - (k.get(x) ?? 0) || x.localeCompare(y),
  );
  return { order, adj, self, k, m2 };
}

function initialLevel(nodes: readonly string[], edges: readonly Edge[]): Level {
  const adj = new Map<string, Weights>();
  for (const n of nodes) adj.set(n, new Map());
  for (const e of edges) {
    if (e.a === e.b || !adj.has(e.a) || !adj.has(e.b)) continue;
    addWeight(adj, e.a, e.b, e.weight);
    addWeight(adj, e.b, e.a, e.weight);
  }
  return makeLevel(adj, new Map());
}

function communityLinks(level: Level, node: string, comm: ReadonlyMap<string, string>): Weights {
  const links: Weights = new Map();
  for (const [neighbour, w] of level.adj.get(node) ?? []) {
    const c = comm.get(neighbour);
    if (c === undefined) continue;
    links.set(c, (links.get(c) ?? 0) + w);
  }
  return links;
}

function bestCommunity(
  links: Weights,
  tot: ReadonlyMap<string, number>,
  kn: number,
  m2: number,
  current: string,
): string {
  const score = (c: string): number => (links.get(c) ?? 0) - ((tot.get(c) ?? 0) * kn) / m2;
  let best = current;
  let bestScore = score(current);
  for (const c of [...links.keys()].sort((x, y) => x.localeCompare(y))) {
    const s = score(c);
    if (s > bestScore + EPS) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

function moveNode(
  level: Level,
  comm: Map<string, string>,
  tot: Map<string, number>,
  node: string,
): boolean {
  const current = comm.get(node);
  if (current === undefined) return false;
  const kn = level.k.get(node) ?? 0;
  tot.set(current, (tot.get(current) ?? 0) - kn);
  const best = bestCommunity(communityLinks(level, node, comm), tot, kn, level.m2, current);
  tot.set(best, (tot.get(best) ?? 0) + kn);
  if (best === current) return false;
  comm.set(node, best);
  return true;
}

function optimizeLevel(level: Level): Map<string, string> | null {
  if (level.m2 === 0) return null;
  const comm = new Map(level.order.map((n) => [n, n]));
  const tot = new Map(level.order.map((n) => [n, level.k.get(n) ?? 0]));
  let moved = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const node of level.order) {
      if (moveNode(level, comm, tot, node)) changed = true;
    }
    if (!changed) break;
    moved = true;
  }
  return moved ? comm : null;
}

type Fold = {
  comm: ReadonlyMap<string, string>;
  adj: Map<string, Weights>;
  self: Map<string, number>;
};

function seedCommunities(level: Level, fold: Fold): void {
  for (const node of level.order) {
    const c = fold.comm.get(node) ?? node;
    if (!fold.adj.has(c)) fold.adj.set(c, new Map());
    fold.self.set(c, (fold.self.get(c) ?? 0) + (level.self.get(node) ?? 0));
  }
}

function foldPair(fold: Fold, node: string, neighbour: string, weight: number): void {
  const cn = fold.comm.get(node) ?? node;
  const cx = fold.comm.get(neighbour) ?? neighbour;
  if (cn === cx) {
    fold.self.set(cn, (fold.self.get(cn) ?? 0) + weight);
    return;
  }
  addWeight(fold.adj, cn, cx, weight);
  addWeight(fold.adj, cx, cn, weight);
}

function aggregate(level: Level, comm: ReadonlyMap<string, string>): Level {
  const fold: Fold = { comm, adj: new Map(), self: new Map() };
  seedCommunities(level, fold);
  for (const node of level.order) {
    const bucket = level.adj.get(node);
    if (bucket === undefined) continue;
    for (const [neighbour, weight] of bucket) {
      if (node < neighbour) foldPair(fold, node, neighbour, weight);
    }
  }
  return makeLevel(fold.adj, fold.self);
}

function internalWeight(
  level: Level,
  membership: ReadonlyMap<string, string>,
  node: string,
  community: string,
): number {
  let internal = 2 * (level.self.get(node) ?? 0);
  const bucket = level.adj.get(node);
  if (bucket === undefined) return internal;
  for (const [neighbour, weight] of bucket) {
    if ((membership.get(neighbour) ?? neighbour) === community) internal += weight;
  }
  return internal;
}

function communityTotals(
  level: Level,
  membership: ReadonlyMap<string, string>,
): { inside: Map<string, number>; tot: Map<string, number> } {
  const inside = new Map<string, number>();
  const tot = new Map<string, number>();
  for (const node of level.order) {
    const c = membership.get(node) ?? node;
    tot.set(c, (tot.get(c) ?? 0) + (level.k.get(node) ?? 0));
    inside.set(c, (inside.get(c) ?? 0) + internalWeight(level, membership, node, c));
  }
  return { inside, tot };
}

function modularityOf(level: Level, membership: ReadonlyMap<string, string>): number {
  if (level.m2 === 0) return 0;
  const { inside, tot } = communityTotals(level, membership);
  let q = 0;
  for (const c of [...tot.keys()].sort((x, y) => x.localeCompare(y))) {
    q += (inside.get(c) ?? 0) / level.m2 - ((tot.get(c) ?? 0) / level.m2) ** 2;
  }
  return q;
}

export type Partition = {
  membership: ReadonlyMap<string, string>;
  modularity: number;
};

export function louvain(nodes: readonly string[], edges: readonly Edge[]): Partition {
  const base = initialLevel(nodes, edges);
  const membership = new Map(nodes.map((n) => [n, n]));
  let level = base;
  for (let i = 0; i < MAX_LEVELS; i++) {
    const comm = optimizeLevel(level);
    if (comm === null) break;
    for (const [node, c] of membership) membership.set(node, comm.get(c) ?? c);
    level = aggregate(level, comm);
  }
  return { membership, modularity: modularityOf(base, membership) };
}
