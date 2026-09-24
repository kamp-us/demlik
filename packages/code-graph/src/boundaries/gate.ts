import fs from "node:fs";
import path from "node:path";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import {
  evaluateScopeRatchet,
  readScopeCeilings,
  recordScopeCeilings,
  scopeOf,
  scopesUnder,
} from "../ratchet/scope-count.js";
import { stableStringify } from "../render/json.js";
import type { Thresholds } from "../schema.js";
import { analyzeBoundaries, type ScopeBoundaryReport } from "./analyze.js";
import { renderBoundaries, renderBoundaryRatchet } from "./render.js";
import { type BoundaryRules, CEILINGS_FILENAME } from "./rules.js";

export type BoundaryGateArgs = {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly boundaryRulesFile: string | undefined;
  readonly ci: boolean;
  readonly writeCeilings: boolean;
  readonly thresholds: Thresholds;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
};

function analyzeScope(
  scope: string,
  rules: BoundaryRules,
  args: BoundaryGateArgs,
): ScopeBoundaryReport {
  const scopeAbsolute = scope === "." ? args.repoRoot : path.join(args.repoRoot, scope);
  const loaded = loadEdgeProject(scopeAbsolute, "package", args.repoRoot);
  const graph = assembleGraphWithEdges(loaded, args.thresholds, "package", loaded.tsConfigPath);
  return analyzeBoundaries(scope, graph.modules, rules);
}

function analyzeAll(
  scopes: readonly string[],
  rules: BoundaryRules,
  args: BoundaryGateArgs,
): ScopeBoundaryReport[] | null {
  try {
    return scopes.map((scope) => analyzeScope(scope, rules, args));
  } catch (error) {
    args.report(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function runBoundaryGate(args: BoundaryGateArgs): number {
  const rules = resolveBoundaryRules(args.boundaryRulesFile, args.report);
  if (rules === null) return 2;

  const under = scopeOf(args.repoRoot, args.rootAbsolute);
  const reports = analyzeAll(scopesUnder(Object.keys(rules.features), under), rules, args);
  if (reports === null) return 2;

  if (!args.ci && !args.writeCeilings) {
    args.emit(`${renderBoundaries(reports, under, args.json, args.pretty)}\n`);
    return 0;
  }

  const file = path.join(args.repoRoot, CEILINGS_FILENAME);
  const ceilings = readScopeCeilings(file, args.report);
  if (ceilings === null) return 2;
  const measurements = reports.map((r) => ({ scope: r.scope, count: r.violations.length }));

  if (args.writeCeilings) {
    const recorded = recordScopeCeilings(measurements, ceilings);
    fs.writeFileSync(file, `${stableStringify(recorded, true)}\n`);
    args.emit(`recorded ${measurements.length} scope ceiling(s) in ${file}\n`);
    return 0;
  }

  const { stdout, exitCode } = renderBoundaryRatchet(
    evaluateScopeRatchet(measurements, ceilings),
    args.json,
    args.pretty,
  );
  args.emit(`${stdout}\n`);
  return exitCode;
}
