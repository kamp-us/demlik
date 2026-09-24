import type { Graph, PlanRow } from "../schema.js";
import { type PlanAxis, rankPlan } from "../smells/plan.js";
import { stableStringify } from "./json.js";

const HUMAN_LIMIT = 20;

function formatRow(row: PlanRow, index: number): string {
  const rank = String(index + 1).padStart(3, " ");
  const kinds = row.smells.map((s) => s.kind).join(",") || "—";
  return [
    `${rank}. ${row.id}`,
    `     ${row.file}:${row.startLine}-${row.endLine}`,
    `     loc=${row.loc} cx=${row.complexity} fanIn=${row.calledByCount ?? "—"} smells=${row.components.smells} score=${row.score}`,
    `     [${kinds}]`,
  ].join("\n");
}

function renderHuman(rows: PlanRow[], axis: PlanAxis): string {
  if (rows.length === 0) return `No refactor targets (--by ${axis}).`;
  const head = `Refactor plan — ranked by ${axis} (top ${Math.min(HUMAN_LIMIT, rows.length)} of ${rows.length})`;
  const body = rows
    .slice(0, HUMAN_LIMIT)
    .map((row, i) => formatRow(row, i))
    .join("\n");
  return `${head}\n${body}`;
}

export function renderPlan(graph: Graph, axis: PlanAxis, json: boolean, pretty: boolean): string {
  const rows = rankPlan(graph.functions, axis);
  if (json) {
    return stableStringify(rows, pretty);
  }
  return renderHuman(rows, axis);
}
