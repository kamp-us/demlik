import type { Layer } from "./rules.js";

export type LayerRank = {
  readonly name: string;
  readonly rank: number;
};

type Matcher = {
  readonly layer: LayerRank;
  readonly pattern: string;
  readonly regex: RegExp;
  readonly depth: number;
  readonly literals: number;
};

function compile(layer: LayerRank, pattern: string): Matcher {
  const segments = pattern.split("/");
  const body = segments
    .map((s) => (s === "*" ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return {
    layer,
    pattern,
    regex: new RegExp(`^${body}(/|$)`),
    depth: segments.length,
    literals: segments.filter((s) => s !== "*").length,
  };
}

export function compileMatchers(layers: readonly Layer[]): Matcher[] {
  const matchers: Matcher[] = [];
  layers.forEach((layer, rank) => {
    for (const pattern of layer.paths) {
      matchers.push(compile({ name: layer.name, rank }, pattern));
    }
  });
  matchers.sort(
    (a, b) => b.depth - a.depth || b.literals - a.literals || a.pattern.localeCompare(b.pattern),
  );
  return matchers;
}

export function layerOf(repoRelPath: string, matchers: readonly Matcher[]): LayerRank | null {
  for (const m of matchers) {
    if (m.regex.test(repoRelPath)) return m.layer;
  }
  return null;
}

export type EdgeDirection =
  | { readonly direction: "down" }
  /** Within one layer — always allowed. */
  | { readonly direction: "sideways" }
  /** Into a HIGHER layer — the violation. */
  | { readonly direction: "up" }
  /** At least one endpoint is outside the declared lattice — not judgeable. */
  | { readonly direction: "unlayered" };

export function directionOf(from: LayerRank | null, to: LayerRank | null): EdgeDirection {
  if (from === null || to === null) return { direction: "unlayered" };
  if (from.rank === to.rank) return { direction: "sideways" };
  return from.rank < to.rank ? { direction: "down" } : { direction: "up" };
}
