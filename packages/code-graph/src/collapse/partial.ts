import type { FunctionNode } from "../schema.js";
import type { CollapseSettings } from "./settings.js";

export type PartialTwin = {
  aId: string;
  aFile: string;
  aStartLine: number;
  aBlockLine: number;
  aDiverges: string;
  aDivergesLine: number;
  bId: string;
  bFile: string;
  bStartLine: number;
  bBlockLine: number;
  bDiverges: string;
  bDivergesLine: number;
  sharedBlock: string[];
  sharedConstants: string[];
};

type Sequence = {
  id: string;
  file: string;
  startLine: number;
  callees: string[];
  lines: number[];
  constArgsAt: string[][];
};

function toSequence(fn: FunctionNode): Sequence {
  const calls = fn.edges?.calls ?? [];
  return {
    id: fn.id,
    file: fn.file,
    startLine: fn.startLine,
    callees: calls.map((c) => c.calleeId),
    lines: calls.map((c) => c.line),
    constArgsAt: calls.map((c) => c.constArgs),
  };
}

type Run = { aStart: number; bStart: number; length: number };

function extendRun(a: Sequence, b: Sequence, aAt: number, bAt: number, width: number): Run {
  let aStart = aAt;
  let bStart = bAt;
  while (aStart > 0 && bStart > 0 && a.callees[aStart - 1] === b.callees[bStart - 1]) {
    aStart -= 1;
    bStart -= 1;
  }
  let aEnd = aAt + width;
  let bEnd = bAt + width;
  while (
    aEnd < a.callees.length &&
    bEnd < b.callees.length &&
    a.callees[aEnd] === b.callees[bEnd]
  ) {
    aEnd += 1;
    bEnd += 1;
  }
  return { aStart, bStart, length: aEnd - aStart };
}

function constantsSharedOverRun(a: Sequence, b: Sequence, run: Run): string[] {
  const shared = new Set<string>();
  for (let i = 0; i < run.length; i += 1) {
    const mine = a.constArgsAt[run.aStart + i] ?? [];
    const theirs = new Set(b.constArgsAt[run.bStart + i] ?? []);
    for (const name of mine) if (theirs.has(name)) shared.add(name);
  }
  return [...shared].sort((x, y) => x.localeCompare(y));
}

function toPartialTwin(
  a: Sequence,
  b: Sequence,
  run: Run,
  s: CollapseSettings,
): PartialTwin | null {
  const aNext = run.aStart + run.length;
  const bNext = run.bStart + run.length;
  const aDiverges = a.callees[aNext];
  const bDiverges = b.callees[bNext];
  if (aDiverges === undefined || bDiverges === undefined) return null;

  const sharedConstants = constantsSharedOverRun(a, b, run);
  if (sharedConstants.length < s.partialMinSharedConstants) return null;

  return {
    aId: a.id,
    aFile: a.file,
    aStartLine: a.startLine,
    aBlockLine: a.lines[run.aStart] ?? a.startLine,
    aDiverges,
    aDivergesLine: a.lines[aNext] ?? a.startLine,
    bId: b.id,
    bFile: b.file,
    bStartLine: b.startLine,
    bBlockLine: b.lines[run.bStart] ?? b.startLine,
    bDiverges,
    bDivergesLine: b.lines[bNext] ?? b.startLine,
    sharedBlock: a.callees.slice(run.aStart, run.aStart + run.length),
    sharedConstants,
  };
}

type Occurrence = { index: number; at: number };

function shingle(sequences: readonly Sequence[], width: number): Map<string, Occurrence[]> {
  const windows = new Map<string, Occurrence[]>();
  sequences.forEach((sequence, index) => {
    for (let at = 0; at + width <= sequence.callees.length; at += 1) {
      const key = sequence.callees.slice(at, at + width).join(" ");
      const bucket = windows.get(key);
      if (bucket === undefined) windows.set(key, [{ index, at }]);
      else bucket.push({ index, at });
    }
  });
  return windows;
}

function better(candidate: PartialTwin, held: PartialTwin): boolean {
  if (candidate.sharedBlock.length !== held.sharedBlock.length) {
    return candidate.sharedBlock.length > held.sharedBlock.length;
  }
  return candidate.sharedConstants.length > held.sharedConstants.length;
}

function keep(best: Map<string, PartialTwin>, twin: PartialTwin): void {
  const key = `${twin.aId}\u0000${twin.bId}`;
  const held = best.get(key);
  if (held === undefined || better(twin, held)) best.set(key, twin);
}

type Pair = { a: Sequence; b: Sequence; aAt: number; bAt: number };

function pairIn(
  bucket: readonly Occurrence[],
  i: number,
  j: number,
  sequences: readonly Sequence[],
): Pair | null {
  const left = bucket[i];
  const right = bucket[j];
  if (left === undefined || right === undefined || left.index === right.index) return null;
  const a = sequences[left.index];
  const b = sequences[right.index];
  if (a === undefined || b === undefined) return null;
  return { a, b, aAt: left.at, bAt: right.at };
}

function scanBucket(
  bucket: readonly Occurrence[],
  sequences: readonly Sequence[],
  s: CollapseSettings,
  best: Map<string, PartialTwin>,
): void {
  for (let i = 0; i < bucket.length; i += 1) {
    for (let j = i + 1; j < bucket.length; j += 1) {
      const pair = pairIn(bucket, i, j, sequences);
      if (pair === null) continue;
      const run = extendRun(pair.a, pair.b, pair.aAt, pair.bAt, s.partialMinPrefix);
      const twin = toPartialTwin(pair.a, pair.b, run, s);
      if (twin !== null) keep(best, twin);
    }
  }
}

function byBlockThenConstants(x: PartialTwin, y: PartialTwin): number {
  if (x.sharedBlock.length !== y.sharedBlock.length) {
    return y.sharedBlock.length - x.sharedBlock.length;
  }
  if (x.sharedConstants.length !== y.sharedConstants.length) {
    return y.sharedConstants.length - x.sharedConstants.length;
  }
  return x.aId.localeCompare(y.aId) || x.bId.localeCompare(y.bId);
}

export function findPartialTwins(
  candidates: readonly FunctionNode[],
  s: CollapseSettings,
): PartialTwin[] {
  const sequences = candidates.map(toSequence);
  const best = new Map<string, PartialTwin>();

  for (const bucket of shingle(sequences, s.partialMinPrefix).values()) {
    if (bucket.length < 2 || bucket.length > s.partialMaxBlockSize) continue;
    scanBucket(bucket, sequences, s, best);
  }

  return [...best.values()].sort(byBlockThenConstants);
}
