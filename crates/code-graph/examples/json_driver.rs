use demlik_code_graph::text::{JsString, JsValue};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::io::{self, BufRead};

macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    text: String,
    #[serde(default)]
    keys: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Lookup {
    key: JsString,
    present: bool,
    null: bool,
    prototype_property: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    value: JsValue,
    stringified: String,
    keys: Option<Vec<JsString>>,
    lookups: Vec<Lookup>,
    root_number_kind: Option<&'static str>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
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
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    if case.operation != "code_graph.json" {
        return Err(format!("unsupported operation: {}", case.operation));
    }
    let value = observe!(
        calls,
        demlik_code_graph::text::JsValue::parse,
        &case.input.text
    )
    .map_err(|error| error.to_string())?;
    let keys = observe!(calls, demlik_code_graph::text::JsValue::as_object, &value).map(|object| {
        observe!(calls, demlik_code_graph::text::object_keys, object)
            .into_iter()
            .cloned()
            .collect()
    });
    let mut lookups = Vec::new();
    for key in case.input.keys {
        let found = match key.to_utf8() {
            Ok(text) => observe!(calls, demlik_code_graph::text::JsValue::get, &value, &text),
            Err(_) => value.as_object().and_then(|object| object.get(&key)),
        };
        let prototype_property = observe!(
            calls,
            demlik_code_graph::text::has_object_prototype_property,
            &key
        );
        lookups.push(Lookup {
            key,
            present: found.is_some(),
            null: matches!(found, Some(JsValue::Null)),
            prototype_property,
        });
    }
    let root_number_kind = observe!(calls, demlik_code_graph::text::JsValue::as_number, &value)
        .map(|number| {
            if number == f64::INFINITY {
                "positive-infinity"
            } else if number == f64::NEG_INFINITY {
                "negative-infinity"
            } else if number == 0.0 && number.is_sign_negative() {
                "negative-zero"
            } else {
                "finite"
            }
        });
    let stringified = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    to_raw_value(&Output {
        value,
        stringified,
        keys,
        lookups,
        root_number_kind,
    })
    .map_err(|error| error.to_string())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(case, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(message) => Response {
                id,
                ok: false,
                output: None,
                error: Some(DriverError {
                    kind: "driver_error",
                    message,
                }),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
