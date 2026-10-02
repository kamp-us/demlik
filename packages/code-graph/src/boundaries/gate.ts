import fs from "node:fs";
import path from "node:path";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { listRepo, loadEdgeProject, type RepoListing } from "../extract/project.js";
import { readScopeCeilings, scopeOf, scopesUnder } from "../ratchet/scope-count.js";
import { resolveImports, runtimeSpecifiers } from "../syntax/imports.js";
import {
  analyzeBoundaries,
  type BoundaryModule,
  type ScopeAnalysis,
  type ScopeBoundaryReport,
} from "./analyze.js";
import { bindingOwnerIssue, bindingSitesOf } from "./deployables/bindings.js";
import { deployableCensus, type SiteRow } from "./deployables/census.js";
import { workerCycles } from "./deployables/cycles.js";
import { type Deployables, readDeployables } from "./deployables/deployables.js";
import { declaresDeployables } from "./deployables/schema.js";
import { detectDoorUses } from "./door-uses.js";
import { unknownOwners } from "./doors.js";
import {
  type BoundaryLedger,
  LEDGER_FILENAME,
  readBoundaryLedger,
  writeBoundaryLedger,
} from "./ledger.js";
import { libraryCensus } from "./libraries/census.js";
import { type Libraries, libraryScopes, readLibraries } from "./libraries/libraries.js";
import { declaresLibraries } from "./libraries/schema.js";
import { migratedLedger } from "./migrate.js";
import type { ProcessMembers } from "./process-members.js";
import { reconcile, withAccepted } from "./reconcile.js";
import {
  type Censuses,
  renderAccepted,
  renderBoundaries,
  renderLedgerGate,
  renderMigrated,
  renderMigrationRefused,
} from "./render.js";
import { type BoundaryRules, LEGACY_CEILINGS_FILENAME } from "./rules.js";

export type BoundaryFlags = {
  readonly ci: boolean;
  readonly writeCeilings: boolean;
  readonly acceptCrossings: boolean;
  readonly reason: string | undefined;
  readonly migrateCeilings: boolean;
};

