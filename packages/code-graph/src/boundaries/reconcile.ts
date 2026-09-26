import { scopesUnder } from "../ratchet/scope-count.js";
import type { BoundaryViolation, ScopeBoundaryReport } from "./analyze.js";
import {
  type BoundaryLedger,
  type BoundaryLedgerEntry,
  boundaryLedgerOf,
  ledgerKey,
} from "./ledger.js";

export function entryOf(scope: string, violation: BoundaryViolation): BoundaryLedgerEntry {
  return {
    scope,
    kind: violation.kind,
    from: violation.from,
    to: violation.to,
    specifier: violation.specifier,
  };
}

export function measuredEntries(reports: readonly ScopeBoundaryReport[]): BoundaryLedgerEntry[] {
  return boundaryLedgerOf(
    reports.flatMap((report) => report.violations.map((v) => entryOf(report.scope, v))),
  ).entries.slice();
}

// What one run found against the ledger. `kept` is the ledger minus `pruned`: the entries whose
// crossing is gone, among the scopes this run measured. An entry for a scope outside the analyzed
// path is out of reach and kept as it is.
export type Reconciliation = {
  readonly scopesChecked: number;
  readonly unrecorded: readonly BoundaryLedgerEntry[];
  readonly pruned: readonly BoundaryLedgerEntry[];
  readonly kept: BoundaryLedger;
};

export function reconcile(
  ledger: BoundaryLedger,
  reports: readonly ScopeBoundaryReport[],
  under: string,
): Reconciliation {
  const measured = measuredEntries(reports);
  const measuredKeys = new Set(measured.map(ledgerKey));
  const recordedKeys = new Set(ledger.entries.map(ledgerKey));
  const inReach = (entry: BoundaryLedgerEntry) => scopesUnder([entry.scope], under).length > 0;
  const gone = (entry: BoundaryLedgerEntry) =>
    inReach(entry) && !measuredKeys.has(ledgerKey(entry));
  return {
    scopesChecked: reports.length,
    unrecorded: measured.filter((entry) => !recordedKeys.has(ledgerKey(entry))),
    pruned: ledger.entries.filter(gone),
    kept: boundaryLedgerOf(ledger.entries.filter((entry) => !gone(entry))),
  };
}

export function withAccepted(
  ledger: BoundaryLedger,
  accepted: readonly BoundaryLedgerEntry[],
  reason: string,
): BoundaryLedger {
  return boundaryLedgerOf([...ledger.entries, ...accepted.map((entry) => ({ ...entry, reason }))]);
}
