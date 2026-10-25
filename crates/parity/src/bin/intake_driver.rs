use demlik_tea::{
    PlainData, Tagged,
    data::{JsText, NumberOrNull, plain_data, stringify_json},
    idempotency::intake::{self, Cmd, Config, Entry, Intake, IntakeError, IntakeValue, State},
    js_record::{JsAccessError, RecordCodec, RecordValue},
    work_queue::{QueueAdapter, QueueField, QueueItem, queue_adapter},
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, normalized, text};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe { ($calls:expr,$function:path $(,$arg:expr)* $(,)?) => {{let value=$function($($arg),*); $calls.borrow_mut().push(stringify!($function)); value}}; }
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Text {
    Utf8(String),
    Units {
        #[serde(rename = "$utf16")]
        units: Vec<u16>,
    },
}
impl From<Text> for JsText {
    fn from(t: Text) -> Self {
        match t {
            Text::Utf8(s) => s.into(),
            Text::Units { units } => Self::from_units(units),
        }
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum At {
    Number(Number),
    Null(()),
}
impl At {
    fn value(self) -> NumberOrNull {
        match self {
            Self::Number(n) => n.value().into(),
            Self::Null(()) => NumberOrNull(None),
        }
    }
}
struct HostValue(RefCell<PlainData>);
struct KeyFailure {
    error: JsAccessError,
    capability: Box<dyn Fn() -> u32>,
}
impl Serialize for HostValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.borrow().serialize(s)
    }
}
impl<'de> Deserialize<'de> for HostValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        PlainData::deserialize(d).map(|p| Self(RefCell::new(p)))
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Bind {
        kind: Kind,
        slot: String,
        value: Value,
    },
    Mutate {
        kind: Kind,
        slot: String,
        value: Value,
    },
    Receive {
        slot: String,
        at: At,
        id: Text,
    },
    Complete {
        key: Text,
        slot: String,
        at: At,
    },
    Claim {
        at: At,
    },
    Boot,
    RoundTrip,
    Restore {
        encoded: String,
    },
    MarkDone {
        id: Text,
    },
    FailKey {
        enabled: bool,
    },
    Build {
        family: Family,
        key: Text,
        slot: String,
        id: Option<Text>,
    },
    Settle {
        output: Value,
        at: Number,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Payload,
    Result,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Family {
    Process,
    Replay,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    ttl_ms: Option<Number>,
    constant_key: Option<Text>,
    actions: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    input: Script,
}
type Registry = BTreeMap<String, Rc<HostValue>>;
fn field<R: Serialize>(value: &IntakeValue<R>) -> Value {
    match value {
        QueueField::Value(v) => wire::snapshot(v),
        _ => json!({"$undefined":true}),
    }
}
fn entry<R: Serialize>(entry: &Entry<R>) -> Value {
    match entry {
        Entry::Pending => json!({"phase":"pending"}),
        Entry::Done { result } => {
            let mut fields = serde_json::Map::from_iter([("phase".into(), json!("done"))]);
            if !result.is_absent() {
                fields.insert("result".into(), field(result));
            }
            Value::Object(fields)
        }
    }
}
fn item(item: &QueueItem<HostValue>, calls: &Calls) -> Value {
    let mut fields = match wire::snapshot(item) {
        Value::Object(v) => v,
        _ => unreachable!(),
    };
    if observe!(calls, QueueItem::has_own, item, "input") {
        fields.insert("input".into(), wire::snapshot(&item.input));
    }
    if item.started_at.is_undefined() {
        fields.insert("startedAt".into(), json!({"$undefined":true}));
    }
    if item.finished_at.is_undefined() {
        fields.insert("finishedAt".into(), json!({"$undefined":true}));
    }
    if item.output.is_undefined() {
        fields.insert("output".into(), json!({"$undefined":true}));
    }
    if item.error.is_undefined() {
        fields.insert("error".into(), json!({"$undefined":true}));
    }
    Value::Object(fields)
}
fn entries(state: &State<HostValue, HostValue>) -> Value {
    let pairs=state.seen.entries.own_entries().map(|(key,value)|{
        let value=match value {
            RecordValue::Entry(row)=>json!({"value":entry(&row.value),"atMs":row.at_ms.number().map_or(Value::Null,wire::number)}),
            RecordValue::Data(value)=>normalized(value),
            RecordValue::ObjectPrototype=>json!({}),
            RecordValue::Builtin(_)=>json!({"$undefined":true}),
        }; (key.clone(),value)
    }).collect::<Vec<_>>();
    if pairs.iter().all(|(k, _)| k.as_utf8().is_some()) {
        Value::Object(
            pairs
                .into_iter()
                .map(|(k, v)| (k.as_utf8().unwrap().to_owned(), v))
                .collect(),
        )
    } else {
        json!({"$object":pairs.iter().map(|(k,v)|json!([text(k),v])).collect::<Vec<_>>()})
    }
}
fn command(command: &Cmd<HostValue, HostValue>) -> Value {
    match command {
        Cmd::Process(c) => {
            json!({"type":c.tag(),"key":text(&c.input().key),"itemId":text(&c.input().item_id),"payload":wire::snapshot(&c.input().payload)})
        }
        Cmd::Replay(c) => {
            json!({"type":c.tag(),"key":text(&c.input().key),"result":field(&c.input().result)})
        }
    }
}
fn object_identity(value: &Rc<HostValue>, registry: &Registry) -> Vec<String> {
    if !matches!(
        &*value.0.borrow(),
        PlainData::Object(_) | PlainData::Array(_)
    ) {
        return vec![];
    }
    registry
        .iter()
        .filter(|(_, v)| Rc::ptr_eq(v, value))
        .map(|(k, _)| k.clone())
        .collect()
}
fn errors(error: IntakeError<Rc<KeyFailure>>, expected: &Rc<KeyFailure>) -> Value {
    match error {
        IntakeError::Key(error) => {
            let mut value = json!({"name":error.error.name,"message":error.error.message});
            if Rc::ptr_eq(&error, expected) {
                value.as_object_mut().unwrap().extend([
                    ("sameKeyCause".into(), json!(true)),
                    ("capability".into(), json!((error.capability)())),
                ]);
            }
            value
        }
        IntakeError::Access(e) => json!({"name":e.name,"message":e.message}),
        IntakeError::Projection(p) => {
            json!({"projection":normalized(&p.value),"name":p.cause.name,"message":p.cause.message})
        }
    }
}
fn execute(script: Script) -> Value {
    let calls = Calls::default();
    let key_calls = Rc::new(Cell::new(0_usize));
    let key_inputs = Rc::new(RefCell::new(vec![]));
    let fail_key = Rc::new(Cell::new(false));
    let key_failure = Rc::new(KeyFailure {
        error: JsAccessError {
            name: "Error",
            message: "key rejected".into(),
        },
        capability: Box::new(|| 7),
    });
    let key_cause = key_failure.clone();
    let (counter, inputs, fail) = (key_calls.clone(), key_inputs.clone(), fail_key.clone());
    let constant = script.constant_key.map(JsText::from);
    let mut config = Config::with_key_error(move |payload: &HostValue| {
        counter.set(counter.get() + 1);
        inputs.borrow_mut().push(wire::snapshot(payload));
        if fail.get() {
            return Err(key_cause.clone());
        }
        if let Some(key) = &constant {
            return Ok(key.clone());
        }
        match &*payload.0.borrow() {
            PlainData::Object(fields) => match fields.get("key") {
                Some(PlainData::String(key)) => Ok(key.clone()),
                _ => Err(Rc::new(KeyFailure {
                    error: JsAccessError {
                        name: "TypeError",
                        message: "fixture payload requires a text key".into(),
                    },
                    capability: Box::new(|| 0),
                })),
            },
            _ => Err(Rc::new(KeyFailure {
                error: JsAccessError {
                    name: "TypeError",
                    message: "fixture payload requires a text key".into(),
                },
                capability: Box::new(|| 0),
            })),
        }
    });
    config.ttl_ms = script.ttl_ms.map(Number::value);
    let intake = observe!(&calls, Intake::new, config).with_result_codec(RecordCodec::new(
        |v: &Rc<HostValue>| Ok(v.0.borrow().clone()),
        |v| Ok(Rc::new(HostValue(RefCell::new(v.clone())))),
    ));
    let mut state = observe!(&calls, Intake::init, &intake);
    let (mut payloads, mut results) = (Registry::new(), Registry::new());
    let mut last: Option<Cmd<HostValue, HostValue>> = None;
    let row = |state: &Rc<State<HostValue, HostValue>>, effect: Value| {
        let plain = plain_data(state).unwrap();
        let wire = stringify_json(&plain).unwrap();
        json!({"wireState":normalized(&demlik_tea::data::decode_json(&wire).unwrap()),
          "values":{"entries":entries(state),"entryKeys":state.seen.entries.own_entries().map(|(k,_)|text(k)).collect::<Vec<_>>(),"order":state.seen.order.iter().map(text).collect::<Vec<_>>(),"capacity":state.seen.capacity.map_or(json!({"$undefined":true}),|v|v.number().map_or(Value::Null,wire::number)),"ttlMs":state.seen.ttl_ms.map_or(json!({"$undefined":true}),|v|v.number().map_or(Value::Null,wire::number)),"queue":state.queue.items().iter().map(|v|item(v,&calls)).collect::<Vec<_>>()},
          "effect":effect,"keyCalls":key_calls.get(),"keyInputs":key_inputs.borrow().clone()})
    };
    let mut rows = vec![row(&state, Value::Null)];
    for action in script.actions {
        let before = state.clone();
        let mut effect = json!({});
        let transition: Result<(), IntakeError<Rc<KeyFailure>>> = (|| {
            match action {
                Action::Bind { kind, slot, value } => {
                    let registry = match kind {
                        Kind::Payload => &mut payloads,
                        Kind::Result => &mut results,
                    };
                    registry.insert(slot, Rc::new(HostValue(RefCell::new(data(&value)))));
                }
                Action::Mutate { kind, slot, value } => {
                    let registry = match kind {
                        Kind::Payload => &payloads,
                        Kind::Result => &results,
                    };
                    let value = data(&value);
                    assert!(matches!(&value, PlainData::Object(_) | PlainData::Array(_)));
                    *registry[&slot].0.borrow_mut() = value;
                }
                Action::Receive { slot, at, id } => {
                    let next = observe!(
                        &calls,
                        Intake::receive,
                        &intake,
                        &state,
                        payloads[&slot].clone(),
                        at.value(),
                        JsText::from(id)
                    )?;
                    let commands = next.commands.iter().map(command).collect::<Vec<_>>();
                    let identities = next
                        .commands
                        .iter()
                        .map(|cmd| match cmd {
                            Cmd::Process(c) => object_identity(&c.input().payload, &payloads),
                            Cmd::Replay(c) => match &c.input().result {
                                QueueField::Value(v) => object_identity(v, &results),
                                _ => vec![],
                            },
                        })
                        .collect::<Vec<_>>();
                    effect = json!({"commands":commands,"identities":identities});
                    last = next.commands.into_iter().last();
                    state = next.state;
                }
                Action::Complete { key, slot, at } => {
                    let result = results[&slot].clone();
                    let next = observe!(
                        &calls,
                        Intake::complete,
                        &intake,
                        &state,
                        JsText::from(key),
                        IntakeValue::Value(result),
                        at.value()
                    )?;
                    effect = json!({"commands":[]});
                    state = next.state;
                }
                Action::Claim { at } => {
                    let claim = observe!(&calls, Intake::claim_next, &intake, &state, at.value())?;
                    effect = match claim {
                        Some(claim) => {
                            state = claim.state;
                            json!({"claimed":item(&claim.claimed,&calls),"identities":object_identity(&claim.claimed.input,&payloads)})
                        }
                        None => json!({"claimed":null}),
                    };
                }
                Action::Boot => {
                    let next = observe!(&calls, Intake::boot, &intake, &state)?;
                    effect = json!({"commands":[]});
                    state = next.state;
                }
                Action::RoundTrip => {
                    let encoded = stringify_json(&plain_data(&state).unwrap()).unwrap();
                    state = Rc::new(serde_json::from_str(&encoded).unwrap());
                    effect = json!({"restored":true});
                }
                Action::Restore { encoded } => {
                    state = Rc::new(serde_json::from_str(&encoded).unwrap());
                    effect = json!({"restored":true});
                }
                Action::MarkDone { id } => {
                    let change = observe!(
                        &calls,
                        demlik_tea::work_queue::QueueOps::mark_done,
                        &queue_adapter(),
                        &state.queue,
                        JsText::from(id)
                    );
                    effect = json!({"changed":change.changed});
                    state = Rc::new(State {
                        seen: state.seen.clone(),
                        queue: change.next,
                    });
                }
                Action::FailKey { enabled } => fail_key.set(enabled),
                Action::Build {
                    family,
                    key,
                    slot,
                    id,
                } => {
                    let key = key.into();
                    last = Some(match family {
                        Family::Process => Cmd::Process(
                            observe!(&calls, intake::intake_process_def::<HostValue>).from_record(
                                intake::ProcessInput {
                                    key,
                                    item_id: id.map(JsText::from).unwrap_or_else(|| "built".into()),
                                    payload: payloads[&slot].clone(),
                                },
                            ),
                        ),
                        Family::Replay => Cmd::Replay(
                            observe!(&calls, intake::intake_replay_def::<HostValue>).from_record(
                                intake::ReplayInput {
                                    key,
                                    result: QueueField::Value(results[&slot].clone()),
                                },
                            ),
                        ),
                    });
                    effect = json!({"command":command(last.as_ref().unwrap())});
                }
                Action::Settle { output, at } => {
                    use demlik_tea::command::{CommandFamily, Outcome};
                    let messages = observe!(
                        &calls,
                        Cmd::settle,
                        last.take().expect("command before settle"),
                        Some(Outcome::ok(data(&output))),
                        at.value()
                    )
                    .unwrap();
                    effect = json!({"messages":messages.iter().map(|m|match m {intake::Msg::Process(m)=>wire::snapshot(m),intake::Msg::Replay(m)=>wire::snapshot(m)}).collect::<Vec<_>>()});
                }
            }
            Ok(())
        })();
        if let Err(error) = transition {
            effect = json!({"error":errors(error,&key_failure)});
        }
        effect.as_object_mut().unwrap().extend([
            ("sameState".into(), json!(Rc::ptr_eq(&state, &before))),
            (
                "sameSeen".into(),
                json!(Rc::ptr_eq(&state.seen, &before.seen)),
            ),
            ("sameQueue".into(), json!(state.queue.ptr_eq(&before.queue))),
        ]);
        rows.push(row(&state, effect));
    }
    json!({"value":rows,"calls":calls.into_inner()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Input = serde_json::from_str(&line.unwrap()).expect("parsed intake script");
        println!("{}", json!({"id":input.id,"output":execute(input.input)}));
    }
}
