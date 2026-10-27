use demlik_code_graph::{
    comments::{
        ceilings::{CeilingInputError, CommentCeilings},
        census::CommentCensus,
        ratchet::RatchetVerdict,
    },
    text::{JsString, JsValue},
    validation::InputIssue,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[path = "support/number_input.rs"]
mod number_input;
use number_input::JsNumberInput as Scalar;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PointsInput {
    ratio: Scalar,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeInput {
    scope: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyInput {
    root: PathBuf,
    ceilings: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyValuesInput {
    root: PathBuf,
    default: Scalar,
    slack_points: Scalar,
    scopes: Vec<(JsString, Scalar)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumberOutput {
    value: JsValue,
    kind: &'static str,
    negative_zero: bool,
}
impl From<f64> for NumberOutput {
    fn from(value: f64) -> Self {
        Self {
            value: JsValue::Number(value),
            kind: if value.is_nan() {
                "NaN"
            } else if value == f64::INFINITY {
                "Infinity"
            } else if value == f64::NEG_INFINITY {
                "-Infinity"
            } else {
                "finite"
            },
            negative_zero: value == 0.0 && value.is_sign_negative(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PointsOutput {
    points: NumberOutput,
    ceiling_points: NumberOutput,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyOutput {
    census: CommentCensus,
    ceilings: CommentCeilings,
    recorded: CommentCeilings,
    verdict: RatchetVerdict,
    recorded_verdict: RatchetVerdict,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue: Option<Box<InputIssue>>,
}
impl DriverError {
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string().into(),
            issue: None,
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
            message: error.to_string().into(),
            issue: None,
        }
    }
}
impl From<CeilingInputError> for DriverError {
    fn from(error: CeilingInputError) -> Self {
        match error {
            CeilingInputError::Issue(issue) => Self {
                kind: "schema-issue",
                message: issue.message().clone(),
                issue: Some(Box::new(issue)),
            },
            CeilingInputError::TypeError(error) => Self {
                kind: "type-error",
                message: error.message().clone(),
                issue: None,
            },
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
fn input<T: for<'a> Deserialize<'a>>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::transport)
}
fn policy(
    root: &Path,
    ceilings: CommentCeilings,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, DriverError> {
    let census = observe!(
        calls,
        demlik_code_graph::comments::census::load_comment_census,
        root,
        &demlik_code_graph::project::Collation::try_node22_en_us().map_err(DriverError::backend)?
    )
    .map_err(DriverError::backend)?;
    let verdict = observe!(
        calls,
        demlik_code_graph::comments::ratchet::evaluate_ratchet,
        &census,
        &ceilings,
        &demlik_code_graph::project::Collation::try_node22_en_us().map_err(DriverError::backend)?
    )
    .map_err(DriverError::backend)?;
    let recorded = observe!(
        calls,
        demlik_code_graph::comments::ceilings::ceilings_from_census,
        &census,
        &ceilings
    );
    let recorded_verdict = observe!(
        calls,
        demlik_code_graph::comments::ratchet::evaluate_ratchet,
        &census,
        &recorded,
        &demlik_code_graph::project::Collation::try_node22_en_us().map_err(DriverError::backend)?
    )
    .map_err(DriverError::backend)?;
    to_raw_value(&PolicyOutput {
        census,
        ceilings,
        recorded,
        verdict,
        recorded_verdict,
    })
    .map_err(DriverError::transport)
}
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match case.operation.as_str() {
        "code_graph.comment_ceilings" => {
            let value: JsValue = input(&case.input)?;
            let ceilings = observe!(
                calls,
                demlik_code_graph::comments::ceilings::CommentCeilings::parse,
                &value
            )?;
            to_raw_value(&ceilings).map_err(DriverError::transport)
        }
        "code_graph.comment_points" => {
            let input: PointsInput = input(&case.input)?;
            let ratio = input.ratio.value();
            let points = observe!(
                calls,
                demlik_code_graph::comments::ceilings::to_points,
                ratio
            )
            .into();
            let ceiling_points = observe!(
                calls,
                demlik_code_graph::comments::ceilings::ceiling_points,
                ratio
            )
            .into();
            to_raw_value(&PointsOutput {
                points,
                ceiling_points,
            })
            .map_err(DriverError::transport)
        }
        "code_graph.comment_scope" => {
            let input: ScopeInput = input(&case.input)?;
            let governed = observe!(
                calls,
                demlik_code_graph::comments::ceilings::is_governed_scope,
                &input.scope
            );
            to_raw_value(&governed).map_err(DriverError::transport)
        }
        "code_graph.comment_policy" => {
            let input: PolicyInput = input(&case.input)?;
            let ceilings = observe!(
                calls,
                demlik_code_graph::comments::ceilings::CommentCeilings::parse,
                &input.ceilings
            )?;
            policy(&input.root, ceilings, calls)
        }
        "code_graph.comment_policy_values" => {
            let input: PolicyValuesInput = input(&case.input)?;
            let ceilings = CommentCeilings {
                default: input.default.value(),
                slack_points: input.slack_points.value(),
                scopes: input
                    .scopes
                    .into_iter()
                    .map(|(key, value)| (key, value.value()))
                    .collect(),
            };
            policy(&input.root, ceilings, calls)
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
