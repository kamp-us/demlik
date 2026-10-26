use demlik_code_graph::{
    boundaries::{
        config::{BoundaryConfigError, BoundaryConfigResolution, resolve_boundary_rules},
        gate::{BoundaryFlags, BoundaryGateArgs, BoundaryGateError, run_boundary_gate},
        rules::BoundaryRules,
    },
    text::JsString,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
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
fn some_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<JsString>, D::Error> {
    JsString::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigInput {
    #[serde(default, deserialize_with = "some_text")]
    file: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GateInput {
    root_absolute: PathBuf,
    repo_root: PathBuf,
    #[serde(default, deserialize_with = "some_text")]
    boundary_rules_file: Option<JsString>,
    ci: bool,
    write_ceilings: bool,
    accept_crossings: bool,
    #[serde(default, deserialize_with = "some_text")]
    reason: Option<JsString>,
    migrate_ceilings: bool,
    json: bool,
    pretty: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverError {
    kind: &'static str,
    name: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    io_kind: Option<&'static str>,
}
impl DriverError {
    fn input(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            name: "Error",
            message: error.to_string().into(),
            io_kind: None,
        }
    }
    fn thrown(name: &'static str, message: JsString) -> Self {
        Self {
            kind: "thrown",
            name,
            message,
            io_kind: None,
        }
    }
    fn io(error: io::Error) -> Self {
        Self {
            kind: "io-error",
            name: "Error",
            message: error.to_string().into(),
            io_kind: Some(match error.kind() {
                io::ErrorKind::NotFound => "not-found",
                io::ErrorKind::NotADirectory => "not-a-directory",
                io::ErrorKind::PermissionDenied => "permission-denied",
                io::ErrorKind::InvalidInput => "invalid-input",
                _ => "other-io",
            }),
        }
    }
}
impl From<BoundaryConfigError> for DriverError {
    fn from(error: BoundaryConfigError) -> Self {
        match error {
            BoundaryConfigError::RecordType(error) => {
                Self::thrown(error.name(), error.message().clone())
            }
            BoundaryConfigError::Declaration(error) => Self::thrown(error.name(), error.message()),
        }
    }
}
impl From<BoundaryGateError> for DriverError {
    fn from(error: BoundaryGateError) -> Self {
        match error {
            BoundaryGateError::Catalog(
                demlik_code_graph::extract::wrangler_config::CatalogError::WorkingDirectory(error),
            )
            | BoundaryGateError::Io(error) => Self::io(error),
            error => Self::thrown(error.name(), error.message()),
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
fn json(value: &impl Serialize) -> Result<Box<RawValue>, DriverError> {
    to_raw_value(value).map_err(DriverError::input)
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match request.operation.as_str() {
        "code_graph.boundary_rule_config" => {
            let input: ConfigInput =
                serde_json::from_str(request.input.get()).map_err(DriverError::input)?;
            #[derive(Serialize)]
            struct Output {
                rules: Option<Box<BoundaryRules>>,
                reports: Vec<JsString>,
            }
            json(
                &match observe!(calls, resolve_boundary_rules, input.file.as_ref())
                    .map_err(DriverError::from)?
                {
                    BoundaryConfigResolution::Resolved(rules) => Output {
                        rules: Some(rules),
                        reports: Vec::new(),
                    },
                    BoundaryConfigResolution::Refused { message } => Output {
                        rules: None,
                        reports: vec![message],
                    },
                },
            )
        }
        "code_graph.boundary_gate" => {
            let input: GateInput =
                serde_json::from_str(request.input.get()).map_err(DriverError::input)?;
            json(
                &observe!(
                    calls,
                    run_boundary_gate,
                    BoundaryGateArgs {
                        root_absolute: &input.root_absolute,
                        repo_root: &input.repo_root,
                        boundary_rules_file: input.boundary_rules_file.as_ref(),
                        flags: BoundaryFlags {
                            ci: input.ci,
                            write_ceilings: input.write_ceilings,
                            accept_crossings: input.accept_crossings,
                            reason: input.reason.as_ref(),
                            migrate_ceilings: input.migrate_ceilings
                        },
                        json: input.json,
                        pretty: input.pretty,
                    }
                )
                .map_err(DriverError::from)?,
            )
        }
        _ => Err(DriverError::input("unsupported operation")),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut observed_calls = Vec::new();
        let result = request
            .map_err(DriverError::input)
            .and_then(|request| execute(request, &mut observed_calls));
        let (ok, output, error) = match result {
            Ok(output) => (true, Some(output), None),
            Err(error) => (false, None, Some(error)),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
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
