import type { FunctionNode } from "../schema.js";
import {
  type CostContext,
  type CostInputs,
  collapseCost,
  costInputs,
  effectReachers,
  packageResolver,
} from "./cost.js";
import { findPartialTwins, type PartialTwin } from "./partial.js";
import type { CollapseSettings } from "./settings.js";
import { firedSignals, round4, type Signal, type Twin, toTwin } from "./signals.js";

export type BlockKind = "callee" | "caller" | "name-token";

export type SkippedBlock = { kind: BlockKind; key: string; size: number };

export type CollapseCandidate = {
  aId: string;
  aFile: string;
  aStartLine: number;
  aEndLine: number;
  bId: string;
  bFile: string;
  bStartLine: number;
  bEndLine: number;
  signals: Signal[];
  confidence: number;
  cost: number;
  costInputs: CostInputs;
  rank: number;
};

export type CollapseCluster = {
  representative: CollapseCandidate;
  members: string[];
  pairCount: number;
  rank: number;
};

export type CollapseReport = {
  settings: CollapseSettings;
  consideredFunctions: number;
  pairsScored: number;
  skippedBlocks: SkippedBlock[];
  candidates: CollapseCandidate[];
  clusters: CollapseCluster[];
  partialTwins: PartialTwin[];
};

export function isCandidateFunction(fn: FunctionNode, s: CollapseSettings): boolean {
  if (fn.isTest || fn.edges === null) return false;
  if (fn.kind === "constructor" || fn.kind === "getter" || fn.kind === "setter") return false;
  return fn.loc >= s.minLoc && fn.complexity >= s.minComplexity;
}

type Index = Map<string, number[]>;

function addTo(index: Index, key: string, position: number): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [position]);
  else bucket.push(position);
}

function buildIndexes(twins: readonly Twin[]): Record<BlockKind, Index> {
  const callee: Index = new Map();
  const caller: Index = new Map();
  const token: Index = new Map();
  twins.forEach((twin, position) => {
    for (const c of twin.callees) addTo(callee, c, position);
    for (const c of twin.callers) addTo(caller, c, position);
    for (const t of twin.tokens) addTo(token, t, position);
  });
  return { callee, caller, "name-token": token };
}

function expandIndex(
  kind: BlockKind,
  index: Index,
  stride: number,
  s: CollapseSettings,
  pairs: Set<number>,
  skipped: SkippedBlock[],
): void {
  for (const [key, members] of index) {
    if (members.length < 2) continue;
    if (members.length > s.maxBlockSize) {
      skipped.push({ kind, key, size: members.length });
      continue;
    }
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        pairs.add((members[i] ?? 0) * stride + (members[j] ?? 0));
      }
    }
  }
}

function proposePairs(
  twins: readonly Twin[],
  s: CollapseSettings,
): { pairs: Set<number>; skipped: SkippedBlock[] } {
  const indexes = buildIndexes(twins);
  const stride = twins.length;
  const pairs = new Set<number>();
  const skipped: SkippedBlock[] = [];
  expandIndex("callee", indexes.callee, stride, s, pairs, skipped);
  expandIndex("caller", indexes.caller, stride, s, pairs, skipped);
  expandIndex("name-token", indexes["name-token"], stride, s, pairs, skipped);
  skipped.sort(
    (x, y) => y.size - x.size || x.kind.localeCompare(y.kind) || x.key.localeCompare(y.key),
  );
  return { pairs, skipped };
}

function confidenceOf(signals: readonly Signal[]): number {
  return round4(signals.reduce((sum, sig) => sum + sig.strength, 0) / 4);
}

function scorePair(
  a: Twin,
  b: Twin,
  s: CollapseSettings,
  ctx: CostContext,
): CollapseCandidate | null {
  const signals = firedSignals(a, b, s);
  if (signals.length < s.minSignals) return null;
  const confidence = confidenceOf(signals);
  const inputs = costInputs(a, b, ctx);
  const cost = collapseCost(inputs, s);
  return {
    aId: a.id,
    aFile: a.file,
    aStartLine: a.startLine,
    aEndLine: a.endLine,
    bId: b.id,
    bFile: b.file,
    bStartLine: b.startLine,
    bEndLine: b.endLine,
    signals,
    confidence,
    cost,
    costInputs: inputs,
    rank: round4(confidence / cost),
  };
}

