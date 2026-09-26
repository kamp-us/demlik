import type { GraphPull } from "./move/manifest.js";

/** One resolved relative import between two scope files: `from` imports `to`. Repo-relative. */
export type ImportEdge = { readonly from: string; readonly to: string };

/**
 * Each file's graph pull: its import edges, both directions, to neighbours Jev put in a named
 * feature, grouped by that neighbour's feature; the feature holding a strict majority is the pull.
 * An edge listed twice counts once, and a self-import not at all.
 */
export function graphPulls(
  edges: readonly ImportEdge[],
  featureOf: ReadonlyMap<string, string>,
): (path: string) => GraphPull {
  const counts = new Map<string, Map<string, number>>();
  const count = (file: string, neighbour: string) => {
    const feature = featureOf.get(neighbour);
    if (feature === undefined) return;
    const byFeature = counts.get(file) ?? new Map<string, number>();
    byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
    counts.set(file, byFeature);
  };
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    const key = JSON.stringify([from, to]);
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    count(from, to);
    count(to, from);
  }
  return (path) => {
    const byFeature = counts.get(path) ?? new Map<string, number>();
    const total = [...byFeature.values()].reduce((n, c) => n + c, 0);
    for (const [feature, n] of byFeature) {
      if (2 * n > total) return { feature, share: n / total, edges: total };
    }
    return { feature: null, edges: total };
  };
}

/**
 * Where a file lands given the feature Jev would move it to (named and at or above the floor) and
 * the feature the graph pulls it to: a move only when both name the same one, review when exactly
 * one names a feature or they name different ones, unlisted when neither does.
 */
export function agreementOf(
  jev: string | null,
  graph: string | null,
): "move" | "review" | "unlisted" {
  if (jev === null && graph === null) return "unlisted";
  return jev === graph ? "move" : "review";
}
