import type { ScopeCountCeilings } from "../ratchet/scope-count.js";
import type { ScopeBoundaryReport } from "./analyze.js";
import { type BoundaryLedger, boundaryLedgerOf } from "./ledger.js";
import { measuredEntries } from "./reconcile.js";
import { LEGACY_CEILINGS_FILENAME } from "./rules.js";
import { type BoundaryKind, isDoorUse } from "./violation.js";

export type CeilingBreach = {
  readonly scope: string;
  readonly measured: number;
  readonly ceiling: number;
};

export type Migration =
  | { readonly kind: "migrated"; readonly ledger: BoundaryLedger }
  | { readonly kind: "refused"; readonly breaches: readonly CeilingBreach[] };

export const MIGRATED_REASON = `grandfathered from ${LEGACY_CEILINGS_FILENAME}`;

// The import crossings the count file ever held: B1-B4, B6 and B8, edges between feature files. A
// door, a feature's unknown entry and everything between packages (B11-B14), across deployables
// (B17-B19) or about a feature's own shape (B15, B16) were never counted, so a kind says here
// whether it was, and a new kind does not compile until it does.
const COUNTED = {
  "adapter-library-imported-outside-driven": false,
  "application-import-outside-allowlist": false,
  "application-imports-adapter": true,
  "binding-outside-driven-adapter": false,
  "cross-feature": true,
  "door-outside-driven-adapter": false,
  "door-outside-owner": false,
  "driving-reaches-driven": true,
  "impure-application": false,
  "impure-library": false,
  "impure-rules": true,
  "index-not-exports-only": false,
  "lib-imports-feature": true,
  "library-imports-up": false,
  "library-undeclared": false,
  "outside-imports-feature-internal": true,
  "relative-import-crosses-workspace": false,
  "unknown-zone": false,
  "worker-call-cycle": false,
} as const satisfies Record<BoundaryKind, boolean>;

function wasCounted(violation: { readonly kind: BoundaryKind; readonly global?: true }): boolean {
  return COUNTED[violation.kind] && !isDoorUse(violation);
}

// Counts carry no edges, so the ledger is seeded from the crossings measured now. The recorded
// counts gate that seed: a scope above its ceiling would carry a crossing the count never allowed,
// so the migration refuses rather than loosen. The count only ever measured import edges between
// feature files, so what it never counted (see `COUNTED`) is not held against it, and is seeded
// like the rest: a repo that predates the doors, the zones and the libraries would otherwise be
// refused for uses its count could not have recorded.
export function migratedLedger(
  reports: readonly ScopeBoundaryReport[],
  ceilings: ScopeCountCeilings,
): Migration {
  const breaches = reports
    .map((r) => ({
      scope: r.scope,
      measured: r.violations.filter(wasCounted).length,
      ceiling: ceilings.scopes[r.scope] ?? ceilings.default,
    }))
    .filter((b) => b.measured > b.ceiling);
  if (breaches.length > 0) return { kind: "refused", breaches };
  const entries = measuredEntries(reports).map((entry) => ({ ...entry, reason: MIGRATED_REASON }));
  return { kind: "migrated", ledger: boundaryLedgerOf(entries) };
}
