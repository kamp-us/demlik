import { stableStringify } from "../render/json.js";
import type { Graph } from "../schema.js";
import type { ChurnData, ChurnWindow } from "./churn.js";
import { churnFor } from "./churn.js";

export type HotspotRow = {
  file: string;
  churn: number | null;
  complexity: number;
  product: number | null;
};

export type HotspotsReport = {
  window: ChurnWindow;
  headSha: string;
  rows: HotspotRow[];
  noHistoryCount: number;
};

function complexityByFile(graph: Graph): Map<string, number> {
  const totals = new Map<string, number>();
  for (const fn of graph.functions) {
    totals.set(fn.file, (totals.get(fn.file) ?? 0) + fn.complexity);
  }
  return totals;
}

function compareRows(a: HotspotRow, b: HotspotRow): number {
  if (a.product === null && b.product === null) return a.file.localeCompare(b.file);
  if (a.product === null) return 1;
  if (b.product === null) return -1;
  return b.product - a.product || a.file.localeCompare(b.file);
}

export function computeHotspots(graph: Graph, churn: ChurnData): HotspotRow[] {
  const complexity = complexityByFile(graph);
  const rows: HotspotRow[] = graph.modules.map((mod) => {
    const cx = complexity.get(mod.file) ?? 0;
    const c = churnFor(churn, mod.file);
    return { file: mod.file, churn: c, complexity: cx, product: c === null ? null : c * cx };
  });
  rows.sort(compareRows);
  return rows;
}

function formatRow(row: HotspotRow, index: number): string {
  const rank = String(index + 1).padStart(3, " ");
  const churnStr = row.churn === null ? "no-history" : String(row.churn);
  return `${rank}. ${row.file}  churn=${churnStr} complexity=${row.complexity} product=${row.product ?? "—"}`;
}

function renderHuman(report: HotspotsReport, limit: number): string {
  const { window, headSha, rows, noHistoryCount } = report;
  const ranked = rows.filter((r) => r.product !== null);
  const head = [
    `Churn × complexity hotspots — window ${window.sinceIso} .. ${window.untilIso} (${window.days} days), HEAD ${headSha}`,
    `top ${Math.min(limit, ranked.length)} of ${ranked.length} ranked (${noHistoryCount} file(s) have no git history — excluded from ranking, listed separately)`,
  ].join("\n");
  if (ranked.length === 0 && noHistoryCount === 0) return `${head}\nNo files in scope.`;
  const body = ranked
    .slice(0, limit)
    .map((row, i) => formatRow(row, i))
    .join("\n");
  const noHistoryLines = rows
    .filter((r) => r.product === null)
    .map((r) => `  ${r.file}`)
    .join("\n");
  const noHistoryBlock =
    noHistoryCount > 0 ? `\nno git history (${noHistoryCount}):\n${noHistoryLines}` : "";
  return `${head}\n${body}${noHistoryBlock}`;
}

export function renderHotspots(
  graph: Graph,
  churn: ChurnData,
  window: ChurnWindow,
  limit: number,
  json: boolean,
  pretty: boolean,
): string {
  const rows = computeHotspots(graph, churn);
  const report: HotspotsReport = {
    window,
    headSha: churn.headSha,
    rows,
    noHistoryCount: rows.filter((r) => r.product === null).length,
  };
  if (json) return stableStringify(report, pretty);
  return renderHuman(report, limit);
}
