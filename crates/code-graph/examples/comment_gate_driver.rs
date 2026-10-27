use demlik_code_graph::{
    comments::{
        ceilings::{CeilingInputError, CommentCeilings},
        config::CommentConfigResolution,
        gate::{CommentGateArgs, CommentGateError},
        ratchet::{CeilingDirection, CeilingViolation, RatchetRender, RatchetVerdict},
    },
    text::{JsString, JsValue},
    validation::InputIssue,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};
#[path = "support/number_input.rs"]
mod number_input;
use number_input::JsNumberInput;
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
fn optional_file<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<PathBuf>, D::Error> {
    PathBuf::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigInput {
    #[serde(default, deserialize_with = "optional_file")]
    file: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GateInput {
    root_absolute: PathBuf,
    repo_root: PathBuf,
    #[serde(default)]
    ci: bool,
    #[serde(default)]
    write_ceilings: bool,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderInput {
    root: PathBuf,
    ceilings: JsValue,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonInput {
    value: JsValue,
    #[serde(default)]
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum Direction {
    Exceeded,
    Slack,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Violation {
    scope: JsString,
    measured: JsNumberInput,
    ceiling: JsNumberInput,
    direction: Direction,
    delta: JsNumberInput,
    inherited: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Verdict {
    passed: bool,
    scopes_checked: usize,
    inherited_scopes: usize,
    default_ceiling: JsNumberInput,
    slack_points: JsNumberInput,
    violations: Vec<Violation>,
}
impl From<Verdict> for RatchetVerdict {
    fn from(verdict: Verdict) -> Self {
        Self {
            passed: verdict.passed,
            scopes_checked: verdict.scopes_checked,
            inherited_scopes: verdict.inherited_scopes,
            default_ceiling: verdict.default_ceiling.value(),
            slack_points: verdict.slack_points.value(),
            violations: verdict
                .violations
                .into_iter()
                .map(|row| CeilingViolation {
                    scope: row.scope,
                    measured: row.measured.value(),
                    ceiling: row.ceiling.value(),
                    direction: match row.direction {
                        Direction::Exceeded => CeilingDirection::Exceeded,
                        Direction::Slack => CeilingDirection::Slack,
                    },
                    delta: row.delta.value(),
                    inherited: row.inherited,
                })
                .collect(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictInput {
    verdict: Verdict,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    pretty: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GateOutput {
    exit_code: u8,
    emitted: Vec<JsString>,
    reports: Vec<JsString>,
}
#[derive(Serialize)]
struct ConfigOutput {
    ceilings: Option<CommentCeilings>,
    reports: Vec<JsString>,
}
#[derive(Serialize)]
struct RenderOutput {
    census: String,
    ratchet: RatchetRender,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue: Option<Box<InputIssue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<JsString>,
}
impl DriverError {
    fn new(kind: &'static str, message: impl Into<JsString>) -> Self {
        Self {
            kind,
            message: message.into(),
            issue: None,
            file: None,
        }
    }
    fn transport(error: impl std::fmt::Display) -> Self {
        Self::new("driver-error", error.to_string())
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self::new("backend-error", error.to_string())
    }
}
impl From<CeilingInputError> for DriverError {
    fn from(error: CeilingInputError) -> Self {
        match error {
            CeilingInputError::Issue(issue) => Self {
                kind: "schema-issue",
                message: issue.message().clone(),
                issue: Some(Box::new(issue)),
                file: None,
            },
            CeilingInputError::TypeError(error) => Self::new("type-error", error.message().clone()),
        }
    }
}
impl From<CommentGateError> for DriverError {
    fn from(error: CommentGateError) -> Self {
        match error {
            CommentGateError::Record(error) => Self::new("type-error", error.message().clone()),
            CommentGateError::Write { file, source } => Self {
                kind: "write-error",
                message: source.to_string().into(),
                issue: None,
                file: Some(file.to_string_lossy().as_ref().into()),
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
fn input<T: for<'a> Deserialize<'a>>(value: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(value.get()).map_err(DriverError::transport)
}
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match case.operation.as_str() {
        "code_graph.comment_config" => {
            let input: ConfigInput = input(&case.input)?;
            let result = observe!(
                calls,
                demlik_code_graph::comments::config::resolve_comment_ceilings,
                input.file.as_deref()
            )
            .map_err(|error| DriverError::new("type-error", error.message().clone()))?;
            let output = match result {
                CommentConfigResolution::Resolved(ceilings) => ConfigOutput {
                    ceilings: Some(ceilings),
                    reports: Vec::new(),
                },
                CommentConfigResolution::Refused { message } => ConfigOutput {
                    ceilings: None,
                    reports: vec![message],
                },
            };
            to_raw_value(&output).map_err(DriverError::transport)
        }
        "code_graph.comment_gate" => {
            let input: GateInput = input(&case.input)?;
            let result = observe!(
                calls,
                demlik_code_graph::comments::gate::run_comment_gate,
                CommentGateArgs {
                    root_absolute: &input.root_absolute,
                    repo_root: &input.repo_root,
                    ci: input.ci,
                    write_ceilings: input.write_ceilings,
                    json: input.json,
                    pretty: input.pretty
                },
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(DriverError::backend)?
            )?;
            to_raw_value(&GateOutput {
                exit_code: result.exit_code,
                emitted: result.emitted,
                reports: result.reports,
            })
            .map_err(DriverError::transport)
        }
        "code_graph.comment_render" => {
            let input: RenderInput = input(&case.input)?;
            let census = observe!(
                calls,
                demlik_code_graph::comments::census::load_comment_census,
                &input.root,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(DriverError::backend)?
            )
            .map_err(DriverError::backend)?;
            let ceilings = observe!(
                calls,
                demlik_code_graph::comments::ceilings::CommentCeilings::parse,
                &input.ceilings
            )?;
            let verdict = observe!(
                calls,
                demlik_code_graph::comments::ratchet::evaluate_ratchet,
                &census,
                &ceilings,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(DriverError::backend)?
            )
            .map_err(DriverError::backend)?;
            let census = observe!(
                calls,
                demlik_code_graph::comments::render::render_comments,
                &census,
                input.json,
                input.pretty,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(DriverError::backend)?
            )
            .map_err(DriverError::backend)?;
            let ratchet = observe!(
                calls,
                demlik_code_graph::comments::ratchet::render_ratchet,
                &verdict,
                input.json,
                input.pretty
            )
            .map_err(DriverError::backend)?;
            to_raw_value(&RenderOutput { census, ratchet }).map_err(DriverError::transport)
        }
        "code_graph.comment_verdict_render" => {
            let input: VerdictInput = input(&case.input)?;
            let verdict = input.verdict.into();
            let output = observe!(
                calls,
                demlik_code_graph::comments::ratchet::render_ratchet,
                &verdict,
                input.json,
                input.pretty
            )
            .map_err(DriverError::backend)?;
            to_raw_value(&output).map_err(DriverError::transport)
        }
        "code_graph.stable_json" => {
            let input: JsonInput = input(&case.input)?;
            let output = observe!(
                calls,
                demlik_code_graph::render::json::stable_stringify,
                &input.value,
                input.pretty
            )
            .map_err(DriverError::backend)?;
            to_raw_value(&output).map_err(DriverError::transport)
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
