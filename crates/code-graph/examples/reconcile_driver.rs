use demlik_code_graph::{
    boundaries::{
        ledger::{BoundaryLedger, BoundaryLedgerEntry},
        migrate::{Migration, ScopeCountCeilings},
        reconcile::Reconciliation,
        violation::ScopeBoundaryReport,
    },
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    sync::Arc,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let returned = $function($($argument),*);
        $calls.push(stringify!($function));
        returned
    }};
}
#[derive(Deserialize)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    ledger: Vec<BoundaryLedgerEntry>,
    reports: Vec<ScopeBoundaryReport>,
    under: JsString,
    accepted: Vec<BoundaryLedgerEntry>,
    reason: JsString,
    ceilings: ScopeCountCeilings,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    entries: Vec<BoundaryLedgerEntry>,
    measured: Vec<Arc<BoundaryLedgerEntry>>,
    reconciliation: Reconciliation,
    accepted: BoundaryLedger,
    migration: Migration,
    crossings: Vec<demlik_code_graph::boundaries::violation::Crossing>,
    kept_owners: Vec<Option<usize>>,
    pruned_owners: Vec<Option<usize>>,
    write_owners: Vec<Option<usize>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    observed_calls: Vec<&'static str>,
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    if request.operation != "code_graph.reconcile" {
        return Err("unsupported operation".into());
    }
    let input: Input =
        serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
    let ledger = BoundaryLedger {
        entries: input.ledger.into_iter().map(Arc::new).collect(),
    };
    let mut entries = Vec::new();
    let mut crossings = Vec::new();
    for report in &input.reports {
        for violation in &report.violations {
            entries.push(observe!(
                calls,
                demlik_code_graph::boundaries::reconcile::entry_of,
                report.scope.clone(),
                violation
            ));
            crossings.push(observe!(
                calls,
                demlik_code_graph::boundaries::violation::crossing_of,
                violation.kind()
            ));
        }
    }
    let measured = observe!(
        calls,
        demlik_code_graph::boundaries::reconcile::measured_entries,
        &input.reports
    );
    let reconciliation = observe!(
        calls,
        demlik_code_graph::boundaries::reconcile::reconcile,
        &ledger,
        &input.reports,
        &input.under
    );
    let accepted = observe!(
        calls,
        demlik_code_graph::boundaries::reconcile::with_accepted,
        &ledger,
        &input.accepted.into_iter().map(Arc::new).collect::<Vec<_>>(),
        &input.reason
    );
    let migration = observe!(
        calls,
        demlik_code_graph::boundaries::migrate::migrated_ledger,
        &input.reports,
        &input.ceilings
    );
    let owner = |entry: &Arc<BoundaryLedgerEntry>| {
        ledger
            .entries
            .iter()
            .position(|original| Arc::ptr_eq(original, entry))
    };
    let kept_owners = reconciliation.kept.entries.iter().map(owner).collect();
    let pruned_owners = reconciliation.pruned.iter().map(owner).collect();
    let writes = input
        .reports
        .iter()
        .flat_map(|report| {
            report
                .violations
                .iter()
                .filter_map(|violation| violation.write())
        })
        .collect::<Vec<_>>();
    let write_owners = reconciliation
        .writes
        .values()
        .map(|held| {
            writes
                .iter()
                .position(|original| Arc::ptr_eq(original, held))
        })
        .collect();
    RawValue::from_string(
        serde_json::to_string(&Output {
            entries,
            measured,
            reconciliation,
            accepted,
            migration,
            crossings,
            kept_owners,
            pruned_owners,
            write_owners,
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
fn main() -> io::Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request = serde_json::from_str::<Request>(&line);
        let mut observed_calls = Vec::new();
        let result = request
            .as_ref()
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut observed_calls));
        let response = Response {
            id: request.as_ref().ok().map(|request| request.id.clone()),
            ok: result.is_ok(),
            error: result.as_ref().err().map(|_| "driver_error"),
            diagnostic: result.as_ref().err().cloned(),
            output: result.ok(),
            observed_calls,
        };
        println!(
            "{}",
            serde_json::to_string(&response).expect("response is JSON data")
        );
    }
    Ok(())
}
