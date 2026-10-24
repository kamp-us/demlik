use super::wire::{Number, data, snapshot};
use demlik_tea::{PlainData, paginate::paginator::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::rc::Rc;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Start,
    Resume,
    Done,
    RoundTrip,
    Record { count: Number, next: Option<Value> },
    Drain { n: Number },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    first: First,
    high_water_mark: Option<Number>,
    #[serde(default)]
    defaults: bool,
    initial: Option<Value>,
    seed_raw: Option<String>,
    actions: Vec<Action>,
}
#[derive(Default)]
struct First(Option<Value>);
impl<'de> Deserialize<'de> for First {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}
fn initial(raw: Value) -> Result<PaginatorState<PlainData>, String> {
    let number = |key: &str| -> Result<PaginatorCount, String> {
        serde_json::from_value::<Number>(raw[key].clone())
            .map(|value| value.value().into())
            .map_err(|error| error.to_string())
    };
    let phase = match raw["phase"].as_str() {
        Some("idle") => PaginatorPhase::Idle,
        Some("done") => PaginatorPhase::Done,
        Some("fetching") => PaginatorPhase::Fetching {
            cursor: Rc::new(data(&raw["cursor"])).into(),
        },
        Some("paused") => PaginatorPhase::Paused {
            cursor: Rc::new(data(&raw["cursor"])).into(),
        },
        _ => return Err("unknown paginator phase".into()),
    };
    Ok(PaginatorState::from_snapshot(PaginatorSnapshot {
        phase,
        seen: number("seen")?,
        pages: number("pages")?,
    }))
}
fn cursor_same(left: Option<&Rc<PlainData>>, right: Option<&Rc<PlainData>>) -> bool {
    use PlainData::*;
    let l = left.map_or(&Undefined, |v| v.as_ref());
    let r = right.map_or(&Undefined, |v| v.as_ref());
    match (l, r) {
        (Null, Null) | (Undefined, Undefined) => true,
        (Bool(l), Bool(r)) => l == r,
        (Number(l), Number(r)) => l == r,
        (String(l), String(r)) => l == r,
        (Object(_), Object(_)) | (Array(_), Array(_)) => {
            left.zip(right).is_some_and(|(l, r)| Rc::ptr_eq(l, r))
        }
        _ => false,
    }
}
pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|e| e.to_string())?;
    let policy = if input.defaults {
        let default = observe!(
            calls,
            demlik_tea::paginate::paginator::default_paginator_policy
        );
        PaginatorPolicy::new(
            PlainData::Number(*default.first_cursor),
            default.high_water_mark,
        )
    } else {
        observe!(
            calls,
            demlik_tea::paginate::paginator::PaginatorPolicy::new,
            input.first.0.as_ref().map_or(PlainData::Undefined, data),
            input.high_water_mark.map_or(1000.0, Number::value)
        )
    };
    let mut state = if let Some(raw) = input.seed_raw {
        serde_json::from_str(&raw).map_err(|error| error.to_string())?
    } else {
        match input.initial {
            Some(raw) => initial(raw)?,
            None => observe!(calls, demlik_tea::paginate::paginator::init_paginator),
        }
    };
    let initial = snapshot(&state);
    let mut observations = Vec::new();
    for action in input.actions {
        let old = state.clone();
        let mut json_text = None;
        let op = match action {
            Action::Start => {
                state = observe!(
                    calls,
                    demlik_tea::paginate::paginator::start,
                    &state,
                    &policy
                );
                "start"
            }
            Action::Resume => {
                state = observe!(
                    calls,
                    demlik_tea::paginate::paginator::resume,
                    &state,
                    &policy
                );
                "resume"
            }
            Action::Record { count, next } => {
                let next = next
                    .as_ref()
                    .map(data)
                    .filter(|v| !matches!(v, PlainData::Null | PlainData::Undefined))
                    .map(Rc::new);
                state = observe!(
                    calls,
                    demlik_tea::paginate::paginator::record_page,
                    &state,
                    count.value(),
                    next,
                    &policy
                );
                "record"
            }
            Action::Drain { n } => {
                state = observe!(
                    calls,
                    demlik_tea::paginate::paginator::drain,
                    &state,
                    n.value()
                );
                "drain"
            }
            Action::Done => "done",
            Action::RoundTrip => {
                let raw = demlik_tea::data::plain_data(&state).map_err(|e| e.to_string())?;
                let text = demlik_tea::data::stringify_json(&raw).ok_or("undefined paginator")?;
                state = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                json_text = Some(text);
                "roundTrip"
            }
        };
        let done = observe!(calls, demlik_tea::paginate::paginator::is_done, &state);
        let mut observation = json!({"op":op,"state":snapshot(&state),"same":old.ptr_eq(&state),"cursorSame":cursor_same(old.cursor(),state.cursor()),"done":done});
        if let Some(text) = json_text {
            observation["json"] = json!(text);
        }
        observations.push(observation);
    }
    Ok(json!({"initial":initial,"observations":observations}))
}
