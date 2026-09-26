import { stableStringify } from "../render/json.js";
import type { DataAccess, DataReport, DataSite, Graph } from "../schema.js";

function accessTally(report: DataReport): string {
  const counts: Record<DataAccess, number> = { read: 0, unknown: 0, write: 0 };
  for (const e of report.edges) counts[e.access]++;
  return `${counts.read} read, ${counts.write} write, ${counts.unknown} unknown`;
}

function siteText(s: DataSite): string {
  const via = s.method === null ? "" : `.${s.method}()`;
  return `${s.ownerService}.env.${s.binding}${via} [${s.bindingKind}] ${s.access}`;
}

function renderDataHuman(report: DataReport): string {
  const lines = [
    `data: ${report.edges.length} binding access sites (${accessTally(report)}) ` +
      `from ${report.configFiles.length} wrangler configs; ` +
      `${report.unattributed.length} unattributed (no named function holds them)`,
  ];
  for (const c of report.unparsedConfigs) lines.push(`  UNPARSED CONFIG  ${c}`);
  for (const e of report.edges) lines.push(`  ${e.functionId}:${e.line}  ${siteText(e)}`);
  for (const s of report.unattributed) {
    lines.push(`  UNATTRIBUTED  ${s.file}:${s.line}:${s.column}  ${siteText(s)}`);
  }
  return lines.join("\n");
}

export function renderData(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.data;
  if (report === null) return "data: pass did not run — add --data.";
  return json ? stableStringify(report, pretty) : renderDataHuman(report);
}
