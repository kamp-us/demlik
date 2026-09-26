import fs from "node:fs";
import path from "node:path";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { loadEdgeProject } from "../extract/project.js";
import { readScopeCeilings, scopeOf, scopesUnder } from "../ratchet/scope-count.js";
import { resolveImports } from "../syntax/imports.js";
import { analyzeBoundaries, type ScopeBoundaryReport } from "./analyze.js";
import {
  type BoundaryLedger,
  LEDGER_FILENAME,
  readBoundaryLedger,
  writeBoundaryLedger,
} from "./ledger.js";
import { migratedLedger } from "./migrate.js";
import { reconcile, withAccepted } from "./reconcile.js";
import {
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

function analyzeScope(
  scope: string,
  rules: BoundaryRules,
  args: BoundaryGateArgs,
): ScopeBoundaryReport {
  const scopeAbsolute = scope === "." ? args.repoRoot : path.join(args.repoRoot, scope);
  const loaded = loadEdgeProject(scopeAbsolute, "package", args.repoRoot);
  const { importEdgesByFile } = resolveImports(
    loaded.rootAbsolute,
    loaded.sourceFiles,
    loaded.tsConfigPath,
  );
  const modules = loaded.sourceFiles.map(({ file }) => ({
    file,
    importEdges: importEdgesByFile.get(file) ?? [],
  }));
  return analyzeBoundaries(scope, modules, rules);
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

export function runBoundaryGate(args: BoundaryGateArgs): number {
  const mode = modeOf(args, args.report);
  if (mode === null) return 2;
  const rules = resolveBoundaryRules(args.boundaryRulesFile, args.report);
  if (rules === null) return 2;

  const files: Files = {
    ledger: path.join(args.repoRoot, LEDGER_FILENAME),
    legacy: path.join(args.repoRoot, LEGACY_CEILINGS_FILENAME),
  };
  const declared = Object.keys(rules.features);
  // The migration replaces the whole count file, so it measures every declared scope.
  if (mode.kind === "migrate") {
    return runMigrate(args, files, () => analyzeAll(scopesUnder(declared, "."), rules, args));
  }

  const under = scopeOf(args.repoRoot, args.rootAbsolute);
  const reports = analyzeAll(scopesUnder(declared, under), rules, args);
  if (reports === null) return 2;
  const measured: Measured = { args, files, under, reports };
  switch (mode.kind) {
    case "report":
      args.emit(`${renderBoundaries(reports, under, args.json, args.pretty)}\n`);
      return 0;
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
