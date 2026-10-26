use demlik_tea::{
    PlainData,
    agent::{
        conversation::shared_no_usage,
        types::{AgentField, AgentState, AwaitingKind, TurnUsage},
    },
    data::{JsText, JsonData, decode_json, plain_data, stringify_json},
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let r=$function($($arg),*);$calls.push(stringify!($function));r}};}
type Model = AgentState<PlainData, JsText, PlainData, PlainData>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    encoded: String,
    operation: String,
    usage: String,
    legacy: String,
    context: String,
    failure: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsText,
    input: Input,
}
fn obj(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn b(x: bool) -> PlainData {
    PlainData::Bool(x)
}
fn s(x: &str) -> PlainData {
    PlainData::String(x.into())
}
fn kind<T>(value: &AgentField<Option<T>>) -> &'static str {
    match value {
        AgentField::Absent => "absent",
        AgentField::Undefined => "undefined",
        AgentField::Value(None) => "null",
        AgentField::Value(Some(_)) => "value",
    }
}
fn wire(v: &Model) -> String {
    stringify_json(&plain_data(v).unwrap()).unwrap()
}
fn view(v: &Model) -> PlainData {
    decode_json(&wire(v)).unwrap()
}
fn field_same<T>(a: &AgentField<Rc<T>>, c: &AgentField<Rc<T>>) -> bool {
    match (a, c) {
        (AgentField::Absent, AgentField::Absent)
        | (AgentField::Undefined, AgentField::Undefined) => true,
        (AgentField::Value(a), AgentField::Value(c)) => Rc::ptr_eq(a, c),
        _ => false,
    }
}
fn execute(input: &Input, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let mut state: Model = serde_json::from_str(&input.encoded).map_err(|e| e.to_string())?;
    let current = Rc::new(TurnUsage::new(3.0, 4.0));
    let legacy = Rc::new(TurnUsage::new(5.0, 6.0));
    let zero = shared_no_usage();
    state.usage = match input.usage.as_str() {
        "absent" => AgentField::Absent,
        "undefined" => AgentField::Undefined,
        "null" => AgentField::Value(None),
        "current" => AgentField::Value(Some(Rc::clone(&current))),
        "zero" => AgentField::Value(Some(Rc::clone(&zero))),
        "wire" => state.usage,
        _ => return Err("usage form".into()),
    };
    if let Some(conv) = state.conversation.as_mut() {
        let conv = Rc::make_mut(conv);
        conv.legacy_usage = match input.legacy.as_str() {
            "absent" => AgentField::Absent,
            "undefined" => AgentField::Undefined,
            "null" => AgentField::Value(None),
            "value" => AgentField::Value(Some(Rc::clone(&legacy))),
            _ => return Err("legacy form".into()),
        };
        conv.context_tokens = match input.context.as_str() {
            "absent" => AgentField::Absent,
            "undefined" => AgentField::Undefined,
            "null" => AgentField::Value(demlik_tea::data::NumberOrNull(None)),
            "number" => AgentField::Value(17.0.into()),
            _ => return Err("context form".into()),
        };
    }
    state.failure = match input.failure.as_str() {
        "absent" => AgentField::Absent,
        "undefined" => AgentField::Undefined,
        "null" => AgentField::Value(None),
        "wire" => state.failure,
        _ => return Err("failure form".into()),
    };
    let before = if input.operation == "cold" {
        serde_json::from_str::<Model>(&wire(&state)).map_err(|e| e.to_string())?
    } else {
        state
    };
    let before = Rc::new(before);
    if input.operation == "inspect" {
        let stage = observe!(
            calls,
            demlik_tea::agent::types::AgentState::current_stage,
            before.as_ref()
        );
        let settled = observe!(
            calls,
            demlik_tea::agent::types::AgentState::is_settled,
            before.as_ref()
        );
        let mut matches = vec![];
        for kind in [
            AwaitingKind::Llm,
            AwaitingKind::Tools,
            AwaitingKind::Compacting,
        ] {
            let selected = observe!(
                calls,
                demlik_tea::agent::types::AgentState::require_awaiting,
                before.as_ref(),
                kind
            );
            matches.push(b(selected.is_some_and(|c| {
                before
                    .conversation
                    .as_ref()
                    .is_some_and(|old| Rc::ptr_eq(c, old))
            })));
        }
        let value = stage.as_ref().map_or_else(
            || obj([("$undefined", b(true))]),
            |v| {
                if matches!(v.as_ref(), PlainData::Undefined) {
                    obj([("$undefined", b(true))])
                } else {
                    v.as_ref().clone()
                }
            },
        );
        return Ok(obj([
            ("stage", value),
            ("settled", b(settled)),
            ("matches", PlainData::Array(matches)),
            ("failureKind", s(kind(&before.failure))),
        ]));
    }
    if !matches!(input.operation.as_str(), "usage" | "cold") {
        return Err("operation".into());
    }
    let after = observe!(
        calls,
        demlik_tea::agent::types::AgentState::with_usage_defaults,
        &before
    );
    let origin = match &after.usage {
        AgentField::Absent => "absent",
        AgentField::Undefined => "undefined",
        AgentField::Value(None) => "null",
        AgentField::Value(Some(v)) => {
            if Rc::ptr_eq(v, &current) {
                "current"
            } else if Rc::ptr_eq(v, &legacy) {
                "legacy"
            } else if Rc::ptr_eq(v, &zero) {
                "zero"
            } else {
                "other"
            }
        }
    };
    let (conv_same, arrays_same, legacy_kind) = match (&before.conversation, &after.conversation) {
        (None, None) => (true, true, "none"),
        (Some(a), Some(c)) => (
            Rc::ptr_eq(a, c),
            Rc::ptr_eq(&a.turns, &c.turns) && Rc::ptr_eq(&a.tool_records, &c.tool_records),
            kind(&c.legacy_usage),
        ),
        _ => (false, false, "none"),
    };
    let compaction_same = match (&before.compaction, &after.compaction) {
        (AgentField::Value(a), AgentField::Value(c)) => a.same(c),
        (AgentField::Absent, AgentField::Absent)
        | (AgentField::Undefined, AgentField::Undefined) => true,
        _ => false,
    };
    Ok(obj([
        ("before", view(&before)),
        ("after", view(&after)),
        ("stateSame", b(Rc::ptr_eq(&before, &after))),
        ("conversationSame", b(conv_same)),
        ("arraysSame", b(arrays_same)),
        ("usageOrigin", s(origin)),
        ("usageKind", s(kind(&after.usage))),
        ("legacyKind", s(legacy_kind)),
        ("failureKind", s(kind(&after.failure))),
        (
            "composedSame",
            b(Rc::ptr_eq(&before.run, &after.run)
                && before.resilience.same(&after.resilience)
                && Rc::ptr_eq(&before.tools, &after.tools)
                && compaction_same
                && field_same(&before.tool_resilience, &after.tool_resilience)
                && field_same(&before.refused_calls, &after.refused_calls)
                && field_same(&before.lifecycle, &after.lifecycle)),
        ),
        ("wire", PlainData::String(wire(&after).into())),
    ]))
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
        let req: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let mut calls = vec![];
        let out = execute(&req.input, &mut calls);
        let response = match out {
            Ok(v) => Response {
                id: req.id,
                ok: true,
                output: Some(to_raw_value(&JsonData(&v)).unwrap()),
                error: None,
                observed_calls: calls,
            },
            Err(e) => Response {
                id: req.id,
                ok: false,
                output: None,
                error: Some(e),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response).unwrap());
    }
}
