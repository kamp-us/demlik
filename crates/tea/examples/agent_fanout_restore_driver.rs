use demlik_tea::{
    PlainData,
    data::{JsText, JsonData, decode_json, plain_data, stringify_json},
    flow::fan_out::FanOutState,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::io::{self, BufRead};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsText,
    encoded: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: JsText,
    output: Box<RawValue>,
    observed_calls: Vec<&'static str>,
}
fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn main() {
    for line in io::stdin().lock().lines() {
        let r: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let state: FanOutState<PlainData, PlainData, PlainData> =
            serde_json::from_str(&r.encoded).unwrap();
        let wire = stringify_json(&plain_data(&state).unwrap()).unwrap();
        let value = object([
            ("value", decode_json(&wire).unwrap()),
            (
                "doneUndefined",
                PlainData::Array(
                    state
                        .done
                        .iter()
                        .map(|v| PlainData::Bool(matches!(v.result.as_ref(), PlainData::Undefined)))
                        .collect(),
                ),
            ),
            (
                "failedUndefined",
                PlainData::Array(
                    state
                        .failed
                        .iter()
                        .map(|v| PlainData::Bool(matches!(v.error.as_ref(), PlainData::Undefined)))
                        .collect(),
                ),
            ),
        ]);
        println!(
            "{}",
            serde_json::to_string(&Response {
                id: r.id,
                output: to_raw_value(&JsonData(&value)).unwrap(),
                observed_calls: vec![
                    "serde::Deserialize::deserialize<demlik_tea::flow::fan_out::FanOutState>"
                ]
            })
            .unwrap()
        );
    }
}
