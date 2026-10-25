use demlik_code_graph::{boundaries::rules::*, text::JsString};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};
macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*); $calls.push(stringify!($function)); result
    }};
}
#[derive(Deserialize)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    rules: BoundaryRules,
    scopes: Vec<JsString>,
    files: Vec<JsString>,
    folders: Vec<JsString>,
    held: Vec<JsString>,
}
#[derive(Serialize)]
struct ApiError {
    name: &'static str,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeRow {
    scope: JsString,
    zoning: Option<ScopeZoning>,
    features: Vec<Option<FeatureFile>>,
    places: Vec<Place>,
    located: Vec<JsString>,
    layout_issue: Option<JsString>,
    unlisted_issue: Option<JsString>,
    error: Option<ApiError>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    homes: &'static str,
    rows: Vec<ScopeRow>,
    rule_owners: Vec<Vec<Option<usize>>>,
    declared: [bool; 3],
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
    if request.operation != "code_graph.zoning" {
        return Err("unsupported operation".into());
    }
    let input: Input =
        serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    let mut owners = Vec::<&'static ZoneRule>::new();
    let mut rule_owners = Vec::new();
    for scope in input.scopes {
        let layout_issue = observe!(
            calls,
            demlik_code_graph::boundaries::rules::layout_issue,
            &scope,
            &input.folders
        );
        let unlisted_issue = observe!(
            calls,
            demlik_code_graph::boundaries::rules::unlisted_port_folder_issue,
            &scope,
            &input.folders,
            &input.held
        );
        let located = input
            .files
            .iter()
            .map(|file| {
                observe!(
                    calls,
                    demlik_code_graph::boundaries::rules::in_scope,
                    &scope,
                    file
                )
            })
            .collect();
        let zoning = observe!(
            calls,
            demlik_code_graph::boundaries::rules::scope_zoning,
            &input.rules,
            &scope
        );
        let mut features = Vec::new();
        let mut places = Vec::new();
        let mut own = Vec::new();
        let (zoning, error) = match zoning {
            Ok(zoning) => {
                for file in &input.files {
                    let feature = observe!(
                        calls,
                        demlik_code_graph::boundaries::rules::feature_file_of,
                        file,
                        &zoning
                    );
                    own.push(feature.as_ref().map(|feature| {
                        let rule = match feature {
                            FeatureFile::PerFeature { zone, .. } => zone.rule,
                            FeatureFile::Port { zone, .. } => zone.rule,
                        };
                        if let Some(index) =
                            owners.iter().position(|other| std::ptr::eq(*other, rule))
                        {
                            index
                        } else {
                            owners.push(rule);
                            owners.len() - 1
                        }
                    }));
                    features.push(feature);
                    places.push(observe!(
                        calls,
                        demlik_code_graph::boundaries::rules::place_of,
                        file,
                        &zoning
                    ));
                }
                (Some(zoning), None)
            }
            Err(error) => (
                None,
                Some(ApiError {
                    name: "TypeError",
                    message: error.to_string(),
                }),
            ),
        };
        rows.push(ScopeRow {
            scope,
            zoning,
            features,
            places,
            located,
            layout_issue,
            unlisted_issue,
            error,
        });
        rule_owners.push(own);
    }
    let declared = [
        observe!(
            calls,
            demlik_code_graph::boundaries::rules::declares_libraries,
            &input.rules
        ),
        observe!(
            calls,
            demlik_code_graph::boundaries::rules::declares_deployables,
            &input.rules
        ),
        observe!(
            calls,
            demlik_code_graph::boundaries::rules::declares_read_allowance,
            &input.rules
        ),
    ];
    let homes = demlik_code_graph::boundaries::rules::DRIVEN_HOMES.as_str();
    calls.push("demlik_code_graph::boundaries::rules::DRIVEN_HOMES");
    RawValue::from_string(
        serde_json::to_string(&Output {
            homes,
            rows,
            rule_owners,
            declared,
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
