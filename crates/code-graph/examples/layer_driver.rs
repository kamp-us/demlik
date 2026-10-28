use demlik_code_graph::{
    layers::{
        analyze::{self, LayerAnalysisError, LayerReport},
        classify::{self, LayerRank, LayerTieError},
        reconcile,
        rules::{AllowedEdge, Layer, LayerRules},
    },
    project::load_cheap_project,
    text::{JsString, JsValue},
    validation::InputIssue,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::Path,
};
#[path = "support/number_input.rs"]
mod number_input;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.push(stringify!($function));value}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SchemaInput {
    schema: String,
    value: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SitesInput {
    sites: number_input::JsNumberInput,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClassifyInput {
    layers: Vec<Layer>,
    files: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectionInput {
    ranks: [Option<LayerRank>; 2],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnalyzeInput {
    root: String,
    repo_root: String,
    rules: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconcileInput {
    report: LayerReport,
    allowed: Vec<AllowedEdge>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairInput {
    from: JsString,
    to: JsString,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
impl DriverError {
    fn input(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string(),
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
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
fn input<T: serde::de::DeserializeOwned>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::input)
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, DriverError> {
    to_raw_value(value).map_err(DriverError::backend)
}
fn parsed<T: Serialize>(result: Result<T, InputIssue>) -> Result<Box<RawValue>, DriverError> {
    #[derive(Serialize)]
    struct Valid<T> {
        valid: bool,
        data: T,
    }
    #[derive(Serialize)]
    struct Invalid {
        valid: bool,
        issue: InputIssue,
    }
    match result {
        Ok(data) => json(&Valid { valid: true, data }),
        Err(issue) => json(&Invalid {
            valid: false,
            issue,
        }),
    }
}
fn tie(error: LayerTieError) -> Result<Box<RawValue>, DriverError> {
    #[derive(Serialize)]
    struct Thrown {
        name: &'static str,
        message: JsString,
        file: JsString,
        patterns: [JsString; 2],
    }
    #[derive(Serialize)]
    struct Failure {
        thrown: Thrown,
    }
    let message = error.message();
    json(&Failure {
        thrown: Thrown {
            name: "Error",
            message,
            file: error.file,
            patterns: error.patterns,
        },
    })
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match request.operation.as_str() {
        "code_graph.layer_schema" => {
            let input: SchemaInput = input(&request.input)?;
            match input.schema.as_str() {
                "layer" => parsed(observe!(calls, Layer::parse, &input.value)),
                "allowed" => parsed(observe!(calls, AllowedEdge::parse, &input.value)),
                "rules" => parsed(observe!(calls, LayerRules::parse, &input.value)),
                _ => Err(DriverError::input("unknown layer schema")),
            }
        }
        "code_graph.layer_sites_schema" => {
            let input: SitesInput = input(&request.input)?;
            let value = JsValue::Object(
                [
                    ("from".into(), JsValue::String("a".into())),
                    ("to".into(), JsValue::String("b".into())),
                    ("sites".into(), JsValue::Number(input.sites.value())),
                    ("reason".into(), JsValue::String("why".into())),
                ]
                .into_iter()
                .collect(),
            );
            parsed(observe!(calls, AllowedEdge::parse, &value))
        }
        "code_graph.layer_classify" => {
            let input: ClassifyInput = input(&request.input)?;
            let matchers = observe!(
                calls,
                classify::compile_matchers,
                &input.layers,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(DriverError::backend)?
            )
            .map_err(DriverError::backend)?;
            let mut values = Vec::new();
            for file in &input.files {
                values.push(match observe!(calls, classify::layer_of, file, &matchers) {
                    Ok(value) => json(&value)?,
                    Err(error) => tie(error)?,
                });
            }
            json(&values)
        }
        "code_graph.layer_direction" => {
            let input: DirectionInput = input(&request.input)?;
            json(&observe!(
                calls,
                classify::direction_of,
                input.ranks[0].as_ref(),
                input.ranks[1].as_ref()
            ))
        }
        "code_graph.layer_analyze" => {
            let input: AnalyzeInput = input(&request.input)?;
            let rules =
                observe!(calls, LayerRules::parse, &input.rules).map_err(DriverError::input)?;
            let collation = demlik_code_graph::project::Collation::try_node22_en_us()
                .map_err(DriverError::backend)?;
            let loaded = observe!(
                calls,
                load_cheap_project,
                Path::new(&input.root),
                None,
                &collation
            )
            .map_err(DriverError::backend)?;
            match observe!(
                calls,
                analyze::analyze_layers,
                &loaded,
                Path::new(&input.repo_root),
                &rules,
                &collation
            ) {
                Ok(report) => json(&report),
                Err(LayerAnalysisError::Tie(error)) => tie(error),
                Err(error) => Err(DriverError::backend(error)),
            }
        }
        "code_graph.layer_reconcile" => {
            let input: ReconcileInput = input(&request.input)?;
            json(
                &observe!(
                    calls,
                    reconcile::reconcile,
                    &input.report,
                    &input.allowed,
                    &demlik_code_graph::project::Collation::try_node22_en_us()
                        .map_err(DriverError::backend)?
                )
                .map_err(DriverError::backend)?,
            )
        }
        "code_graph.layer_edge_key" => {
            let input: PairInput = input(&request.input)?;
            json(&observe!(
                calls,
                reconcile::edge_key,
                &input.from,
                &input.to
            ))
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
