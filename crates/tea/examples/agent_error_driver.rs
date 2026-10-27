//! Public built-in guard, exact error JSON and canonical description consumer.
use demlik_tea::{
    PlainData,
    agent::{
        StructuredOutputError, compaction::COMPACTION_SUMMARY_SCHEMA, types::AGENT_TURN_SCHEMA,
    },
    data::{JsText, JsonData, decode_json, stringify_json},
    resilience::resilient_call::CallValue,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    rc::Rc,
};

macro_rules! observe {($calls:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$calls.push(text(stringify!($f)));value}};}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    operation: String,
    value: Box<RawValue>,
    #[serde(default)]
    summary: bool,
}
fn object<const N: usize>(entries: [(&str, PlainData); N]) -> PlainData {
    PlainData::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(v: impl Into<JsText>) -> PlainData {
    PlainData::String(v.into())
}
fn describe(error: &StructuredOutputError, calls: &mut Vec<PlainData>) -> PlainData {
    let value = observe!(
        calls,
        demlik_tea::agent::StructuredOutputError::describe,
        error
    );
    match value {
        Ok(v) => object([("ok", PlainData::Bool(true)), ("value", text(v))]),
        Err(e) => object([
            ("ok", PlainData::Bool(false)),
            ("name", text(e.name)),
            ("message", text(e.message)),
        ]),
    }
}
fn run(input: Input) -> PlainData {
    let mut calls = vec![];
    let value = decode_json(input.value.get()).unwrap();
    let result = if input.operation == "plain" {
        let error = observe!(
            calls,
            serde_json::from_str::<StructuredOutputError>,
            input.value.get()
        )
        .unwrap();
        let described = describe(&error, &mut calls);
        let wire = observe!(calls, serde_json::to_string, &error).unwrap();
        let kind = match &error {
            StructuredOutputError::Live(_) => "live",
            StructuredOutputError::Plain(_) => "plain",
        };
        object([
            ("kind", text(kind)),
            ("wire", decode_json(&wire).unwrap()),
            ("description", described),
        ])
    } else {
        assert_eq!(input.operation, "guard");
        let original = Rc::new(value);
        let parsed = if input.summary {
            observe!(
                calls,
                demlik_tea::llm_call::Schema::parse,
                &COMPACTION_SUMMARY_SCHEMA,
                Rc::clone(&original)
            )
        } else {
            observe!(
                calls,
                demlik_tea::llm_call::Schema::parse,
                &AGENT_TURN_SCHEMA,
                Rc::clone(&original)
            )
        };
        match parsed {
            Ok(value) => object([
                ("ok", PlainData::Bool(true)),
                (
                    "sameOriginal",
                    PlainData::Bool(Rc::ptr_eq(&value, &original)),
                ),
                (
                    "value",
                    decode_json(&serde_json::to_string(&JsonData(&value)).unwrap()).unwrap(),
                ),
            ]),
            Err(CallValue::Shared(error)) => {
                let StructuredOutputError::Live(live) = error.as_ref() else {
                    panic!("fresh guard must be live")
                };
                let live_description = describe(&error, &mut calls);
                let wire = observe!(calls, serde_json::to_string, error.as_ref()).unwrap();
                let decoded =
                    observe!(calls, serde_json::from_str::<StructuredOutputError>, &wire).unwrap();
                let decoded_description = describe(&decoded, &mut calls);
                let kind = match decoded {
                    StructuredOutputError::Plain(_) => "plain",
                    StructuredOutputError::Live(_) => "live",
                };
                object([
                    ("ok", PlainData::Bool(false)),
                    ("name", text(live.name())),
                    ("message", text(live.message())),
                    ("liveDescription", live_description),
                    ("wire", decode_json(&wire).unwrap()),
                    ("decodedKind", text(kind)),
                    ("decodedDescription", decoded_description),
                    (
                        "nativeRejectedSame",
                        PlainData::Bool(Rc::ptr_eq(live.value(), &original)),
                    ),
                ])
            }
            Err(_) => panic!("owned guard rejection"),
        }
    };
    object([
        ("id", text(input.id)),
        ("result", result),
        ("calls", PlainData::Array(calls)),
    ])
}
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Input =
            serde_json::from_str(&line.unwrap()).expect("precise guard/error request");
        println!("{}", stringify_json(&run(request)).unwrap());
    }
}
