use demlik_code_graph::{
    boundaries::{
        deployables::census::{DeployableCensus, SiteRow, WorkerCensus},
        ledger::{BoundaryLedger, BoundaryLedgerEntry, ledger_key},
        libraries::census::LibraryCensus,
        migrate::CeilingBreach,
        reconcile::{Reconciliation, reconcile},
        render::{
            Censuses, render_accepted, render_boundaries, render_ledger_gate, render_migrated,
            render_migration_refused,
        },
        violation::{BoundaryViolation, ScopeBoundaryReport, WriteSite},
    },
    text::{JsString, JsValue},
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    sync::Arc,
};
macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result=$function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
struct Error {
    tag: &'static str,
    message: String,
}
impl Error {
    fn input(message: impl ToString) -> Self {
        Self {
            tag: "driver-error",
            message: message.to_string(),
        }
    }
}
type Result<T> = std::result::Result<T, Error>;
fn field<'a>(value: &'a JsValue, name: &str) -> Result<&'a JsValue> {
    value
        .get(name)
        .ok_or_else(|| Error::input(format!("missing field {name}")))
}
fn array(value: &JsValue) -> Result<&[JsValue]> {
    value
        .as_array()
        .ok_or_else(|| Error::input("expected array"))
}
fn object(value: &JsValue) -> Result<&IndexMap<JsString, JsValue>> {
    value
        .as_object()
        .ok_or_else(|| Error::input("expected object"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &JsValue) -> Result<T> {
    serde_json::from_str(&serde_json::to_string(value).map_err(Error::input)?).map_err(Error::input)
}
fn scalar(value: &JsValue) -> Result<f64> {
    match value {
        JsValue::Number(number) => Ok(*number),
        JsValue::String(text) if text == "nan" => Ok(f64::NAN),
        JsValue::String(text) if text == "inf" => Ok(f64::INFINITY),
        JsValue::String(text) if text == "-inf" => Ok(f64::NEG_INFINITY),
        JsValue::String(text) if text == "-0" => Ok(-0.0),
        _ => Err(Error::input("expected number or special-number token")),
    }
}
fn fields(value: &JsValue, names: &[&str]) -> Result<()> {
    let object = object(value)?;
    if object.len() != names.len()
        || names
            .iter()
            .any(|name| !object.contains_key(&JsString::from(*name)))
    {
        return Err(Error::input("unexpected or missing input field"));
    }
    Ok(())
}
fn same_fields(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Object(a), JsValue::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(name, value)| b.get(name).is_some_and(|other| same_fields(value, other)))
        }
        (JsValue::Array(a), JsValue::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_fields(a, b))
        }
        (JsValue::Object(_) | JsValue::Array(_), _)
        | (_, JsValue::Object(_) | JsValue::Array(_)) => false,
        _ => true,
    }
}
// Serde accepts unknown struct fields; the verification transport requires the canonical shape.
fn canonical_fields(input: &JsValue, canonical: &impl Serialize) -> Result<()> {
    let canonical = JsValue::parse(&serde_json::to_string(canonical).map_err(Error::input)?)
        .map_err(Error::input)?;
    if same_fields(input, &canonical) {
        Ok(())
    } else {
        Err(Error::input("unexpected, missing, or null optional field"))
    }
}
fn write(value: &JsValue) -> Result<WriteSite> {
    let write = WriteSite {
        file: decode(field(value, "file")?)?,
        line: scalar(field(value, "line")?)?,
        binding: decode(field(value, "binding")?)?,
    };
    canonical_fields(value, &write)?;
    Ok(write)
}
fn violation(value: &JsValue) -> Result<BoundaryViolation> {
    let line = value
        .get("write")
        .and_then(|write| write.get("line"))
        .map(scalar)
        .transpose()?;
    let mut normalized = value.clone();
    if let Some(JsValue::Object(write)) = normalized
        .as_object()
        .and_then(|object| object.get(&JsString::from("write")))
        .cloned()
    {
        let mut write = write;
        write.insert("line".into(), JsValue::Number(0.0));
        if let JsValue::Object(object) = &mut normalized {
            object.insert("write".into(), JsValue::Object(write));
        }
    }
    let mut violation: BoundaryViolation = decode(&normalized)?;
    if let (
        Some(line),
        BoundaryViolation::DrivingReachesDriven {
            write: Some(write), ..
        },
    ) = (line, &mut violation)
    {
        Arc::make_mut(write).line = line;
    }
    canonical_fields(value, &violation)?;
    Ok(violation)
}
fn report(value: &JsValue) -> Result<ScopeBoundaryReport> {
    let report = ScopeBoundaryReport {
        scope: decode(field(value, "scope")?)?,
        features: decode(field(value, "features")?)?,
        files_scanned: scalar(field(value, "filesScanned")?)?,
        violations: array(field(value, "violations")?)?
            .iter()
            .map(violation)
            .collect::<Result<_>>()?,
        workers: value
            .get("workers")
            .map(decode::<Vec<JsString>>)
            .transpose()?,
    };
    canonical_fields(value, &report)?;
    Ok(report)
}
fn reports(value: &JsValue) -> Result<Vec<ScopeBoundaryReport>> {
    array(value)?.iter().map(report).collect()
}
fn entry(value: &JsValue) -> Result<Arc<BoundaryLedgerEntry>> {
    let entry: BoundaryLedgerEntry = decode(value)?;
    canonical_fields(value, &entry)?;
    Ok(Arc::new(entry))
}
fn entries(value: &JsValue) -> Result<Vec<Arc<BoundaryLedgerEntry>>> {
    array(value)?.iter().map(entry).collect()
}
fn ledger(value: &JsValue) -> Result<BoundaryLedger> {
    fields(value, &["entries"])?;
    Ok(BoundaryLedger {
        entries: entries(field(value, "entries")?)?,
    })
}
fn library(value: &JsValue) -> Result<LibraryCensus> {
    let types = object(field(value, "types")?)?
        .iter()
        .map(|(name, value)| Ok((name.clone(), decode(value)?)))
        .collect::<Result<_>>()?;
    let library = LibraryCensus {
        types,
        undeclared: decode(field(value, "undeclared")?)?,
        unjudged_imports: scalar(field(value, "unjudgedImports")?)?,
    };
    canonical_fields(value, &library)?;
    Ok(library)
}
fn site(value: &JsValue) -> Result<SiteRow> {
    let site = SiteRow {
        file: decode(field(value, "file")?)?,
        line: scalar(field(value, "line")?)?,
        binding: decode(field(value, "binding")?)?,
    };
    canonical_fields(value, &site)?;
    Ok(site)
}
fn worker(value: &JsValue) -> Result<WorkerCensus> {
    let bindings = object(field(value, "bindings")?)?
        .iter()
        .map(|(name, value)| Ok((name.clone(), scalar(value)?)))
        .collect::<Result<_>>()?;
    let worker = WorkerCensus {
        worker: decode(field(value, "worker")?)?,
        files: decode(field(value, "files")?)?,
        bindings,
        sites: array(field(value, "sites")?)?
            .iter()
            .map(site)
            .collect::<Result<_>>()?,
    };
    canonical_fields(value, &worker)?;
    Ok(worker)
}
fn deployable(value: &JsValue) -> Result<DeployableCensus> {
    let deployable = DeployableCensus {
        workers: array(field(value, "workers")?)?
            .iter()
            .map(worker)
            .collect::<Result<_>>()?,
        unresolved_service_bindings: scalar(field(value, "unresolvedServiceBindings")?)?,
    };
    canonical_fields(value, &deployable)?;
    Ok(deployable)
}
fn censuses(value: &JsValue) -> Result<(Option<LibraryCensus>, Option<DeployableCensus>)> {
    fields(value, &["libraries", "deployables"])?;
    let optional = |name| -> Result<Option<&JsValue>> {
        let value = field(value, name)?;
        Ok((!matches!(value, JsValue::Null)).then_some(value))
    };
    Ok((
        optional("libraries")?.map(library).transpose()?,
        optional("deployables")?.map(deployable).transpose()?,
    ))
}
fn reconciliation(value: &JsValue, calls: &mut Vec<&'static str>) -> Result<Reconciliation> {
    let kind: JsString = decode(field(value, "kind")?)?;
    if kind == "reconciled" {
        fields(value, &["kind", "ledger", "reports", "under"])?;
        let ledger = ledger(field(value, "ledger")?)?;
        let reports = reports(field(value, "reports")?)?;
        let under: JsString = decode(field(value, "under")?)?;
        return Ok(observe!(calls, reconcile, &ledger, &reports, &under));
    }
    if kind != "opaque" {
        return Err(Error::input("unknown reconciliation kind"));
    }
    fields(
        value,
        &[
            "kind",
            "scopesChecked",
            "unrecorded",
            "pruned",
            "kept",
            "writes",
        ],
    )?;
    let scopes_checked = scalar(field(value, "scopesChecked")?)?;
    let unrecorded = entries(field(value, "unrecorded")?)?;
    let pruned = entries(field(value, "pruned")?)?;
    let kept = ledger(field(value, "kept")?)?;
    let writes = array(field(value, "writes")?)?
        .iter()
        .map(|row| {
            fields(row, &["entry", "write"])?;
            Ok((entry(field(row, "entry")?)?, write(field(row, "write")?)?))
        })
        .collect::<Result<Vec<_>>>()?;
    let writes = writes
        .into_iter()
        .map(|(entry, write)| (ledger_key(&entry), Arc::new(write)))
        .collect();
    Ok(Reconciliation {
        scopes_checked,
        unrecorded,
        pruned,
        kept,
        writes,
    })
}
fn breach(value: &JsValue) -> Result<CeilingBreach> {
    let breach = CeilingBreach {
        scope: decode(field(value, "scope")?)?,
        measured: scalar(field(value, "measured")?)?,
        ceiling: scalar(field(value, "ceiling")?)?,
    };
    canonical_fields(value, &breach)?;
    Ok(breach)
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>> {
    RawValue::from_string(serde_json::to_string(value).map_err(Error::input)?).map_err(Error::input)
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>> {
    let input = JsValue::parse(request.input.get()).map_err(Error::input)?;
    match request.operation.as_str() {
        "code_graph.boundary-render" => {
            fields(&input, &["reports", "under", "censuses", "json", "pretty"])?;
            let reports = reports(field(&input, "reports")?)?;
            let under: JsString = decode(field(&input, "under")?)?;
            let (libraries, deployables) = censuses(field(&input, "censuses")?)?;
            let json_flag: bool = decode(field(&input, "json")?)?;
            let pretty: bool = decode(field(&input, "pretty")?)?;
            json(
                &observe!(
                    calls,
                    render_boundaries,
                    &reports,
                    &under,
                    Censuses {
                        libraries: libraries.as_ref(),
                        deployables: deployables.as_ref()
                    },
                    json_flag,
                    pretty
                )
                .map_err(Error::input)?,
            )
        }
        "code_graph.boundary-ledger-render" | "code_graph.boundary-accepted-render" => {
            let accepted = request.operation == "code_graph.boundary-accepted-render";
            fields(
                &input,
                if accepted {
                    &["result", "reason", "json", "pretty"]
                } else {
                    &["result", "json", "pretty"]
                },
            )?;
            let reason = if accepted {
                Some(decode::<JsString>(field(&input, "reason")?)?)
            } else {
                None
            };
            let json_flag: bool = decode(field(&input, "json")?)?;
            let pretty: bool = decode(field(&input, "pretty")?)?;
            let result = reconciliation(field(&input, "result")?, calls)?;
            if let Some(reason) = reason {
                json(
                    &observe!(calls, render_accepted, &result, &reason, json_flag, pretty)
                        .map_err(Error::input)?,
                )
            } else {
                json(
                    &observe!(calls, render_ledger_gate, &result, json_flag, pretty)
                        .map_err(Error::input)?,
                )
            }
        }
        "code_graph.boundary-migrated-render" => {
            fields(&input, &["ledger", "scopes", "json", "pretty"])?;
            let ledger = ledger(field(&input, "ledger")?)?;
            let scopes = scalar(field(&input, "scopes")?)?;
            let json_flag: bool = decode(field(&input, "json")?)?;
            let pretty: bool = decode(field(&input, "pretty")?)?;
            json(
                &observe!(calls, render_migrated, &ledger, scopes, json_flag, pretty)
                    .map_err(Error::input)?,
            )
        }
        "code_graph.boundary-refusal-render" => {
            fields(&input, &["breaches"])?;
            let breaches = array(field(&input, "breaches")?)?
                .iter()
                .map(breach)
                .collect::<Result<Vec<_>>>()?;
            json(&observe!(calls, render_migration_refused, &breaches))
        }
        _ => Err(Error::input("unsupported operation")),
    }
}
fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut observed_calls = Vec::new();
        let result = request
            .map_err(Error::input)
            .and_then(|request| execute(&request, &mut observed_calls));
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<Error>,
            observed_calls: Vec<&'static str>,
        }
        let (ok, output, error) = match result {
            Ok(output) => (true, Some(output), None),
            Err(error) => (false, None, Some(error)),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok,
                output,
                error,
                observed_calls
            })?
        );
    }
    Ok(())
}
