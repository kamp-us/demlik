use super::{
    ledger::{BoundaryKind, BoundaryLedger, BoundaryLedgerEntry, boundary_ledger_of},
    reconcile::measured_entries,
    violation::ScopeBoundaryReport,
};
use crate::text::JsString;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const LEGACY_CEILINGS_FILENAME: &str = "boundary-ceilings.json";
pub const MIGRATED_REASON: &str = "grandfathered from boundary-ceilings.json";
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ScopeCountCeilings {
    pub default: f64,
    pub scopes: IndexMap<JsString, f64>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CeilingBreach {
    pub scope: JsString,
    pub measured: usize,
    pub ceiling: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Migration {
    Migrated { ledger: BoundaryLedger },
    Refused { breaches: Vec<CeilingBreach> },
}
fn counted(kind: BoundaryKind) -> bool {
    use BoundaryKind::*;
    match kind {
        ApplicationImportsAdapter
        | CrossFeature
        | DrivingReachesDriven
        | LibImportsFeature
        | OutsideImportsFeatureInternal => true,
        AdapterLibraryImportedOutsideDriven
        | ApplicationImportOutsideAllowlist
        | BindingOutsideDrivenAdapter
        | Impure
        | IndexNotExportsOnly
        | LibraryImportsUp
        | LibraryUndeclared
        | RelativeImportCrossesWorkspace
        | TestReachesCompositionRoot
        | UnknownZone
        | WorkerCallCycle => false,
    }
}
pub fn migrated_ledger(
    reports: &[ScopeBoundaryReport],
    ceilings: &ScopeCountCeilings,
) -> Migration {
    let breaches = reports
        .iter()
        .filter_map(|report| {
            let measured = report
                .violations
                .iter()
                .filter(|violation| counted(violation.kind()))
                .count();
            // The source's numeric record still inherits Object.prototype. An
            // inherited function/object compares as NaN; an own number wins.
            let ceiling = ceilings
                .scopes
                .get(&report.scope)
                .copied()
                .unwrap_or_else(|| {
                    const INHERITED: &[&str] = &[
                        "constructor",
                        "__defineGetter__",
                        "__defineSetter__",
                        "hasOwnProperty",
                        "__lookupGetter__",
                        "__lookupSetter__",
                        "isPrototypeOf",
                        "propertyIsEnumerable",
                        "toString",
                        "valueOf",
                        "__proto__",
                        "toLocaleString",
                    ];
                    if INHERITED.iter().any(|name| report.scope == *name) {
                        f64::NAN
                    } else {
                        ceilings.default
                    }
                });
            ((measured as f64) > ceiling).then(|| CeilingBreach {
                scope: report.scope.clone(),
                measured,
                ceiling,
            })
        })
        .collect::<Vec<_>>();
    if !breaches.is_empty() {
        return Migration::Refused { breaches };
    }
    let entries = measured_entries(reports)
        .into_iter()
        .map(|entry| {
            Arc::new(BoundaryLedgerEntry {
                reason: Some(MIGRATED_REASON.into()),
                ..(*entry).clone()
            })
        })
        .collect::<Vec<_>>();
    Migration::Migrated {
        ledger: boundary_ledger_of(&entries),
    }
}
