import { distinctExternalCallers } from "../extract/edges.js";
import type { FunctionNode, PlanRow } from "../schema.js";

export type PlanAxis = "rot" | "impact" | "complexity" | "size";

export const PLAN_AXES: readonly PlanAxis[] = ["rot", "impact", "complexity", "size"];

export function isPlanAxis(value: string): value is PlanAxis {
  return (PLAN_AXES as readonly string[]).includes(value);
}

function scoreFor(row: Omit<PlanRow, "score">, axis: PlanAxis): number {
  const { smells: smellCount, complexity, fanIn } = row.components;
  const fan = fanIn ?? 0;
  switch (axis) {
    case "rot":
      return smellCount * 1000 + complexity * 10 + fan;
    case "impact":
      return fan * 1000 + complexity * 10 + smellCount;
    case "complexity":
      return complexity * 1000 + smellCount * 10 + fan;
    case "size":
      return row.loc;
  }
}

function toRow(fn: FunctionNode): Omit<PlanRow, "score"> {
  const fanIn = fn.edges ? distinctExternalCallers(fn.id, fn.edges.calledBy) : null;
  return {
    id: fn.id,
    file: fn.file,
    startLine: fn.startLine,
    endLine: fn.endLine,
    components: {
      smells: fn.smells.length,
      complexity: fn.complexity,
      fanIn,
    },
    loc: fn.loc,
    complexity: fn.complexity,
    calledByCount: fanIn,
    smells: fn.smells,
  };
}

const AXIS_KEYS: Record<PlanAxis, ((row: PlanRow) => number)[]> = {
  rot: [(r) => r.components.smells, (r) => r.components.complexity, (r) => r.components.fanIn ?? 0],
  impact: [
    (r) => r.components.fanIn ?? 0,
    (r) => r.components.complexity,
    (r) => r.components.smells,
  ],
  complexity: [
    (r) => r.components.complexity,
    (r) => r.components.smells,
    (r) => r.components.fanIn ?? 0,
  ],
  size: [(r) => r.loc],
};

function comparePrimary(a: PlanRow, b: PlanRow, axis: PlanAxis): number {
  for (const key of AXIS_KEYS[axis]) {
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compare(a: PlanRow, b: PlanRow, axis: PlanAxis): number {
  return (
    comparePrimary(a, b, axis) ||
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine ||
    a.id.localeCompare(b.id)
  );
}

export function rankPlan(functions: FunctionNode[], axis: PlanAxis): PlanRow[] {
  const rows: PlanRow[] = functions.map((fn) => {
    const base = toRow(fn);
    return { ...base, score: scoreFor(base, axis) };
  });
  rows.sort((a, b) => compare(a, b, axis));
  return rows;
}
