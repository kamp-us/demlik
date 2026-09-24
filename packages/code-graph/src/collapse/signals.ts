import type { FunctionNode } from "../schema.js";
import type { CollapseSettings } from "./settings.js";
import { nameTokens } from "./tokens.js";

export type Twin = {
  id: string;
  name: string;
  file: string;
  startLine: number;
  loc: number;
  complexity: number;
  nestingDepth: number;
  callees: ReadonlySet<string>;
  callers: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
};

export type Signal =
  | { signal: "shape"; strength: number; detail: string }
  | { signal: "callees"; strength: number; detail: string }
  | { signal: "callers"; strength: number; detail: string }
  | { signal: "name"; strength: number; detail: string };

export type SignalName = Signal["signal"];

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function toTwin(fn: FunctionNode): Twin {
  return {
    id: fn.id,
    name: fn.name,
    file: fn.file,
    startLine: fn.startLine,
    loc: fn.loc,
    complexity: fn.complexity,
    nestingDepth: fn.nestingDepth,
    callees: new Set((fn.edges?.calls ?? []).map((c) => c.calleeId)),
    callers: new Set((fn.edges?.calledBy ?? []).map((c) => c.callerId)),
    tokens: new Set(nameTokens(fn.name)),
  };
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const v of small) if (large.has(v)) n += 1;
  return n;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function closeness(delta: number, tolerance: number): number {
  return 1 - delta / (tolerance + 1);
}

export function shapeSignal(a: Twin, b: Twin, s: CollapseSettings): Signal | null {
  const locTolerance = Math.max(
    s.shapeLocSlack,
    Math.round(s.shapeLocRatio * Math.max(a.loc, b.loc)),
  );
  const locDelta = Math.abs(a.loc - b.loc);
  const cxDelta = Math.abs(a.complexity - b.complexity);
  const nestDelta = Math.abs(a.nestingDepth - b.nestingDepth);
  if (locDelta > locTolerance) return null;
  if (cxDelta > s.shapeComplexitySlack) return null;
  if (nestDelta > s.shapeNestingSlack) return null;
  const strength =
    (closeness(locDelta, locTolerance) +
      closeness(cxDelta, s.shapeComplexitySlack) +
      closeness(nestDelta, s.shapeNestingSlack)) /
    3;
  return {
    signal: "shape",
    strength: round4(strength),
    detail: `loc ${a.loc}/${b.loc} cx ${a.complexity}/${b.complexity} nest ${a.nestingDepth}/${b.nestingDepth}`,
  };
}

export function calleeSignal(a: Twin, b: Twin, s: CollapseSettings): Signal | null {
  if (a.callees.size < s.minSetSize || b.callees.size < s.minSetSize) return null;
  const score = jaccard(a.callees, b.callees);
  if (score < s.calleeJaccard) return null;
  return {
    signal: "callees",
    strength: round4(score),
    detail: `jaccard ${round4(score)} over ${a.callees.size}/${b.callees.size} callees`,
  };
}

export function callerSignal(a: Twin, b: Twin, s: CollapseSettings): Signal | null {
  if (a.callers.size < s.minSetSize || b.callers.size < s.minSetSize) return null;
  const score = jaccard(a.callers, b.callers);
  if (score < s.callerJaccard) return null;
  return {
    signal: "callers",
    strength: round4(score),
    detail: `jaccard ${round4(score)} over ${a.callers.size}/${b.callers.size} callers`,
  };
}

export function nameSignal(a: Twin, b: Twin, s: CollapseSettings): Signal | null {
  const smaller = Math.min(a.tokens.size, b.tokens.size);
  if (smaller === 0) return null;
  const shared = [...a.tokens].filter((t) => b.tokens.has(t)).sort((x, y) => x.localeCompare(y));
  if (!shared.some((t) => t.length >= s.nameMinTokenLength)) return null;
  const score = shared.length / smaller;
  if (score < s.nameOverlap) return null;
  return { signal: "name", strength: round4(score), detail: `shared {${shared.join(",")}}` };
}

export function firedSignals(a: Twin, b: Twin, s: CollapseSettings): Signal[] {
  return [
    shapeSignal(a, b, s),
    calleeSignal(a, b, s),
    callerSignal(a, b, s),
    nameSignal(a, b, s),
  ].filter((x): x is Signal => x !== null);
}
