use demlik_code_graph::{
    cli::{CliOptions, DefaultValue, OPTION_SPECS, OptionSource, ParseOutcome, ValueKind},
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};

macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParseInput {
    #[serde(rename = "action")]
    _action: String,
    argv: Vec<JsString>,
    help_width: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelpInput {
    #[serde(rename = "action")]
    _action: String,
    width: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetadataInput {
    #[serde(rename = "action")]
    _action: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    name: &'static str,
    code: &'static str,
    exit_code: u8,
    message: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseOutput<'a> {
    status: u8,
    exit: Option<Exit>,
    stdout: JsString,
    stderr: JsString,
    args: &'a [JsString],
    processed_args: &'a [JsString],
    opts: &'a CliOptions,
    keys: Vec<&'static str>,
    given: Vec<&'static str>,
    sources: Vec<(&'static str, Option<OptionSource>)>,
    target: Option<&'a JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    flags: &'static str,
    key: &'static str,
    description: String,
    required: bool,
    optional: bool,
    variadic: bool,
    short: Option<&'static str>,
    long: &'static str,
    default_value: Option<serde_json::Value>,
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    if request.operation != "code_graph.cli-parser" {
        return Err("unknown operation".into());
    }
    let input = JsValue::parse(request.input.get()).map_err(|error| error.to_string())?;
    let action = input
        .get("action")
        .and_then(JsValue::as_string)
        .ok_or("missing string action")?;
    match action
        .to_utf8()
        .map_err(|error| error.to_string())?
        .as_str()
    {
        "parse" => {
            let ParseInput {
                argv, help_width, ..
            } = serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let parsed = observe!(calls, demlik_code_graph::cli::parse, &argv, help_width);
            let output = ParseOutput {
                status: parsed.exit_code(),
                exit: parsed.exit().map(|exit| Exit {
                    name: exit.name,
                    code: exit.code,
                    exit_code: exit.exit_code,
                    message: exit.message,
                }),
                stdout: parsed.stdout(),
                stderr: parsed.stderr(),
                args: &parsed.arguments,
                processed_args: parsed.processed_arguments(),
                opts: &parsed.options,
                keys: parsed.options.keys().map(|id| id.key()).collect(),
                given: parsed.options.given().map(|id| id.key()).collect(),
                sources: OPTION_SPECS
                    .iter()
                    .map(|spec| (spec.key, parsed.options.source(spec.id)))
                    .collect(),
                target: matches!(parsed.outcome, ParseOutcome::Parsed)
                    .then(|| parsed.target())
                    .flatten(),
            };
            serde_json::value::to_raw_value(&output).map_err(|error| error.to_string())
        }
        "help" => {
            let HelpInput { width, .. } =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let text = observe!(calls, demlik_code_graph::cli::help_information, width);
            serde_json::value::to_raw_value(&text).map_err(|error| error.to_string())
        }
        "metadata" => {
            let _: MetadataInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            // The metadata is the actual parsing/help owner, not a driver copy.
            let rows = OPTION_SPECS
                .iter()
                .map(|spec| Metadata {
                    flags: spec.flags,
                    key: spec.key,
                    description: spec.description.text(),
                    required: spec.kind != ValueKind::Flag,
                    optional: false,
                    variadic: false,
                    short: None,
                    long: observe!(calls, demlik_code_graph::cli::OptionSpec::long, spec),
                    default_value: match spec.default {
                        DefaultValue::None => None,
                        DefaultValue::Text(value) => Some(value.into()),
                        DefaultValue::EmptyList => Some(serde_json::Value::Array(Vec::new())),
                    },
                })
                .collect::<Vec<_>>();
            serde_json::value::to_raw_value(&rows).map_err(|error| error.to_string())
        }
        _ => Err("unknown action".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request
            .as_ref()
            .ok()
            .map(|request| request.id.as_str().to_owned());
        let mut calls = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut calls));
        #[derive(Serialize)]
        struct DriverError {
            tag: &'static str,
            message: String,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<DriverError>,
            observed_calls: Vec<&'static str>,
        }
        let (output, error) = match result {
            Ok(value) => (Some(value), None),
            Err(message) => (
                None,
                Some(DriverError {
                    tag: "driver-error",
                    message,
                }),
            ),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok: output.is_some(),
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
