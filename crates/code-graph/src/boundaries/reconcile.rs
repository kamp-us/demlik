//! Reconciliation only removes a recorded crossing within the requested scope.

use super::{
    ledger::{BoundaryLedger, BoundaryLedgerEntry, boundary_ledger_of, ledger_key},
    violation::{BoundaryViolation, ScopeBoundaryReport, WriteSite},
};
use crate::{
    project::{Collation, CollationError},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation {
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub scopes_checked: f64,
    pub unrecorded: Vec<Arc<BoundaryLedgerEntry>>,
    pub pruned: Vec<Arc<BoundaryLedgerEntry>>,
    pub kept: BoundaryLedger,
    pub writes: IndexMap<String, Arc<WriteSite>>,
}
pub fn entry_of(scope: impl Into<JsString>, violation: &BoundaryViolation) -> BoundaryLedgerEntry {
    violation.ledger_entry(scope)
}
pub fn measured_entries(
    reports: &[ScopeBoundaryReport],
    collation: &Collation,
) -> Result<Vec<Arc<BoundaryLedgerEntry>>, CollationError> {
    Ok(boundary_ledger_of(
        &reports
            .iter()
            .flat_map(|report| {
                report
                    .violations
                    .iter()
                    .map(|violation| Arc::new(entry_of(report.scope.clone(), violation)))
            })
            .collect::<Vec<_>>(),
        collation,
    )?
    .entries)
}
fn in_reach(scope: &JsString, under: &JsString) -> bool {
    if under == "." || scope == under {
        return true;
    }
    let mut prefix = under.units().to_vec();
    prefix.push(u16::from(b'/'));
    scope.units().starts_with(&prefix)
}
pub fn reconcile(
    ledger: &BoundaryLedger,
    reports: &[ScopeBoundaryReport],
    under: &JsString,
    collation: &Collation,
) -> Result<Reconciliation, CollationError> {
    let measured = measured_entries(reports, collation)?;
    let measured_keys = measured
        .iter()
        .map(|entry| ledger_key(entry))
        .collect::<HashSet<_>>();
    let recorded_keys = ledger
        .entries
        .iter()
        .map(|entry| ledger_key(entry))
        .collect::<HashSet<_>>();
    let gone = |entry: &BoundaryLedgerEntry| {
        in_reach(&entry.scope, under) && !measured_keys.contains(&ledger_key(entry))
    };
    let mut writes = IndexMap::new();
    for report in reports {
        for violation in &report.violations {
            if let Some(write) = violation.write() {
                writes.insert(
                    ledger_key(&entry_of(report.scope.clone(), violation)),
                    Arc::clone(write),
                );
            }
        }
    }
    Ok(Reconciliation {
        scopes_checked: reports.len() as f64,
        unrecorded: measured
            .into_iter()
            .filter(|entry| !recorded_keys.contains(&ledger_key(entry)))
            .collect(),
        pruned: ledger
            .entries
            .iter()
            .filter(|entry| gone(entry))
            .cloned()
            .collect(),
        kept: boundary_ledger_of(
            &ledger
                .entries
                .iter()
                .filter(|entry| !gone(entry))
                .cloned()
                .collect::<Vec<_>>(),
            collation,
        )?,
        writes,
    })
}
pub fn with_accepted(
    ledger: &BoundaryLedger,
    accepted: &[Arc<BoundaryLedgerEntry>],
    reason: &JsString,
    collation: &Collation,
) -> Result<BoundaryLedger, CollationError> {
    let entries = ledger
        .entries
        .iter()
        .cloned()
        .chain(accepted.iter().map(|entry| {
            Arc::new(BoundaryLedgerEntry {
                reason: Some(reason.clone()),
                ..(**entry).clone()
            })
        }))
        .collect::<Vec<_>>();
    boundary_ledger_of(&entries, collation)
}
