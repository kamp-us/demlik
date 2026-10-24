use super::{Number, data, snapshot};
use demlik_tea::{PlainData, data::JsText, timing::throttled_input::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    throttle_ms: Option<Number>,
    debounce_ms: Option<Number>,
    cache_ttl_ms: Option<Number>,
    cache_key: Option<String>,
    field: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Input { value: Value, at: Number },
    Flush { at: Number },
    Subs,
    RoundTrip,
}
#[derive(Deserialize)]
struct Input {
    config: Config,
    #[serde(default)]
    free: bool,
    id: Option<Value>,
    actions: Vec<Action>,
}
#[derive(Serialize)]
struct Emit {
    #[serde(rename = "type")]
    kind: &'static str,
    value: PlainData,
}
impl demlik_tea::Tagged for Emit {
    fn tag(&self) -> &str {
        self.kind
    }
}
fn string(value: &PlainData) -> JsText {
    match value {
        PlainData::String(value) => value.clone(),
        PlainData::Null => "null".into(),
        PlainData::Undefined => "undefined".into(),
        PlainData::Bool(value) => value.to_string().into(),
        PlainData::Number(_) => demlik_tea::structural_hash(value).into(),
        PlainData::Object(_) => "[object Object]".into(),
        PlainData::Array(values) => {
            let mut units = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    units.push(44);
                }
                if !matches!(value, PlainData::Null | PlainData::Undefined) {
                    units.extend_from_slice(string(value).as_units());
                }
            }
            JsText::from_units(units)
        }
    }
}
fn key(value: &PlainData, mode: &str, field: &str) -> JsText {
    match mode {
        "string" => string(value),
        "json" => demlik_tea::data::stringify_json(value)
            .unwrap_or_else(|| "undefined".into())
            .into(),
        "field" => {
            let value = match value {
                PlainData::Object(values) => values.get(field).unwrap_or(&PlainData::Undefined),
                _ => &PlainData::Undefined,
            };
            string(value)
        }
        _ => panic!("unsupported cache key mode"),
    }
}
pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let emitted = Rc::new(Cell::new(0));
    let keys = Rc::new(Cell::new(0));
    let emit = {
        let emitted = emitted.clone();
        move |value: &PlainData| {
            emitted.set(emitted.get() + 1);
            Emit {
                kind: "Emit",
                value: value.clone(),
            }
        }
    };
    let mut config = observe!(
        calls,
        demlik_tea::timing::throttled_input::ThrottledInputConfig::new,
        emit
    );
    config.throttle_ms = input.config.throttle_ms.map(Number::value);
    config.debounce_ms = input.config.debounce_ms.map(Number::value);
    let mut output = if let Some(ttl) = input.config.cache_ttl_ms {
        let mode = input
            .config
            .cache_key
            .ok_or("cacheKey is required with cacheTtlMs")?;
        let field = input.config.field.unwrap_or_else(|| "id".into());
        let key = {
            let keys = keys.clone();
            move |value: &PlainData| {
                keys.set(keys.get() + 1);
                key(value, &mode, &field)
            }
        };
        let config = observe!(
            calls,
            demlik_tea::timing::throttled_input::ThrottledInputConfig::with_cache,
            config,
            ttl.value(),
            key
        );
        drive(config, input.free, input.id, input.actions, calls)?
    } else {
        if input.config.cache_key.is_some() {
            return Err("cacheKey is forbidden without cacheTtlMs".into());
        }
        drive(config, input.free, input.id, input.actions, calls)?
    };
    output["emitCalls"] = json!(emitted.get());
    output["keyCalls"] = json!(keys.get());
    Ok(output)
}
fn subscriptions<F, P>(
    knob: &ThrottledInputKnob<F, P>,
    state: &ThrottledInput<PlainData>,
    id: Option<JsText>,
    free: bool,
    calls: &mut Vec<&'static str>,
) -> Result<(Value, Value), String> {
    let list = if free {
        observe!(
            calls,
            demlik_tea::timing::throttled_input::subs_for,
            &knob.config,
            state,
            id
        )
    } else {
        observe!(
            calls,
            demlik_tea::timing::throttled_input::ThrottledInputKnob::subs,
            knob,
            state,
            id
        )
    };
    let sub = if list.is_empty() {
        Value::Null
    } else {
        let sub = observe!(calls, demlik_tea::Sub::new, "deadline", list.clone())
            .map_err(|error| error.to_string())?;
        json!(demlik_tea::Subscription::id(&sub))
    };
    Ok((snapshot(&list), sub))
}
fn cache_same<V>(left: &ThrottledInput<V>, right: &ThrottledInput<V>) -> bool {
    match (&left.state().cache, &right.state().cache) {
        (Some(left), Some(right)) => Rc::ptr_eq(left, right),
        (None, None) => true,
        _ => false,
    }
}
fn drive<F: Fn(&PlainData) -> Emit, P: CachePolicy<PlainData>>(
    config: ThrottledInputConfig<F, P>,
    free: bool,
    id: Option<Value>,
    actions: Vec<Action>,
    calls: &mut Vec<&'static str>,
) -> Result<Value, String> {
    let knob = observe!(
        calls,
        demlik_tea::timing::throttled_input::create_throttled_input,
        config
    );
    let mut state = if free {
        observe!(
            calls,
            demlik_tea::timing::throttled_input::init_throttled_input
        )
    } else {
        observe!(
            calls,
            demlik_tea::timing::throttled_input::ThrottledInputKnob::init,
            &knob
        )
    };
    let initial = snapshot(&state);
    let id = id
        .map(|id| match data(&id) {
            PlainData::String(text) => Ok(text),
            _ => Err("id must be text"),
        })
        .transpose()?;
    let mut observations = Vec::new();
    for action in actions {
        let old = state.clone();
        let (op, result) = match action {
            Action::Input { value, at } => {
                let value = data(&value);
                let result = if free {
                    observe!(
                        calls,
                        demlik_tea::timing::throttled_input::input,
                        &knob.config,
                        &state,
                        value,
                        at.value()
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::timing::throttled_input::ThrottledInputKnob::input,
                        &knob,
                        &state,
                        value,
                        at.value()
                    )
                };
                ("input", Some(result))
            }
            Action::Flush { at } => {
                let result = if free {
                    observe!(
                        calls,
                        demlik_tea::timing::throttled_input::on_flush,
                        &knob.config,
                        &state,
                        at.value()
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::timing::throttled_input::ThrottledInputKnob::on_flush,
                        &knob,
                        &state,
                        at.value()
                    )
                };
                ("flush", Some(result))
            }
            Action::Subs => ("subs", None),
            Action::RoundTrip => {
                let raw =
                    demlik_tea::data::plain_data(&state).map_err(|error| error.to_string())?;
                let encoded = demlik_tea::data::stringify_json(&raw).unwrap();
                let raw =
                    demlik_tea::data::decode_json(&encoded).map_err(|error| error.to_string())?;
                state = observe!(
                    calls,
                    demlik_tea::timing::throttled_input::ThrottledInput::restore_data,
                    raw,
                    Ok::<_, std::convert::Infallible>
                )
                .map_err(|error| format!("public input-state restoration failed: {error}"))?;
                let (subs, sub_id) = subscriptions(&knob, &state, id.clone(), free, calls)?;
                observations.push(json!({"op":"roundTrip","json":encoded,"state":snapshot(&state),"same":false,"cacheSame":cache_same(&old,&state),"subs":subs,"subId":sub_id}));
                continue;
            }
        };
        let commands = match result {
            None => vec![],
            Some(Ok(step)) => {
                state = step.state;
                step.commands
            }
            Some(Err(error)) => {
                observations
                    .push(json!({"op":op,"error":error,"state":snapshot(&state),"same":true,"cacheSame":true}));
                continue;
            }
        };
        let (subs, sub_id) = subscriptions(&knob, &state, id.clone(), free, calls)?;
        observations.push(json!({"op":op,"state":snapshot(&state),"cmds":snapshot(&commands),"same":old.ptr_eq(&state),"cacheSame":cache_same(&old,&state),"subs":subs,"subId":sub_id}));
    }
    Ok(json!({"initial":initial,"observations":observations}))
}
