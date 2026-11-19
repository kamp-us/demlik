import type { DuplicationSettings } from "./settings.js";

export type ClumpSet = { values: string[]; sites: number[] };

// Closed frequent itemsets retain a subgroup when it has more sites than its superset.
// Closure joins values with identical support without enumerating every subset of that group.
export function closedClumps(
  sites: readonly ReadonlySet<string>[],
  settings: DuplicationSettings,
): ClumpSet[] {
  const support = new Map<string, Set<number>>();
  sites.forEach((values, index) => {
    for (const value of values) {
      const held = support.get(value) ?? new Set<number>();
      held.add(index);
      support.set(value, held);
    }
  });
  const values = [...support.keys()]
    .filter((v) => (support.get(v)?.size ?? 0) >= settings.clumpMinSites)
    .sort();
  const closureOf = (extent: readonly number[]) =>
    new Set(values.filter((value) => extent.every((site) => support.get(value)?.has(site))));
  const result: ClumpSet[] = [];
  const visit = (intent: ReadonlySet<string>, extent: number[], start: number): void => {
    if (intent.size >= settings.clumpMinValues)
      result.push({ values: [...intent].sort(), sites: extent });
    for (let i = start; i < values.length; i += 1) {
      const value = values[i];
      if (value === undefined || intent.has(value)) continue;
      const next = extent.filter((site) => support.get(value)?.has(site));
      if (next.length < settings.clumpMinSites) continue;
      const closed = closureOf(next);
      if (values.slice(0, i).some((v) => closed.has(v) && !intent.has(v))) continue;
      visit(closed, next, i + 1);
    }
  };
  if (sites.length >= settings.clumpMinSites) {
    const extent = sites.map((_, index) => index);
    visit(closureOf(extent), extent, 0);
  }
  return result;
}
