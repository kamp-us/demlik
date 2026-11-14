import path from "node:path";
import { findRepoRoot } from "../../extract/project.js";
import { scopeOf } from "../../ratchet/scope-count.js";
import { ApiInputError } from "../map.js";
import {
  type Ledger,
  type LedgerMeasurement,
  prunesEntries,
  readLedger,
  reconcileLedger,
  withAcceptedEntries,
  writeLedger,
} from "./keyed.js";
import { type LedgerRow, renderApiLedgerAccept, renderApiLedgerCheck } from "./text.js";

export type ApiLedgerMode =
  | { readonly kind: "check" }
  | { readonly kind: "accept"; readonly reason: string };

export type ApiLedgerRun = {
  readonly rootAbsolute: string;
  readonly mode: ApiLedgerMode;
  readonly json: boolean;
  readonly pretty: boolean;
};

export type ApiLedgerOutcome = { readonly payload: string; readonly code: number };

function readLedgerOrRefuse<Field extends string>(
  row: LedgerRow<Field>,
  file: string,
): Ledger<Field> {
  const read = readLedger(row, file);
  if (read.kind === "invalid") {
    throw new ApiInputError(
      `invalid ${row.labels.invalid} "${file}": ${read.message}; nothing was written.`,
    );
  }
  return read.kind === "read" ? read.ledger : { entries: [] };
}

export async function runApiLedger<Field extends string>(
  row: LedgerRow<Field>,
  run: ApiLedgerRun,
  measure: (
    scope: string,
    repoRoot: string,
  ) => LedgerMeasurement<Field> | Promise<LedgerMeasurement<Field>>,
): Promise<ApiLedgerOutcome> {
  const repoRoot = findRepoRoot(run.rootAbsolute);
  const file = path.join(repoRoot, row.filename);
  const ledger = readLedgerOrRefuse(row, file);
  const scope = scopeOf(repoRoot, run.rootAbsolute);
  const result = reconcileLedger(row, ledger, scope, await measure(scope, repoRoot));
  const { mode } = run;
  if (mode.kind === "accept") {
    if (prunesEntries(result) || result.unrecorded.length > 0) {
      writeLedger(row, file, withAcceptedEntries(row, result.kept, result.unrecorded, mode.reason));
    }
    return { payload: `${renderApiLedgerAccept(row, result, mode.reason, run)}\n`, code: 0 };
  }
  if (prunesEntries(result)) writeLedger(row, file, result.kept);
  return {
    payload: `${renderApiLedgerCheck(row, result, run)}\n`,
    code: result.unrecorded.length === 0 ? 0 : 1,
  };
}
