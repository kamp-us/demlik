import fs from "node:fs";
import type { Reporter } from "../config.js";
import { readScopeCeilings } from "../ratchet/scope-count.js";
import type { ScopeBoundaryReport } from "./analyze.js";
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
  renderLedgerGate,
  renderMigrated,
  renderMigrationRefused,
} from "./render.js";
import { LEGACY_CEILINGS_FILENAME } from "./rules.js";

// What a ledger mode needs of the run: where it speaks and in what shape. The gate's own arguments
// carry these four beside the rest.
export type LedgerOutput = {
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
};

export type Files = { readonly ledger: string; readonly legacy: string };

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

export type Measured = {
  readonly args: LedgerOutput;
  readonly files: Files;
  readonly under: string;
  readonly reports: readonly ScopeBoundaryReport[];
};

export function runGate({ args, files, under, reports }: Measured): number {
  const ledger = currentLedger(files, args.report);
  if (ledger === null) return 2;
  const result = reconcile(ledger, reports, under);
  if (result.pruned.length > 0) writeBoundaryLedger(files.ledger, result.kept);
  const { stdout, exitCode } = renderLedgerGate(result, args.json, args.pretty);
  args.emit(`${stdout}\n`);
  return exitCode;
}

export function runAccept({ args, files, under, reports }: Measured, reason: string): number {
  const ledger = currentLedger(files, args.report);
  if (ledger === null) return 2;
  const result = reconcile(ledger, reports, under);
  if (result.pruned.length > 0 || result.unrecorded.length > 0) {
    writeBoundaryLedger(files.ledger, withAccepted(result.kept, result.unrecorded, reason));
  }
  args.emit(`${renderAccepted(result, reason, args.json, args.pretty)}\n`);
  return 0;
}

export function runMigrate(
  args: LedgerOutput,
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
