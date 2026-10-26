use demlik_tea::{
    PlainData,
    agent::types::{AgentField, Conversation, TurnUsage},
    data::{JsText, JsonData, decode_json, plain_data, stringify_json},
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};}
type Conv = Conversation<PlainData, PlainData, PlainData, PlainData>;
fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(v: impl Into<JsText>) -> PlainData {
    PlainData::String(v.into())
}
fn flag(v: bool) -> PlainData {
    PlainData::Bool(v)
}
fn array(v: impl IntoIterator<Item = PlainData>) -> PlainData {
    PlainData::Array(v.into_iter().collect())
}
fn normalized(v: PlainData) -> PlainData {
    match v {
        PlainData::Undefined => object([("$undefined", flag(true))]),
        PlainData::Number(x) if !x.is_finite() || x == 0.0 && x.is_sign_negative() => object([(
            "$number",
            text(if x.is_nan() {
                "NaN"
            } else if x == f64::INFINITY {
                "Infinity"
            } else if x == f64::NEG_INFINITY {
                "-Infinity"
            } else {
                "-0"
            }),
        )]),
        PlainData::Array(xs) => array(xs.into_iter().map(normalized)),
        PlainData::Object(xs) => {
            PlainData::Object(xs.into_iter().map(|(k, v)| (k, normalized(v))).collect())
        }
        x => x,
    }
}
fn snapshot<T: Serialize>(v: &T) -> PlainData {
    let value = plain_data(v).unwrap();
    object([
        ("json", text(stringify_json(&value).unwrap())),
        ("value", normalized(value)),
    ])
}
fn conversation_snapshot(value: &Conv) -> PlainData {
    let mut data = plain_data(value).unwrap();
    if let PlainData::Object(fields) = &mut data {
        if matches!(value.legacy_usage, AgentField::Undefined) {
            fields.insert("usage".into(), PlainData::Undefined);
        }
        if matches!(value.context_tokens, AgentField::Undefined) {
            fields.insert("contextTokens".into(), PlainData::Undefined);
        }
    }
    object([
        ("json", text(stringify_json(&data).unwrap())),
        ("value", normalized(data)),
    ])
}
fn legacy(v: &Conv) -> &'static str {
    match &v.legacy_usage {
        AgentField::Absent => "absent",
        AgentField::Undefined => "undefined",
        AgentField::Value(None) => "null",
        AgentField::Value(Some(_)) => "value",
    }
}
fn override_legacy(v: &mut Conv, form: Option<&str>) -> Result<(), String> {
    match form {
        None => {}
        Some("absent") => v.legacy_usage = AgentField::Absent,
        Some("undefined") => v.legacy_usage = AgentField::Undefined,
        Some("null") => v.legacy_usage = AgentField::Value(None),
        _ => return Err("unknown legacy form".into()),
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsText,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyInput {
    encoded: String,
    legacy: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FoldInput {
    encoded: String,
    folding: String,
    summary: PlainData,
    legacy: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SumInput {
    left: String,
    right: String,
}
fn execute(req: &Request, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    match req.operation.as_str() {
        "defaults" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = serde_json::from_str(req.input.get()).map_err(|e| e.to_string())?;
            let a = observe!(calls, demlik_tea::agent::conversation::shared_no_usage);
            let b = observe!(calls, demlik_tea::agent::conversation::shared_no_usage);
            Ok(object([
                ("same", flag(Rc::ptr_eq(&a, &b))),
                ("usage", snapshot(a.as_ref())),
            ]))
        }
        "copy" => {
            let input: CopyInput =
                serde_json::from_str(req.input.get()).map_err(|e| e.to_string())?;
            let mut before: Conv =
                serde_json::from_str(&input.encoded).map_err(|e| e.to_string())?;
            override_legacy(&mut before, input.legacy.as_deref())?;
            let after = observe!(calls, std::clone::Clone::clone, &before);
            let usage_same = match (&before.legacy_usage, &after.legacy_usage) {
                (AgentField::Value(Some(a)), AgentField::Value(Some(b))) => Rc::ptr_eq(a, b),
                _ => legacy(&before) == legacy(&after),
            };
            Ok(object([
                ("before", conversation_snapshot(&before)),
                ("after", conversation_snapshot(&after)),
                (
                    "turnArraySame",
                    flag(Rc::ptr_eq(&before.turns, &after.turns)),
                ),
                (
                    "recordArraySame",
                    flag(Rc::ptr_eq(&before.tool_records, &after.tool_records)),
                ),
                (
                    "elementsSame",
                    flag(
                        before
                            .turns
                            .iter()
                            .zip(after.turns.iter())
                            .all(|(a, b)| Rc::ptr_eq(a, b)),
                    ),
                ),
                (
                    "outcomesSame",
                    flag(
                        before
                            .tool_records
                            .iter()
                            .zip(after.tool_records.iter())
                            .all(|(a, b)| Rc::ptr_eq(&a.outcome, &b.outcome)),
                    ),
                ),
                ("legacyBefore", text(legacy(&before))),
                ("legacyAfter", text(legacy(&after))),
                ("usageSame", flag(usage_same)),
            ]))
        }
        "sum" => {
            let input: SumInput =
                serde_json::from_str(req.input.get()).map_err(|e| e.to_string())?;
            let left: TurnUsage = serde_json::from_str(&input.left).map_err(|e| e.to_string())?;
            let right: TurnUsage = serde_json::from_str(&input.right).map_err(|e| e.to_string())?;
            let raw = decode_json(&input.left).map_err(|e| e.to_string())?;
            let guarded = observe!(calls, demlik_tea::agent::types::is_turn_usage, &raw);
            let out = observe!(
                calls,
                demlik_tea::agent::conversation::add_usage,
                &left,
                &right
            );
            Ok(object([
                ("left", snapshot(&left)),
                ("right", snapshot(&right)),
                ("sum", snapshot(&out)),
                ("leftGuard", flag(guarded)),
            ]))
        }
        "fold" => {
            let input: FoldInput =
                serde_json::from_str(req.input.get()).map_err(|e| e.to_string())?;
            let folding = match input.folding.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                "-0.5" => -0.5,
                "0" => 0.0,
                "1" => 1.0,
                "2" => 2.0,
                "50" => 50.0,
                _ => return Err("unknown folding".into()),
            };
            let mut before: Conv =
                serde_json::from_str(&input.encoded).map_err(|e| e.to_string())?;
            override_legacy(&mut before, input.legacy.as_deref())?;
            let summary = Rc::new(input.summary);
            let out = observe!(
                calls,
                demlik_tea::agent::conversation::fold_summary,
                &before,
                folding,
                Rc::clone(&summary)
            );
            let origins: Vec<_> = out
                .tool_records
                .iter()
                .map(|item| {
                    before
                        .tool_records
                        .iter()
                        .position(|r| {
                            Rc::ptr_eq(&r.call, &item.call) && Rc::ptr_eq(&r.outcome, &item.outcome)
                        })
                        .unwrap()
                })
                .collect();
            Ok(object([
                ("before", conversation_snapshot(&before)),
                ("after", conversation_snapshot(&out)),
                ("freshTurns", flag(!Rc::ptr_eq(&before.turns, &out.turns))),
                (
                    "freshRecords",
                    flag(!Rc::ptr_eq(&before.tool_records, &out.tool_records)),
                ),
                ("summarySame", flag(Rc::ptr_eq(&summary, &out.turns[0]))),
                (
                    "originalIndices",
                    array(origins.iter().map(|i| PlainData::Number(*i as f64))),
                ),
                (
                    "recordCopies",
                    flag(
                        out.tool_records
                            .iter()
                            .zip(origins.iter())
                            .all(|(r, i)| !Rc::ptr_eq(r, &before.tool_records[*i])),
                    ),
                ),
                ("legacyBefore", text(legacy(&before))),
                ("legacyAfter", text(legacy(&out))),
            ]))
        }
        _ => Err("unknown operation".into()),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: JsText,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    observed_calls: Vec<&'static str>,
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let req: Request = serde_json::from_str(&line).unwrap();
        let mut calls = vec![];
        let out = execute(&req, &mut calls);
        let response = match out {
            Ok(value) => Response {
                id: req.id,
                ok: true,
                output: Some(to_raw_value(&JsonData(&value)).unwrap()),
                error: None,
                observed_calls: calls,
            },
            Err(error) => Response {
                id: req.id,
                ok: false,
                output: None,
                error: Some(error),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response).unwrap());
    }
}
