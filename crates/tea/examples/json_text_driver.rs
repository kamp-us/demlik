use demlik_tea::{
    PlainData,
    data::JsText,
    js_record::{JsRecord, RecordValue},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead};
macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    units: Vec<u16>,
}
fn text(value: &JsText) -> Value {
    match value.as_utf8() {
        Some(value) => json!(value),
        None => json!({"$utf16":value.as_units()}),
    }
}
fn normalize(value: &PlainData) -> Value {
    match value {
        PlainData::Null => Value::Null,
        PlainData::Undefined => json!({"$undefined":true}),
        PlainData::Bool(value) => json!(value),
        PlainData::Number(value) if !value.is_finite() => {
            json!({"$number":if value.is_nan(){"NaN"}else if value.is_sign_positive(){"Infinity"}else{"-Infinity"}})
        }
        PlainData::Number(value) if *value == 0.0 && value.is_sign_negative() => {
            json!({"$number":"-0"})
        }
        PlainData::Number(value) => json!(value),
        PlainData::String(value) => text(value),
        PlainData::Array(values) => Value::Array(values.iter().map(normalize).collect()),
        PlainData::Object(values) => {
            let record = JsRecord::<()>::from_data(values.clone());
            let entries = record
                .own_entries()
                .map(|(key, value)| {
                    let RecordValue::Data(value) = value else {
                        unreachable!()
                    };
                    (key, normalize(value))
                })
                .collect::<Vec<_>>();
            if entries.iter().any(|(key, _)| key.as_utf8().is_none()) {
                json!({"$object":entries.into_iter().map(|(key,value)|json!([text(key),value])).collect::<Vec<_>>()})
            } else {
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key.as_utf8().unwrap().into(), value))
                        .collect(),
                )
            }
        }
    }
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.expect("read request");
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                let mut observed = vec![];
                let result = observe!(
                    observed,
                    demlik_tea::data::decode_json_text,
                    &JsText::from_units(request.units)
                );
                match result {
                    Ok(value) => {
                        json!({"id":request.id,"ok":true,"value":normalize(&value),"observedCalls":observed})
                    }
                    Err(error) => {
                        json!({"id":request.id,"ok":false,"error":{"backend":"serde_json","message":error.to_string(),"category":format!("{:?}",error.classify())},"observedCalls":observed})
                    }
                }
            }
            Err(error) => json!({"protocolError":error.to_string()}),
        };
        println!("{response}");
    }
}
