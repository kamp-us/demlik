import { stableStringify } from "../render/json.js";
import type { LayerEdge, LayerReport } from "./analyze.js";
import { type Reconciliation, reconcile } from "./reconcile.js";
import type { AllowedEdge } from "./rules.js";

function edgeLine(edge: LayerEdge): string {
  const tag = edge.typeOnly ? "  [type-only]" : "";
  return (
    `  ${edge.from}:${edge.fromLine}  ${edge.fromLayer} -> ${edge.toLayer}  ` +
    `${edge.to}:${edge.toLine}  ("${edge.specifier}")${tag}`
  );
}

function allowedLine(entry: AllowedEdge): string {
  return `  ${entry.from} -> ${entry.to}  (${entry.sites} sites)`;
}

function headerLines(report: LayerReport): string[] {
  const c = report.census;
  return [
    `layers: ${report.layers.join(" > ")}`,
    `scanned ${report.filesScanned} files — ${c.down} down, ${c.sideways} sideways, ` +
      `${c.up} UP, ${c.unlayered} unlayered, ${c.external} external, ${c.unresolved} unresolved`,
    ...report.unresolved.map((u) => `  UNRESOLVED  ${u}`),
    `violations (${report.violations.length} upward import sites):`,
  ];
}

function verdictLines(result: Reconciliation): string[] {
  if (result.passed) {
    return [
      `allowlist: OK — ${result.allowedSites} violating site(s), every one declared, ` +
        "and no declared entry is stale.",
    ];
  }
  const lines = ["LAYER GATE FAILED."];
  if (result.undeclared.length > 0) {
    lines.push(
      `  ${result.undeclared.length} undeclared violation(s) — an edge points UP the stack:`,
      ...result.undeclared.map(edgeLine),
      "  Fix: point the dependency down (move the shared thing into a lower layer, or",
      "  invert it behind a contract). If it cannot move in this PR, add the pair to the",
      "  `allowed` array in your --layer-rules file with its exact site count and a reason.",
    );
  }
  if (result.stale.length > 0) {
    lines.push(
      `  ${result.stale.length} declared violation(s) no longer exist — a closed violation`,
      "  must not keep its excuse, or the ratchet turns back into a baseline file:",
      ...result.stale.map(allowedLine),
      "  Fix: delete those entries from the `allowed` array in your --layer-rules file.",
    );
  }
  if (result.miscounted.length > 0) {
    lines.push(
      `  ${result.miscounted.length} declared violation(s) changed size — a new import on a`,
      "  known-bad pair is still new drift, and a removed one is still progress:",
      ...result.miscounted.map(
        (m) =>
          `  ${m.declared.from} -> ${m.declared.to}  declared ${m.declared.sites}, found ${m.actual}`,
      ),
      "  Fix: update `sites` in the `allowed` array in your --layer-rules file, or remove the import.",
    );
  }
  return lines;
}

export type LayerRender = {
  readonly stdout: string;
  readonly exitCode: number;
};

export function renderLayers(
  report: LayerReport,
  allowed: readonly AllowedEdge[],
  json: boolean,
  pretty: boolean,
): LayerRender {
  const result = reconcile(report, allowed);
  const exitCode = result.passed ? 0 : 1;
  if (json) {
    return {
      stdout: stableStringify(
        {
          layers: report.layers,
          filesScanned: report.filesScanned,
          census: report.census,
          unresolved: report.unresolved,
          violations: report.violations,
          passed: result.passed,
          undeclared: result.undeclared,
          stale: result.stale,
          miscounted: result.miscounted,
        },
        pretty,
      ),
      exitCode,
    };
  }
  const lines = [
    ...headerLines(report),
    ...report.violations.map(edgeLine),
    ...verdictLines(result),
  ];
  return { stdout: lines.join("\n"), exitCode };
}
