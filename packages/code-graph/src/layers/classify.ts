import type { Layer } from "./rules.js";

export type LayerRank = {
  readonly name: string;
  readonly rank: number;
};

type Specificity = {
  readonly depth: number;
  readonly literalSegments: number;
  readonly literalChars: number;
};

type Matcher = {
  readonly layer: LayerRank;
  readonly pattern: string;
  readonly regex: RegExp;
  readonly specificity: Specificity;
};

export class LayerTieError extends Error {
  constructor(
    readonly file: string,
    readonly patterns: readonly [string, string],
  ) {
    super(
      `"${file}" is claimed equally by layer patterns "${patterns[0]}" and "${patterns[1]}"; ` +
        "make one of them more specific.",
    );
  }
}

const ANY_SEGMENTS = "**";
const WHOLE_SEGMENT = "*";
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function segmentSource(segment: string): string {
  if (segment === WHOLE_SEGMENT) return "[^/]+";
  return segment
    .split("*")
    .map((literal) => literal.replace(REGEX_SPECIAL, "\\$&"))
    .join("[^/]*");
}

function prefixRegex(segments: readonly string[]): RegExp {
  const kept = [...segments];
  while (kept.at(-1) === ANY_SEGMENTS) kept.pop();
  if (kept.length === 0) return /^/;
  const body = kept
    .map((s) => (s === ANY_SEGMENTS ? "(?:[^/]+/)*" : `${segmentSource(s)}/`))
    .join("")
    .slice(0, -1);
  return new RegExp(`^${body}(/|$)`);
}

function specificityOf(pattern: string, segments: readonly string[]): Specificity {
  return {
    depth: segments.filter((s) => s !== ANY_SEGMENTS).length,
    literalSegments: segments.filter((s) => !s.includes("*")).length,
    literalChars: [...pattern].filter((c) => c !== "*" && c !== "/").length,
  };
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return (
    b.depth - a.depth || b.literalSegments - a.literalSegments || b.literalChars - a.literalChars
  );
}

function compile(layer: LayerRank, pattern: string): Matcher {
  const segments = pattern.split("/");
  return {
    layer,
    pattern,
    regex: prefixRegex(segments),
    specificity: specificityOf(pattern, segments),
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
    (a, b) =>
      compareSpecificity(a.specificity, b.specificity) || a.pattern.localeCompare(b.pattern),
  );
  return matchers;
}

export function layerOf(repoRelPath: string, matchers: readonly Matcher[]): LayerRank | null {
  const at = matchers.findIndex((m) => m.regex.test(repoRelPath));
  const winner = matchers[at];
  if (winner === undefined) return null;
  for (const rival of matchers.slice(at + 1)) {
    if (compareSpecificity(winner.specificity, rival.specificity) !== 0) break;
    if (rival.layer.rank !== winner.layer.rank && rival.regex.test(repoRelPath)) {
      throw new LayerTieError(repoRelPath, [winner.pattern, rival.pattern]);
    }
  }
  return winner.layer;
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