export type BoundaryGateArgs = BoundaryFlags & {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly boundaryRulesFile: string | undefined;
  readonly members?: ProcessMembers;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
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

// What a run reads once, before any scope is judged: the libraries and the deployables the rules
// file declares, and the repo's files listed once for both. A rules file that declares neither
// lists nothing, and each scope lists its own.
type Reads = {
  readonly libraries: Libraries;
  readonly deployables: Deployables;
  readonly listing: RepoListing | undefined;
};

// A scope's files are read when it declares features or is a declared library. A library root has
// none to judge: it holds the packages beneath it that no library names.
function readsFiles(scope: string, rules: BoundaryRules, libraries: Libraries): boolean {
  return rules.features[scope] !== undefined || libraries.typeOfDir.has(scope);
}

function loadModules(scope: string, reads: Reads, args: BoundaryGateArgs): BoundaryModule[] {
  const scopeAbsolute = scope === "." ? args.repoRoot : path.join(args.repoRoot, scope);
  const loaded = loadEdgeProject(scopeAbsolute, "package", args.repoRoot, reads.listing);
  const { importEdgesByFile } = resolveImports(
    loaded.rootAbsolute,
    loaded.sourceFiles,
    loaded.tsConfigPath,
  );
  return loaded.sourceFiles.map(({ file, syntax }) => ({
    file,
    importEdges: importEdgesByFile.get(file) ?? [],
    doorUses: detectDoorUses(syntax),
    runtimeSpecifiers: runtimeSpecifiers(syntax),
    bindingSites: bindingSitesOf(
      reads.deployables,
      scope === "." ? file : `${scope}/${file}`,
      syntax,
    ),
  }));
}

function analyzeScope(
  scope: string,
  rules: BoundaryRules,
  reads: Reads,
  args: BoundaryGateArgs,
): ScopeAnalysis {
  const modules = readsFiles(scope, rules, reads.libraries) ? loadModules(scope, reads, args) : [];
  const files = new Set(modules.map((module) => module.file));
  const unknown = unknownOwners(rules.doors[scope] ?? {}, files);
  if (unknown.length > 0) {
    throw new Error(
      `door owner(s) in "${scope}" name no file the scope loads: ${unknown.join("; ")}. ` +
        "An owner is an exact scope-relative .ts/.tsx path, such as src/env.ts.",
    );
  }
  const owners = rules.bindingOwners[scope] ?? {};
  const issue = bindingOwnerIssue(scope, owners, files, reads.deployables);
  if (issue !== null) throw new Error(issue);
  return analyzeBoundaries(scope, modules, rules, reads.libraries, reads.deployables);
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

type Files = { readonly ledger: string; readonly legacy: string };

// The ledger the gate and `--accept-crossings` read. A repo still on the count file has no ledger
// yet, and gating it against an empty one would pass nothing and fail everything, so it is refused.
function currentLedger(files: Files, report: Reporter): BoundaryLedger | null {
  const read = readBoundaryLedger(files.ledger);
  switch (read.kind) {
    case "read":
      return read.ledger;
    case "invalid":
      report(`invalid boundary ledger "${files.ledger}": ${read.message}`);
      return null;
    case "absent":
      if (fs.existsSync(files.legacy)) {
        report(
          `${LEGACY_CEILINGS_FILENAME} holds per-scope counts and there is no ${LEDGER_FILENAME}: ` +
            "run `code-graph . --boundaries --migrate-ceilings` once to seed the ledger.",
        );
        return null;
      }
      return { entries: [] };
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

type Measured = {
  readonly args: BoundaryGateArgs;
  readonly files: Files;
  readonly under: string;
  readonly reports: readonly ScopeBoundaryReport[];
};

function runGate({ args, files, under, reports }: Measured): number {
  const ledger = currentLedger(files, args.report);
  if (ledger === null) return 2;
  const result = reconcile(ledger, reports, under);
  if (result.pruned.length > 0) writeBoundaryLedger(files.ledger, result.kept);
  const { stdout, exitCode } = renderLedgerGate(result, args.json, args.pretty);
  args.emit(`${stdout}\n`);
  return exitCode;
}

function runAccept({ args, files, under, reports }: Measured, reason: string): number {
  const ledger = currentLedger(files, args.report);
  if (ledger === null) return 2;
  const result = reconcile(ledger, reports, under);
  if (result.pruned.length > 0 || result.unrecorded.length > 0) {
    writeBoundaryLedger(files.ledger, withAccepted(result.kept, result.unrecorded, reason));
  }
  args.emit(`${renderAccepted(result, reason, args.json, args.pretty)}\n`);
  return 0;
}

function runMigrate(
  args: BoundaryGateArgs,
  files: Files,
  measure: () => ScopeBoundaryReport[] | null,
): number {
  if (fs.existsSync(files.ledger)) {
    args.report(`${LEDGER_FILENAME} already exists; there is nothing to migrate.`);
    return 2;
  }
  if (!fs.existsSync(files.legacy)) {
    args.report(`no ${LEGACY_CEILINGS_FILENAME} at the repo root to migrate.`);
    return 2;
  }
  const ceilings = readScopeCeilings(files.legacy, args.report);
  if (ceilings === null) return 2;
  const reports = measure();
  if (reports === null) return 2;
  const migrated = migratedLedger(reports, ceilings);
  if (migrated.kind === "refused") {
    args.report(renderMigrationRefused(migrated.breaches));
    return 2;
  }
  writeBoundaryLedger(files.ledger, migrated.ledger);
  fs.rmSync(files.legacy);
  args.emit(`${renderMigrated(migrated.ledger, reports.length, args.json, args.pretty)}\n`);
  return 0;
}

// Reads the libraries and the deployables the rules file declares, or says in one line why it
// cannot: a declaration the repo cannot honour, or a wrangler config the listed kinds need and the
// run cannot parse. The repo's files are listed once, and only when one of the two is declared.
function readRun(rules: BoundaryRules, args: BoundaryGateArgs): Reads | null {
  const declares = declaresLibraries(rules) || declaresDeployables(rules);
  const listing = declares ? listRepo(args.repoRoot) : undefined;
  const read = readLibraries(rules, args.repoRoot, listing);
  if (read.kind === "refused") {
    args.report(read.message);
    return null;
  }
  const deployables = readDeployables(rules, args.repoRoot, listing);
  if (deployables.kind === "refused") {
    args.report(deployables.message);
    return null;
  }
  return { libraries: read.libraries, deployables: deployables.deployables, listing };
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
  const rules = resolveBoundaryRules(args.boundaryRulesFile, args.report, args.members);
  if (rules === null) return 2;
  const reads = readRun(rules, args);
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
