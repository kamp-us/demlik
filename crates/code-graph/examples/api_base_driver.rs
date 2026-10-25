use demlik_code_graph::text::JsString;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::io::{self, BufRead};
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextInput {
    text: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsString>,
    observed_calls: Vec<&'static str>,
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    match request.operation.as_str() {
        "parse" => {
            let input: TextInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let value = observe!(
                calls,
                demlik_code_graph::api::ratchet::changesets::parse_changeset,
                &input.text
            );
            #[derive(Serialize)]
            struct Parsed<'a> {
                bumps: Vec<(&'a JsString, demlik_code_graph::api::model::Bump)>,
                body: &'a JsString,
            }
            let output = value.as_ref().map(|value| Parsed {
                bumps: value.bumps.iter().map(|(key, bump)| (key, *bump)).collect(),
                body: &value.body,
            });
            to_raw_value(&output).map_err(|error| error.to_string())
        }
        _ => Err("unsupported operation".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut calls = vec![];
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut calls));
        let (ok, output, error) = match result {
            Ok(output) => (true, Some(output), None),
            Err(error) => (false, None, Some(error.into())),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
                id,
                ok,
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