function buildCostContext(
  functions: readonly FunctionNode[],
  packageRoots: readonly string[],
): CostContext {
  return {
    packageOf: packageResolver(packageRoots),
    fileOf: new Map(functions.map((f) => [f.id, f.file])),
    reachesEffect: effectReachers(functions),
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function joinable(cluster: CollapseCluster, id: string, pairs: ReadonlySet<string>): boolean {
  return cluster.members.every((m) => m === id || pairs.has(pairKey(m, id)));
}

function remember(membership: Map<string, number[]>, id: string, index: number): void {
  const bucket = membership.get(id);
  if (bucket === undefined) membership.set(id, [index]);
  else bucket.push(index);
}

function place(
  candidate: CollapseCandidate,
  clusters: CollapseCluster[],
  membership: Map<string, number[]>,
  pairs: ReadonlySet<string>,
): void {
  const seen = new Set([
    ...(membership.get(candidate.aId) ?? []),
    ...(membership.get(candidate.bId) ?? []),
  ]);
  for (const index of seen) {
    const cluster = clusters[index];
    if (cluster === undefined) continue;
    const hasA = cluster.members.includes(candidate.aId);
    const hasB = cluster.members.includes(candidate.bId);
    if (hasA && hasB) {
      cluster.pairCount += 1;
      return;
    }
    const joiner = hasA ? candidate.bId : candidate.aId;
    if (!joinable(cluster, joiner, pairs)) continue;
    cluster.members.push(joiner);
    cluster.pairCount += 1;
    remember(membership, joiner, index);
    return;
  }
  const index = clusters.length;
  clusters.push({
    representative: candidate,
    members: [candidate.aId, candidate.bId],
    pairCount: 1,
    rank: candidate.rank,
  });
  remember(membership, candidate.aId, index);
  remember(membership, candidate.bId, index);
}

function clusterCandidates(candidates: readonly CollapseCandidate[]): CollapseCluster[] {
  const pairs = new Set(candidates.map((c) => pairKey(c.aId, c.bId)));
  const clusters: CollapseCluster[] = [];
  const membership = new Map<string, number[]>();
  for (const candidate of candidates) place(candidate, clusters, membership, pairs);
  for (const cluster of clusters) {
    cluster.members = [...new Set(cluster.members)].sort((x, y) => x.localeCompare(y));
  }
  return clusters.sort(
    (x, y) => y.rank - x.rank || x.representative.aId.localeCompare(y.representative.aId),
  );
}

export function findCollapseCandidates(
  functions: readonly FunctionNode[],
  packageRoots: readonly string[],
  s: CollapseSettings,
): CollapseReport {
  const considered = functions
    .filter((fn) => isCandidateFunction(fn, s))
    .sort((x, y) => x.id.localeCompare(y.id));
  const twins = considered.map(toTwin);
  const { pairs, skipped } = proposePairs(twins, s);
  const ctx = buildCostContext(functions, packageRoots);

  const candidates: CollapseCandidate[] = [];
  const stride = twins.length;
  for (const encoded of pairs) {
    const a = twins[Math.floor(encoded / stride)];
    const b = twins[encoded % stride];
    if (a === undefined || b === undefined) continue;
    const scored = scorePair(a, b, s, ctx);
    if (scored !== null) candidates.push(scored);
  }
  candidates.sort(
    (x, y) => y.rank - x.rank || x.aId.localeCompare(y.aId) || x.bId.localeCompare(y.bId),
  );

  return {
    settings: s,
    consideredFunctions: twins.length,
    pairsScored: pairs.size,
    skippedBlocks: skipped,
    candidates,
    clusters: clusterCandidates(candidates),
    partialTwins: findPartialTwins(considered, s),
  };
}
