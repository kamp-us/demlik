import path from "node:path";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { scopeOf, scopesUnder } from "../ratchet/scope-count.js";
import { analyzeBoundaries, type ScopeAnalysis, type ScopeBoundaryReport } from "./analyze.js";
import { deployableCensus, type SiteRow } from "./deployables/census.js";
import { workerCycles } from "./deployables/cycles.js";
import type { Deployables } from "./deployables/deployables.js";
import { LEDGER_FILENAME } from "./ledger.js";
import { libraryCensus } from "./libraries/census.js";
import { libraryScopes } from "./libraries/libraries.js";
import {
  type Files,
  type LedgerOutput,
  type Measured,
  runAccept,
  runGate,
  runMigrate,
} from "./modes/runs.js";
import { type Censuses, renderBoundaries } from "./render.js";
import { type BoundaryRules, LEGACY_CEILINGS_FILENAME } from "./rules.js";
import { loadScope } from "./run/load.js";
import { GATE_READER, type Reads, readRun } from "./run/reads.js";

export type BoundaryFlags = {
  readonly ci: boolean;
  readonly writeCeilings: boolean;
  readonly acceptCrossings: boolean;
  readonly reason: string | undefined;
  readonly migrateCeilings: boolean;
};

export type BoundaryGateArgs = BoundaryFlags &
  LedgerOutput & {
    readonly rootAbsolute: string;
    readonly repoRoot: string;
    readonly boundaryRulesFile: string | undefined;
  };

type BoundaryMode =
  | { readonly kind: "report" }
  | { readonly kind: "gate" }
  | { readonly kind: "accept"; readonly reason: string }
  | { readonly kind: "migrate" };

function modeOf(flags: BoundaryFlags, report: Reporter): BoundaryMode | null {
  if (flags.writeCeilings) {
    report(
      "`--boundaries --write-ceilings` is retired: crossings live one per entry in " +
        `${LEDGER_FILENAME}. Add the current ones with \`--boundaries --accept-crossings --reason "<why>"\`.`,
    );
    return null;
  }
  const picked = [flags.ci, flags.acceptCrossings, flags.migrateCeilings].filter(Boolean).length;
  if (picked > 1) {
    report("pass one of --ci, --accept-crossings, --migrate-ceilings with --boundaries.");
    return null;
  }
  if (flags.reason !== undefined && !flags.acceptCrossings) {
    report("--reason only rides `--boundaries --accept-crossings`.");
    return null;
  }
  if (flags.acceptCrossings) {
    const reason = flags.reason?.trim() ?? "";
    if (reason === "") {
      report('`--accept-crossings` needs a non-empty `--reason "<why>"`; nothing was written.');
      return null;
    }
    return { kind: "accept", reason };
  }
  if (flags.migrateCeilings) return { kind: "migrate" };
  return flags.ci ? { kind: "gate" } : { kind: "report" };
}

function analyzeScope(
  scope: string,
  rules: BoundaryRules,
  reads: Reads,
  args: BoundaryGateArgs,
): ScopeAnalysis {
  return analyzeBoundaries(scope, loadScope(scope, rules, reads, args.repoRoot), rules, reads);
}

// The worker call graph is the repo's, not any scope's: its report is scope `.`, measured only by a
// run whose analyzed path is the repo root, as every scope's entries outside the analyzed path are
// left alone.
function graphReports(deployables: Deployables, under: string): ScopeBoundaryReport[] {
  if (!deployables.kinds.has("worker-call-cycle") || under !== ".") return [];
  const { workers } = deployables.graph;
  const violations = workerCycles(deployables.graph);
  return [{ scope: ".", features: [], filesScanned: 0, violations, workers }];
}

// What one run measured: each scope's report, the imports of undeclared packages its libraries
// left unjudged, and every binding site its scopes hold.
type Analysis = {
  readonly reports: ScopeBoundaryReport[];
  readonly unjudged: number;
  readonly sites: readonly SiteRow[];
};

function analyzeAll(
  scopes: readonly string[],
  rules: BoundaryRules,
  reads: Reads,
  under: string,
  args: BoundaryGateArgs,
): Analysis | null {
  try {
    const analyses = scopes.map((scope) => analyzeScope(scope, rules, reads, args));
    return {
      reports: [
        ...analyses.map((analysis) => analysis.report),
        ...graphReports(reads.deployables, under),
      ],
      unjudged: analyses.reduce((sum, analysis) => sum + analysis.unjudged, 0),
      sites: analyses.flatMap((analysis) => analysis.sites),
    };
  } catch (error) {
    args.report(error instanceof Error ? error.message : String(error));
    return null;
  }
}

// What the report says beside its violations, per key family: nothing for a family the rules file
// declares no key of.
function censusesOf(reads: Reads, analysis: Analysis): Censuses {
  const { reports, unjudged, sites } = analysis;
  return {
    libraries: libraryCensus(reads.libraries, {
      scopes: reports.map((report) => report.scope),
      undeclared: reports.flatMap((report) =>
        report.violations.filter((v) => v.kind === "library-undeclared").map((v) => v.from),
      ),
      unjudged,
    }),
    deployables: deployableCensus(reads.deployables, sites),
  };
}

export function runBoundaryGate(args: BoundaryGateArgs): number {
  const mode = modeOf(args, args.report);
  if (mode === null) return 2;
  const rules = resolveBoundaryRules(args.boundaryRulesFile, args.report);
  if (rules === null) return 2;
  const reads = readRun(rules, args.repoRoot, GATE_READER, args.report);
  if (reads === null) return 2;

  const files: Files = {
    ledger: path.join(args.repoRoot, LEDGER_FILENAME),
    legacy: path.join(args.repoRoot, LEGACY_CEILINGS_FILENAME),
  };
  const declared = [
    ...new Set([...Object.keys(rules.features), ...libraryScopes(reads.libraries)]),
  ];
  // The migration replaces the whole count file, so it measures every declared scope.
  if (mode.kind === "migrate") {
    return runMigrate(
      args,
      files,
      () => analyzeAll(scopesUnder(declared, "."), rules, reads, ".", args)?.reports ?? null,
    );
  }

  const under = scopeOf(args.repoRoot, args.rootAbsolute);
  const analysis = analyzeAll(scopesUnder(declared, under), rules, reads, under, args);
  if (analysis === null) return 2;
  const { reports } = analysis;
  const measured: Measured = { args, files, under, reports };
  switch (mode.kind) {
    case "report": {
      const censuses = censusesOf(reads, analysis);
      args.emit(`${renderBoundaries(reports, under, censuses, args.json, args.pretty)}\n`);
      return 0;
    }
    case "gate":
      return runGate(measured);
    case "accept":
      return runAccept(measured, mode.reason);
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
