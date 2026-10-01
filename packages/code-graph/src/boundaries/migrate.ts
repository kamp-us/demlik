import type { ScopeCountCeilings } from "../ratchet/scope-count.js";
import { isDoorUse, type ScopeBoundaryReport } from "./analyze.js";
import { type BoundaryLedger, boundaryLedgerOf } from "./ledger.js";
import { measuredEntries } from "./reconcile.js";
import { LEGACY_CEILINGS_FILENAME } from "./rules.js";

export type CeilingBreach = {
  readonly scope: string;
  readonly measured: number;
  readonly ceiling: number;
};

export type Migration =
  | { readonly kind: "migrated"; readonly ledger: BoundaryLedger }
  | { readonly kind: "refused"; readonly breaches: readonly CeilingBreach[] };

export const MIGRATED_REASON = `grandfathered from ${LEGACY_CEILINGS_FILENAME}`;

// Counts carry no edges, so the ledger is seeded from the crossings measured now. The recorded
// counts gate that seed: a scope above its ceiling would carry a crossing the count never allowed,
// so the migration refuses rather than loosen. The count only ever measured import edges, so a
// world door used by name is not held against it, and is seeded like the rest: a repo that
// predates the doors would otherwise be refused for uses its count could not have recorded.
export function migratedLedger(
  reports: readonly ScopeBoundaryReport[],
  ceilings: ScopeCountCeilings,
): Migration {
  const breaches = reports
    .map((r) => ({
      scope: r.scope,
      measured: r.violations.filter((v) => !isDoorUse(v)).length,
      ceiling: ceilings.scopes[r.scope] ?? ceilings.default,
    }))
    .filter((b) => b.measured > b.ceiling);
  if (breaches.length > 0) return { kind: "refused", breaches };
  const entries = measuredEntries(reports).map((entry) => ({ ...entry, reason: MIGRATED_REASON }));
  return { kind: "migrated", ledger: boundaryLedgerOf(entries) };
}
