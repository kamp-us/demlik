import fs from "node:fs";
import path from "node:path";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { listRepo, loadEdgeProject, type RepoListing } from "../extract/project.js";
import { loadBindingCatalog } from "../extract/wrangler-config.js";
import { scopeOf, scopesUnder } from "../ratchet/scope-count.js";
import { resolveImports, runtimeSpecifiers } from "../syntax/imports.js";
import {
  analyzeBoundaries,
  type BoundaryModule,
  type ScopeAnalysis,
  type ScopeBoundaryReport,
  type ScopeInputs,
} from "./analyze.js";
import { bindingOwnerIssue, bindingSitesOf } from "./deployables/bindings.js";
import { deployableCensus, type SiteRow } from "./deployables/census.js";
import { workerCycles } from "./deployables/cycles.js";
import { type Deployables, NO_CATALOG, readDeployables } from "./deployables/deployables.js";
import { declaresDeployables } from "./deployables/schema.js";
import { importsInSourceOrder } from "./deployables/workspaces.js";
import { detectImpureUses } from "./impure-uses.js";
import { interpreterFilesIssue } from "./interpreters/declaration.js";
import { LEDGER_FILENAME } from "./ledger.js";
import { allowanceIssue, importedNamesFor } from "./libraries/allowance.js";
import { libraryCensus } from "./libraries/census.js";
import { type Libraries, libraryScopes, readLibraries } from "./libraries/libraries.js";
import { declaresLibraries } from "./libraries/schema.js";
import {
  type Files,
  type LedgerOutput,
  type Measured,
  runAccept,
  runGate,
  runMigrate,
} from "./modes/runs.js";
import { readPackageFacts } from "./package-facts.js";
import { type Censuses, renderBoundaries } from "./render.js";
import {
  type BoundaryRules,
  inScope,
  LEGACY_CEILINGS_FILENAME,
  unlistedPortFolderIssue,
} from "./rules.js";
import { declaresReadAllowance } from "./shape/schema.js";
import { readShape, shapeFactsOf } from "./shape/shape.js";
import { readTables, tableFactsOf } from "./tables/tables.js";
import { unknownDriven } from "./zones/reads.js";

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

// What a run reads once, before any scope is judged: the libraries, the deployables, the shape and
// the table kinds the rules file declares, and the repo's files listed once for them. A rules file
// that needs none of that listing leaves it to each scope, which lists its own.
type Reads = ScopeInputs & { readonly listing: RepoListing | undefined };

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
  return loaded.sourceFiles.map(({ file, syntax }) => {
    const importEdges = importEdgesByFile.get(file) ?? [];
    return {
      file,
      importEdges: reads.deployables.kinds.has("package-import-crosses-deployable")
        ? importsInSourceOrder(syntax, importEdges)
        : importEdges,
      impureUses: detectImpureUses(syntax),
      runtimeSpecifiers: runtimeSpecifiers(syntax),
      importedNames: importedNamesFor(reads.libraries, scope, syntax),
      bindingSites: bindingSitesOf(reads.deployables, inScope(scope, file), syntax),
      tableFacts: tableFactsOf(reads.tables, syntax),
      ...shapeFactsOf(reads.shape, scope, file, syntax),
    };
  });
}

// The names of the entries directly under a scope's `src/`, none when it has no such directory.
function srcEntries(scope: string, repoRoot: string): string[] {
  try {
    return fs.readdirSync(path.join(repoRoot, scope, "src"));
  } catch {
    return [];
  }
}

function analyzeScope(
  scope: string,
  rules: BoundaryRules,
  reads: Reads,
  args: BoundaryGateArgs,
): ScopeAnalysis {
  const listed = rules.features[scope];
  const unlisted =
    listed === undefined
      ? null
      : unlistedPortFolderIssue(scope, listed, srcEntries(scope, args.repoRoot));
  if (unlisted !== null) throw new Error(unlisted);
  const modules = readsFiles(scope, rules, reads.libraries) ? loadModules(scope, reads, args) : [];
  const files = new Set(modules.map((module) => module.file));
  const owners = rules.bindingOwners[scope] ?? {};
  const issue =
    bindingOwnerIssue(scope, owners, files, reads.deployables) ??
    allowanceIssue(reads.libraries, scope, modules) ??
    interpreterFilesIssue(scope, rules.interpreters[scope] ?? {}, files);
  if (issue !== null) throw new Error(issue);
  const unread = unknownDriven(reads.shape.allowance, scope, files);
  if (unread.length > 0) {
    throw new Error(
      `driven file(s) of "readAllowance" in "${scope}" name no file the scope loads: ${unread.join("; ")}. ` +
        "A listed file is an exact scope-relative .ts/.tsx path.",
    );
  }
  return analyzeBoundaries(scope, modules, rules, reads);
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

// Reads the libraries, the deployables and the shape the rules file declares, or says in one line
// why it cannot: a declaration the repo cannot honour, or a wrangler config the listed kinds or a
// read allowance need and the run cannot parse. The repo's files are listed once, and only when a
// library key, a deployable kind or a read allowance is declared; the wrangler configs are read
// once, and only for the last two.
function readRun(rules: BoundaryRules, args: BoundaryGateArgs): Reads | null {
  const configs = declaresDeployables(rules) || declaresReadAllowance(rules);
  const listing = configs || declaresLibraries(rules) ? listRepo(args.repoRoot) : undefined;
  const catalog = configs ? loadBindingCatalog(args.repoRoot, listing) : NO_CATALOG;
  const packages = readPackageFacts(rules, args.repoRoot, listing);
  const read = readLibraries(rules, args.repoRoot, packages);
  if (read.kind === "refused") {
    args.report(read.message);
    return null;
  }
  const deployables = readDeployables(rules, packages, catalog);
  if (deployables.kind === "refused") {
    args.report(deployables.message);
    return null;
  }
  const shape = readShape(rules, catalog);
  if (shape.kind === "refused") {
    args.report(shape.message);
    return null;
  }
  return {
    libraries: read.libraries,
    deployables: deployables.deployables,
    shape: shape.shape,
    tables: readTables(rules),
    listing,
  };
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
