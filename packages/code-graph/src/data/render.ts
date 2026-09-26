import { stableStringify } from "../render/json.js";
import type { DataAccess, DataReport, Graph } from "../schema.js";

function accessTally(report: DataReport): string {
  const counts: Record<DataAccess, number> = { read: 0, unknown: 0, write: 0 };
  for (const e of report.edges) counts[e.access]++;
  return `${counts.read} read, ${counts.write} write, ${counts.unknown} unknown`;
}

function renderDataHuman(report: DataReport): string {
  const lines = [
    `data: ${report.edges.length} binding access sites (${accessTally(report)}) ` +
      `from ${report.configFiles.length} wrangler configs`,
  ];
  for (const c of report.unparsedConfigs) lines.push(`  UNPARSED CONFIG  ${c}`);
  for (const e of report.edges) {
    const via = e.method === null ? "" : `.${e.method}()`;
    lines.push(
      `  ${e.functionId}:${e.line}  ${e.ownerService}.env.${e.binding}${via} ` +
        `[${e.bindingKind}] ${e.access}`,
    );
  }
  return lines.join("\n");
}

export function renderData(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.data;
  if (report === null) return "data: pass did not run — add --data.";
  return json ? stableStringify(report, pretty) : renderDataHuman(report);
}
