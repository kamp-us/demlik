use demlik_code_graph::{
    layers::{
        analyze::{LayerAnalysisError, LayerReport},
        config::{LayerConfigResolution, resolve_layer_rules},
        gate::{LayerGateArgs, LayerGateError, run_layer_gate},
        render::render_layers,
        rules::AllowedEdge,
    },
    text::JsString,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.push(stringify!($function));value}};}
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
    layer_rules_file: Option<JsString>,
    json: bool,
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderInput {
    report: LayerReport,
    allowed: Vec<AllowedEdge>,
    json: bool,
    pretty: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverError {
    kind: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    io_kind: Option<&'static str>,
}
impl DriverError {
    fn input(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string().into(),
            io_kind: None,
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
            message: error.to_string().into(),
            io_kind: None,
        }
    }
}
impl From<LayerGateError> for DriverError {
    fn from(error: LayerGateError) -> Self {
        match error {
            LayerGateError::Analysis(LayerAnalysisError::Io(error)) => Self {
                kind: "io-error",
                message: error.to_string().into(),
                io_kind: Some(match error.kind() {
                    io::ErrorKind::NotFound => "not-found",
                    io::ErrorKind::NotADirectory => "not-a-directory",
                    io::ErrorKind::PermissionDenied => "permission-denied",
                    io::ErrorKind::InvalidInput => "invalid-input",
                    _ => "other-io",
                }),
            },
            error => Self::backend(error),
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
fn input<T: serde::de::DeserializeOwned>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::input)
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, DriverError> {
    to_raw_value(value).map_err(DriverError::backend)
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match request.operation.as_str() {
        "code_graph.layer_config" => {
            let input: ConfigInput = input(&request.input)?;
            #[derive(Serialize)]
            struct Output {
                rules: Option<demlik_code_graph::layers::rules::LayerRules>,
                reports: Vec<JsString>,
            }
            json(
                &match observe!(calls, resolve_layer_rules, input.file.as_ref()) {
                    LayerConfigResolution::Resolved(rules) => Output {
                        rules: Some(rules),
                        reports: Vec::new(),
                    },
                    LayerConfigResolution::Refused { message } => Output {
                        rules: None,
                        reports: vec![message],
                    },
                },
            )
        }
        "code_graph.layer_render" => {
            let input: RenderInput = input(&request.input)?;
            json(
                &observe!(
                    calls,
                    render_layers,
                    &input.report,
                    &input.allowed,
                    input.json,
                    input.pretty
                )
                .map_err(DriverError::backend)?,
            )
        }
        "code_graph.layer_gate" => {
            let input: GateInput = input(&request.input)?;
            json(
                &observe!(
                    calls,
                    run_layer_gate,
                    LayerGateArgs {
                        root_absolute: &input.root_absolute,
                        repo_root: &input.repo_root,
                        layer_rules_file: input.layer_rules_file.as_ref(),
                        json: input.json,
                        pretty: input.pretty
                    }
                )
                .map_err(DriverError::from)?,
            )
        }
        _ => Err(DriverError::input(format!(
            "unsupported operation: {}",
            request.operation
        ))),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().map(|request| request.id.clone()).ok();
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
