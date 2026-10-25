use demlik_code_graph::{
    data::extract::Site,
    schema::{DataAccess, DataBindingKind},
    text::JsString,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::Path,
};
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessInput {
    kind: DataBindingKind,
    method: Option<JsString>,
    sql: Option<JsString>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    binding: JsString,
    kind: DataBindingKind,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SitesInput {
    file: String,
    source: String,
    bindings: Vec<(JsString, Decl)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessOutput {
    sql_access: DataAccess,
    access: DataAccess,
}
#[derive(Serialize)]
struct SitesOutput<'a> {
    sites: Vec<Site<'a, Decl>>,
    accesses: Vec<DataAccess>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
impl DriverError {
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string(),
        }
    }
    fn parse(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "parse-error",
            message: error.to_string(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DriverError>,
    observed_calls: Vec<&'static str>,
}
fn parse<T: for<'a> Deserialize<'a>>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::transport)
}
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match case.operation.as_str() {
        "code_graph.data_access" => {
            let input: AccessInput = parse(&case.input)?;
            let sql_access = observe!(
                calls,
                demlik_code_graph::data::access::sql_access,
                input.sql.as_ref()
            );
            let access = observe!(
                calls,
                demlik_code_graph::data::access::access_of,
                input.kind,
                input.method.as_ref(),
                input.sql.as_ref()
            );
            to_raw_value(&AccessOutput { sql_access, access }).map_err(DriverError::transport)
        }
        "code_graph.binding_sites" => {
            let input: SitesInput = parse(&case.input)?;
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file),
                &input.source
            )
            .map_err(DriverError::parse)?;
            let bindings: IndexMap<_, _> = input.bindings.into_iter().collect();
            let sites = observe!(
                calls,
                demlik_code_graph::data::extract::binding_sites,
                &syntax,
                &bindings
            );
            let accesses = sites
                .iter()
                .map(|site| {
                    observe!(
                        calls,
                        demlik_code_graph::data::access::access_of,
                        site.decl.kind,
                        site.method.as_ref(),
                        site.sql.as_ref()
                    )
                })
                .collect();
            to_raw_value(&SitesOutput { sites, accesses }).map_err(DriverError::transport)
        }
        _ => Err(DriverError::transport(format!(
            "unsupported operation: {}",
            case.operation
        ))),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(DriverError::transport)
            .and_then(|case| execute(case, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(error) => Response {
                id,
                ok: false,
                output: None,
                error: Some(error),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
