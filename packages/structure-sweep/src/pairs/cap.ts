import type { Pair, PairFunction } from "./collapse.js";

/** How many partners each anchor is judged against unless `--max-partners` names another count. */
export const DEFAULT_MAX_PARTNERS = 10;

/** A partner cap is a whole number of partners, at least one. */
export function maxPartners(n: number): number {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(
      `--max-partners is a whole number of at least 1, not ${n}`,
    );
  return n;
}

export const functionKey = (fn: PairFunction) => `${fn.path}:${fn.function}`;

/** One pair on an anchor's menu, and which of its sides is the anchor. */
export interface Candidate {
  readonly pair: Pair;
  readonly anchor: "a" | "b";
}

export const anchorOf = ({ pair, anchor }: Candidate) => pair[anchor];
export const partnerOf = ({ pair, anchor }: Candidate) =>
  anchor === "a" ? pair.b : pair.a;

/** One anchor function and the candidate pairs it is judged against, best first. */
export interface Menu {
  readonly anchor: PairFunction;
  readonly candidates: readonly Candidate[];
}

/**
 * Every pair, each either on exactly one anchor's menu or skipped. `skipped` keeps the order the
 * pairs came in.
 */
export interface Menus {
  readonly menus: readonly Menu[];
  readonly skipped: readonly Pair[];
}

const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Highest `graphConfidence` first. A tie goes to the lower pair id, then to the lower pair of
 * function keys, so the ranking does not depend on the order the collapse report lists pairs in.
 */
const byRank = (x: Pair, y: Pair) =>
  y.graphConfidence - x.graphConfidence ||
  byText(x.id, y.id) ||
  byText(
    `${functionKey(x.a)}\u0000${functionKey(x.b)}`,
    `${functionKey(y.a)}\u0000${functionKey(y.b)}`,
  );

/**
 * Deal the pairs out to anchors. Functions are taken in order of how many pairs they appear in,
 * most first, a tie going to the lower `path:function`. Each takes every pair not already on an
 * earlier anchor's menu, so no pair is asked twice. It keeps its top `max` by `byRank` and the rest
 * are skipped, never dropped. A function left with no pair is no anchor.
 */
export function anchorMenus(pairs: readonly Pair[], max: number): Menus {
  const cap = maxPartners(max);
  const byFunction = new Map<string, Pair[]>();
  for (const pair of pairs)
    for (const key of new Set([functionKey(pair.a), functionKey(pair.b)]))
      byFunction.set(key, [...(byFunction.get(key) ?? []), pair]);
  const order = [...byFunction.keys()].sort(
    (x, y) =>
      (byFunction.get(y)?.length ?? 0) - (byFunction.get(x)?.length ?? 0) ||
      byText(x, y),
  );
  const dealt = new Set<Pair>();
  const outside = new Set<Pair>();
  const menus: Menu[] = [];
  for (const key of order) {
    const own = (byFunction.get(key) ?? [])
      .filter((pair) => !dealt.has(pair))
      .sort(byRank);
    if (own.length === 0) continue;
    for (const pair of own) dealt.add(pair);
    for (const pair of own.slice(cap)) outside.add(pair);
    const candidates = own.slice(0, cap).map(
      (pair): Candidate => ({
        pair,
        anchor: functionKey(pair.a) === key ? "a" : "b",
      }),
    );
    const [first] = candidates;
    if (first !== undefined)
      menus.push({ anchor: anchorOf(first), candidates });
  }
  return { menus, skipped: pairs.filter((pair) => outside.has(pair)) };
}
