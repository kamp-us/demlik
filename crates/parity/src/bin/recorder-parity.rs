use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    data::JsText,
    js_record::RecordValue,
    persistence::{recorder, trace_replay as replay},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::{Rc, Weak},
    sync::Arc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
macro_rules! observe {
    ($calls:expr, $call:path $(, $arg:expr)* $(,)?) => {{
        let result = $call($($arg),*);
        $calls.push(stringify!($call));
        result
    }};
}
#[derive(Deserialize)]
struct Request {
    id: String,
    input: Value,
}
fn field<'a>(value: &'a PlainData, key: &str) -> &'a PlainData {
    match value {
        PlainData::Object(fields) => fields.get(key).unwrap_or(&PlainData::Undefined),
        _ => &PlainData::Undefined,
    }
}
fn text(value: &PlainData) -> &str {
    match value {
        PlainData::String(value) => value.as_utf8().expect("fixture tag is UTF-8"),
        _ => "undefined",
    }
}
fn number(value: &Value) -> f64 {
    serde_json::from_value::<wire::Number>(value.clone())
        .expect("fixture number")
        .value()
}
fn kind(value: &PlainData) -> recorder::StateKind {
    match value {
        PlainData::Null => recorder::StateKind::Null,
        PlainData::Undefined => recorder::StateKind::Undefined,
        _ => recorder::StateKind::Value,
    }
}
fn trace(value: &Value) -> recorder::Trace<PlainData, PlainData> {
    let get = |key: &str| wire::data(value.get(key).unwrap_or(&json!({"$undefined":true})));
    let loaded = get("loaded");
    recorder::Trace {
        loaded: (!matches!(loaded, PlainData::Null)).then(|| Arc::new(loaded)),
        msgs: value["msgs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| Arc::new(wire::data(value)))
            .collect(),
        final_state: Arc::new(get("finalState")),
        steps: value
            .get("steps")
            .filter(|value| !value.is_null())
            .map(|steps| {
                steps
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|step| recorder::TraceStep {
                        msg: Arc::new(wire::data(
                            step.get("msg").unwrap_or(&json!({"$undefined":true})),
                        )),
                        state: Arc::new(wire::data(
                            step.get("state").unwrap_or(&json!({"$undefined":true})),
                        )),
                    })
                    .collect()
            }),
    }
}
fn snapshot(value: &recorder::Trace<PlainData, PlainData>) -> Value {
    let mut result = json!({
        "loaded":value.loaded.as_ref().map_or(Value::Null, |value|wire::normalized(value)),
        "msgs":value.msgs.iter().map(|value|wire::normalized(value)).collect::<Vec<_>>(),
        "finalState":wire::normalized(&value.final_state),
    });
    if let Some(steps) = &value.steps {
        result["steps"] = json!(steps.iter().map(|step|json!({"msg":wire::normalized(&step.msg),"state":wire::normalized(&step.state)})).collect::<Vec<_>>());
    }
    result
}
fn parser(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let raw = wire::data(&input["text"]);
    let PlainData::String(raw) = raw else {
        panic!("fixture JSONL text")
    };
    let result = if let Some(raw) = raw.as_utf8() {
        observe!(calls, demlik_tea::persistence::recorder::parse_jsonl, raw)
    } else {
        observe!(
            calls,
            demlik_tea::persistence::recorder::parse_jsonl_text,
            &raw
        )
    };
    match result {
        Ok(value) => {
            let attachment = observe!(
                calls,
                demlik_tea::persistence::recorder::trace_attachment,
                &value
            )
            .unwrap();
            let rewrite = observe!(
                calls,
                demlik_tea::persistence::recorder::trace_to_jsonl,
                &value
            )
            .unwrap();
            json!({"trace":snapshot(&value),"rewrite":rewrite,"attachment":attachment,
                "sharedMessages":value.steps.as_ref().unwrap().iter().all(|step|value.msgs.iter().any(|msg|Arc::ptr_eq(msg,&step.msg))),
                "sharedFinal":value.steps.as_ref().unwrap().last().is_none_or(|step|Arc::ptr_eq(&step.state,&value.final_state))})
        }
        Err(error) => match error {
            recorder::JsonlError::Syntax { line, ref cause } => {
                json!({"error":{"name":error.name(),"message":format!("tea recorder: parseJSONL failed on line {line}: not valid JSON. ")},"diagnostic":cause.to_string()})
            }
            _ => json!({"error":{"name":error.name(),"message":error.to_string()}}),
        },
    }
}
fn recording(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let rng = input
        .get("rng")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| number(&value))
        .collect::<Vec<_>>();
    let random_calls = Rc::new(Cell::new(0));
    let tick = random_calls.clone();
    let slot = Rc::new(RefCell::new(Weak::<
        recorder::Recorder<'static, PlainData, PlainData>,
    >::new()));
    let target = slot.clone();
    let nested = input.get("reenter").map(|value| {
        (
            Arc::new(wire::data(&value["msg"])),
            Arc::new(wire::data(&value["state"])),
        )
    });
    let rec = Rc::new(observe!(
        calls,
        demlik_tea::persistence::recorder::Recorder::with_state_kind,
        recorder::RecorderOptions {
            sample_rate: input.get("sampleRate").map(number),
            capture_steps: input["captureSteps"].as_bool().unwrap_or(false)
        },
        move || {
            let i = tick.get();
            tick.set(i + 1);
            if i == 0 {
                if let Some((msg, state)) = &nested {
                    target
                        .borrow()
                        .upgrade()
                        .unwrap()
                        .record_step(msg.clone(), state.clone());
                }
            }
            rng.get(i).copied().unwrap_or(0.0)
        },
        kind
    ));
    *slot.borrow_mut() = Rc::downgrade(&rec);
    let mut rows = vec![];
    for action in input["actions"].as_array().unwrap() {
        match action["kind"].as_str().unwrap() {
            "boot" => observe!(
                calls,
                demlik_tea::persistence::recorder::Recorder::record_boot,
                &rec,
                Arc::new(wire::data(&action["state"]))
            ),
            "step" => observe!(
                calls,
                demlik_tea::persistence::recorder::Recorder::record_step,
                &rec,
                Arc::new(wire::data(&action["msg"])),
                Arc::new(wire::data(&action["state"]))
            ),
            "stop" => observe!(
                calls,
                demlik_tea::persistence::recorder::Recorder::stop,
                &rec
            ),
            "dump" => match observe!(
                calls,
                demlik_tea::persistence::recorder::Recorder::dump,
                &rec
            ) {
                Ok(mut value) => {
                    let before = snapshot(&value);
                    value.msgs.clear();
                    if let Some(steps) = &mut value.steps {
                        steps.clear();
                    }
                    let again = observe!(
                        calls,
                        demlik_tea::persistence::recorder::Recorder::dump,
                        &rec
                    )
                    .unwrap();
                    rows.push(json!({"kind":"dump","trace":before,"freshArrays":snapshot(&again)==before}));
                }
                Err(error) => rows.push(
                    json!({"kind":"dump","error":{"name":"Error","message":error.to_string()}}),
                ),
            },
            "jsonl" => match observe!(
                calls,
                demlik_tea::persistence::recorder::Recorder::to_jsonl,
                &rec
            ) {
                Ok(text) => rows.push(json!({"kind":"jsonl","text":text})),
                Err(error) => rows.push(
                    json!({"kind":"jsonl","error":{"name":"Error","message":error.to_string()}}),
                ),
            },
            _ => panic!("fixture action"),
        }
    }
    json!({"rows":rows,"randomCalls":random_calls.get()})
}
struct Msg(PlainData);
impl Tagged for Msg {
    fn tag(&self) -> &str {
        text(field(&self.0, "type"))
    }
}
#[derive(serde::Serialize)]
#[serde(transparent)]
struct Model(PlainData);
impl Tagged for Model {
    fn tag(&self) -> &str {
        text(field(&self.0, "type"))
    }
}
fn record_value(value: &RecordValue<PlainData>) -> Value {
    match value {
        RecordValue::Entry(value) | RecordValue::Data(value) => wire::normalized(value),
        RecordValue::Builtin(name) => json!({"$builtin":name}),
        RecordValue::ObjectPrototype => json!({}),
    }
}
fn divergence(value: &replay::Divergence) -> Value {
    json!({"path":wire::text(&value.path),"expected":record_value(&value.expected),"actual":record_value(&value.actual)})
}
fn compare(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let expected = wire::data(&input["expected"]);
    let actual = wire::data(&input["actual"]);
    let equal = observe!(
        calls,
        demlik_tea::persistence::trace_replay::deep_equal,
        &expected,
        &actual
    );
    let difference = observe!(
        calls,
        demlik_tea::persistence::trace_replay::first_divergence,
        &expected,
        &actual,
        "state"
    );
    json!({"equal":equal,"divergence":difference.as_ref().map(divergence)})
}
fn replaying(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let updates = Cell::new(0);
    let mut row: demlik_tea::core::Row<'_, Model, Msg, ()> = Default::default();
    row.insert(
        "add".into(),
        Box::new(|state, msg| {
            updates.set(updates.get() + 1);
            let mut state = state.0.clone();
            let PlainData::Object(fields) = &mut state else {
                panic!("counter fixture")
            };
            let PlainData::Number(count) = fields.get_mut("count").unwrap() else {
                panic!("count fixture")
            };
            let PlainData::Number(by) = field(&msg.0, "by") else {
                panic!("increment fixture")
            };
            *count += by;
            Step::new(Model(state), vec![()])
        }),
    );
    row.insert(
        "replace".into(),
        Box::new(|_, msg| {
            updates.set(updates.get() + 1);
            Step::new(Model(field(&msg.0, "state").clone()), vec![()])
        }),
    );
    let machine: Machine<'_, Model, Msg, (), Sub> = Machine {
        init: Box::new(|_, _| panic!("replay cannot call init")),
        update: Update::RawReducer(row),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            panic!("replay cannot select subscriptions")
        }),
    };
    let raw = trace(&input["trace"]);
    let trace = recorder::Trace {
        loaded: raw.loaded.map(|value| Arc::new(Model((*value).clone()))),
        msgs: raw
            .msgs
            .iter()
            .map(|value| Arc::new(Msg((**value).clone())))
            .collect(),
        final_state: Arc::new(Model((*raw.final_state).clone())),
        steps: None,
    };
    match observe!(
        calls,
        demlik_tea::persistence::trace_replay::replay_trace,
        &machine,
        &trace
    ) {
        Ok(result) => {
            json!({"matches":result.matches,"expected":wire::normalized(&result.expected.0),"actual":wire::normalized(&result.actual.0),"divergence":result.divergence.as_ref().map(divergence),"updates":updates.get(),"initCalls":0,"subscriptionCalls":0})
        }
        Err(error) => {
            json!({"error":{"name":error.name(),"message":error.to_string()},"updates":updates.get(),"initCalls":0,"subscriptionCalls":0})
        }
    }
}
fn walk(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let value = wire::data(&input["value"]);
    let left = wire::data(&input["left"]);
    let right = wire::data(&input["right"]);
    let (PlainData::Object(left), PlainData::Object(right)) = (&left, &right) else {
        panic!("walk object fixture")
    };
    let PlainData::String(path) = wire::data(&input["path"]) else {
        panic!("path fixture")
    };
    let PlainData::String(key) = wire::data(&input["key"]) else {
        panic!("key fixture")
    };
    json!({
        "type":observe!(calls,demlik_tea::persistence::trace_replay::state_walk::type_of,&value).as_str(),
        "indexPath":wire::text(&observe!(calls,demlik_tea::persistence::trace_replay::state_walk::index_path,&path,number(&input["index"]))),
        "keyPath":wire::text(&observe!(calls,demlik_tea::persistence::trace_replay::state_walk::key_path,&path,key)),
        "keys":observe!(calls,demlik_tea::persistence::trace_replay::state_walk::union_keys,left,right).iter().map(wire::text).collect::<Vec<_>>()
    })
}
fn attachment(input: &Value, calls: &mut Vec<&'static str>) -> Value {
    let value = trace(&input["trace"]);
    let attachment = observe!(
        calls,
        demlik_tea::persistence::recorder::trace_attachment,
        &value
    )
    .unwrap();
    let messages = recorder::Trace {
        loaded: value.loaded.clone(),
        msgs: value
            .msgs
            .iter()
            .map(|value| Arc::new(Msg((**value).clone())))
            .collect(),
        final_state: value.final_state.clone(),
        steps: None,
    };
    let limit = input.get("limit").map(number);
    let crumbs = observe!(
        calls,
        demlik_tea::persistence::recorder::breadcrumbs_from_trace,
        &messages,
        limit
    );
    let rendered = observe!(
        calls,
        demlik_tea::persistence::recorder::breadcrumbs_from_trace_with,
        &messages,
        limit,
        |msg: &Msg| Ok::<_, String>(JsText::from(format!("{}!", msg.tag())))
    )
    .unwrap();
    json!({"attachment":attachment,"breadcrumbs":crumbs.iter().map(|crumb|json!({"category":crumb.category,"type":crumb.kind,"level":crumb.level,"message":wire::text(&crumb.message),"data":{"msg":wire::normalized(&crumb.data.msg.0)}})).collect::<Vec<_>>(),
        "rendered":rendered.iter().map(|crumb|wire::text(&crumb.message)).collect::<Vec<_>>(),
        "sharedMessages":crumbs.iter().all(|crumb|messages.msgs.iter().any(|msg|Arc::ptr_eq(msg,&crumb.data.msg))),
        "serializedAttachment":wire::snapshot(&attachment)})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let mut calls = vec![];
        let value = match request.input["op"].as_str().unwrap() {
            "record" => recording(&request.input, &mut calls),
            "parse" => parser(&request.input, &mut calls),
            "compare" => compare(&request.input, &mut calls),
            "walk" => walk(&request.input, &mut calls),
            "replay" => replaying(&request.input, &mut calls),
            "attachment" => attachment(&request.input, &mut calls),
            _ => panic!("fixture operation"),
        };
        println!(
            "{}",
            json!({"id":request.id,"result":value,"observedCalls":calls})
        );
    }
}
