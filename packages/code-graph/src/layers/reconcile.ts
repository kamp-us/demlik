import type { LayerEdge, LayerReport } from "./analyze.js";
import type { AllowedEdge } from "./rules.js";

export function edgeKey(edge: { readonly from: string; readonly to: string }): string {
  return `${edge.from} ${edge.to}`;
}

export type MiscountedEdge = {
  readonly declared: AllowedEdge;
  readonly actual: number;
};

export type Reconciliation = {
  readonly passed: boolean;
  readonly undeclared: readonly LayerEdge[];
  readonly stale: readonly AllowedEdge[];
  readonly miscounted: readonly MiscountedEdge[];
  readonly allowedSites: number;
};

function sitesByPair(violations: readonly LayerEdge[]): Map<string, LayerEdge[]> {
  const byPair = new Map<string, LayerEdge[]>();
  for (const edge of violations) {
    const key = edgeKey(edge);
    const bucket = byPair.get(key);
    if (bucket === undefined) byPair.set(key, [edge]);
    else bucket.push(edge);
  }
  return byPair;
}

export function reconcile(report: LayerReport, allowed: readonly AllowedEdge[]): Reconciliation {
  const measured = sitesByPair(report.violations);
  const declared = new Map(allowed.map((a) => [edgeKey(a), a]));

  const undeclared: LayerEdge[] = [];
  const miscounted: MiscountedEdge[] = [];
  let allowedSites = 0;
  for (const [key, edges] of measured) {
    const entry = declared.get(key);
    if (entry === undefined) {
      undeclared.push(...edges);
      continue;
    }
    if (entry.sites !== edges.length) miscounted.push({ declared: entry, actual: edges.length });
    else allowedSites += edges.length;
  }

  const stale = allowed.filter((a) => !measured.has(edgeKey(a)));

  undeclared.sort((a, b) => a.from.localeCompare(b.from) || a.fromLine - b.fromLine);
  miscounted.sort((a, b) => edgeKey(a.declared).localeCompare(edgeKey(b.declared)));

  return {
    passed: undeclared.length === 0 && stale.length === 0 && miscounted.length === 0,
    undeclared,
    stale: [...stale].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    miscounted,
    allowedSites,
  };
}
