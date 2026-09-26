import type { Pair, PairFunction } from "./collapse.js";

/** How many partners each function is judged against unless `--max-partners` names another count. */
export const DEFAULT_MAX_PARTNERS = 10;

/** A partner cap is a whole number of partners, at least one. */
export function maxPartners(n: number): number {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(
      `--max-partners is a whole number of at least 1, not ${n}`,
    );
  return n;
}

/** The pairs a cap keeps, in the order they came in, and every pair it skipped. Together they are all of them. */
export interface CappedPairs {
  readonly kept: readonly Pair[];
  readonly skipped: readonly Pair[];
}

export const functionKey = (fn: PairFunction) => `${fn.path}:${fn.function}`;

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
 * The top-`max` partners of every function. Each function ranks its pairs by `byRank`; a pair is
 * kept when it is within the top `max` of both its functions, so no function is judged against more
 * than `max` partners. Every other pair is skipped, never dropped.
 */
export function capPartners(pairs: readonly Pair[], max: number): CappedPairs {
  const cap = maxPartners(max);
  const ranked = [...pairs].sort(byRank);
  const taken = new Map<string, number>();
  const within = new Set<Pair>();
  const outside = new Set<Pair>();
  for (const pair of ranked) {
    const keys = [...new Set([functionKey(pair.a), functionKey(pair.b)])];
    const fits = keys.every((key) => (taken.get(key) ?? 0) < cap);
    for (const key of keys) taken.set(key, (taken.get(key) ?? 0) + 1);
    (fits ? within : outside).add(pair);
  }
  return {
    kept: pairs.filter((p) => within.has(p)),
    skipped: pairs.filter((p) => outside.has(p)),
  };
}
