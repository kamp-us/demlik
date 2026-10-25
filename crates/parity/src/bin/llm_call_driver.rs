use demlik_tea::{
    PlainData, Step,
    command::{Outcome, Settlement},
    data::{JsText, stringify_json},
    describe_error::{ErrorView, describe_error},
    llm_call::{self as llm, CauseField, Config, LlmCall, LlmCause, Rejected, Request, Schema},
    resilience::{
        deadline::DeadlineExceeded,
        resilient_call::{CallValue, RunError},
    },
    retry_backoff::{BackoffCurve, CountBound, RetryPolicy},
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../../../tea/examples/llm_structured/consumer.rs"]
mod consumer;
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, snapshot, text};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
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
            Text::Utf8(t) => t.into(),
            Text::Units { units } => Self::from_units(units),
        }
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Plan,
    Report,
    Pass,
    Reject,
}
struct HostValue {
    plain: PlainData,
    message: Option<RefCell<JsText>>,
}
impl Serialize for HostValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.plain.serialize(s)
    }
}
impl<'de> Deserialize<'de> for HostValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        PlainData::deserialize(d).map(|plain| Self {
            plain,
            message: None,
        })
    }
}
fn describe(value: &HostValue) -> Result<JsText, demlik_tea::js_record::JsAccessError> {
    match &value.message {
        Some(message) => describe_error(ErrorView::ErrorMessage(&message.borrow())),
        None => describe_error(ErrorView::Value(&value.plain)),
    }
}
struct Parser {
    mode: Mode,
    visits: Rc<Cell<usize>>,
    failure: Rc<HostValue>,
}
impl Schema for Parser {
    type Raw = PlainData;
    type Output = PlainData;
    type Error = HostValue;
    fn parse(&self, raw: PlainData) -> Result<PlainData, CallValue<HostValue>> {
        self.visits.set(self.visits.get() + 1);
        let output = match self.mode {
            Mode::Pass => Some(raw),
            Mode::Reject => None,
            Mode::Plan => {
                if let PlainData::Object(fields) = raw {
                    match fields.get(&JsText::from("steps")) {
                        Some(PlainData::Array(steps))
                            if steps.iter().all(|v| matches!(v, PlainData::String(_))) =>
                        {
                            Some(PlainData::Object(
                                [(JsText::from("steps"), PlainData::Array(steps.clone()))]
                                    .into_iter()
                                    .collect(),
                            ))
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            Mode::Report => {
                if let PlainData::Object(fields) = raw {
                    match fields.get(&JsText::from("summary")) {
                        Some(PlainData::String(summary)) => Some(PlainData::Object(
                            [(JsText::from("summary"), PlainData::String(summary.clone()))]
                                .into_iter()
                                .collect(),
                        )),
                        _ => None,
                    }
                } else {
                    None
                }
            }
        };
        output.ok_or_else(|| CallValue::shared(self.failure.clone()))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Retry {
    base_ms: Number,
    factor: Number,
    cap_ms: Number,
    jitter: demlik_tea::retry_backoff::Jitter,
    max_attempts: Number,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Cause {
    Value { value: Value },
    Error { message: Text },
    Undefined,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Field {
    Own,
    Missing,
    Inherited,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Attempt {
        purpose: Text,
        model: Option<Text>,
        payload: Value,
        at: Number,
        key: Option<Text>,
        slot: String,
    },
    Decode {
        slot: String,
        raw: Value,
        at: Number,
        apply: bool,
    },
    Reject {
        slot: String,
        cause: Cause,
        field: Field,
        at: Number,
        apply: bool,
    },
    ErrOf,
    Fail,
    Succeed,
    MutateCause {
        message: Text,
    },
    FireNext {
        slot: String,
    },
    Timer {
        id: Text,
        at: Number,
        slot: String,
    },
    Schema {
        purpose: Text,
        mode: Mode,
    },
    SchemaOf {
        purpose: Text,
    },
    RoundTrip,
    RoundTripMsg,
    Restore {
        encoded: String,
    },
    Lift,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pure {
    retry: Option<Retry>,
    rng: Vec<Number>,
    actions: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Script {
    Pure {
        #[serde(flatten)]
        script: Pure,
    },
    Runtime {
        profile: String,
        mode: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    input: Script,
}
type Knob = LlmCall<'static, JsText, PlainData, Parser>;
type State = llm::State<JsText, PlainData, PlainData, HostValue>;
fn stored(state: &State) -> Value {
    let value = demlik_tea::data::plain_data(state).unwrap();
    wire::normalized(&demlik_tea::data::decode_json(&stringify_json(&value).unwrap()).unwrap())
}
fn err_view(
    error: &llm::LlmErr<JsText, HostValue>,
    expected: &Option<Rc<HostValue>>,
    carrier: Option<&Rejected<HostValue>>,
) -> Value {
    let same = match &error.error {
        LlmCause::Value(value) => {
            expected.as_ref().is_some_and(|e| Rc::ptr_eq(value, e))
                && !matches!(&value.plain,PlainData::Number(n)if n.is_nan())
        }
        LlmCause::Undefined => expected.is_none(),
        LlmCause::Carrier(value) => carrier.is_some_and(|e| value.details.same(e)),
        _ => false,
    };
    json!({"key":text(&error.key),"purpose":text(&error.purpose),"reason":text(&error.reason),"sameCause":same,"undefined":matches!(&error.error,LlmCause::Undefined)})
}

fn failure(error: llm::LlmCallError) -> Value {
    match error {
        llm::LlmCallError::Description(error)
        | llm::LlmCallError::Resilience(
            demlik_tea::resilience::resilient_call::ResilientError::Record(error),
        ) => json!({"name":error.name,"message":error.message}),
        error => json!({"name":"NativeRefusal","message":format!("{error:?}")}),
    }
}
fn pure(script: Pure) -> Value {
    let calls = Calls::default();
    let draws = Rc::new(Cell::new(0));
    let sampled = draws.clone();
    let rng: Vec<f64> = script.rng.into_iter().map(Number::value).collect();
    assert!(!rng.is_empty());
    let visits = Rc::new(Cell::new(0));
    let schema_cause = Rc::new(HostValue {
        plain: PlainData::Object(Default::default()),
        message: Some(RefCell::new("schema rejected".into())),
    });
    let schemas = Rc::new(RefCell::new(BTreeMap::<JsText, Rc<Parser>>::new()));
    for (purpose, mode) in [("plan", Mode::Plan), ("report", Mode::Report)] {
        schemas.borrow_mut().insert(
            purpose.into(),
            Rc::new(Parser {
                mode,
                visits: visits.clone(),
                failure: schema_cause.clone(),
            }),
        );
    }
    let selected = schemas.clone();
    let mut config = Config::new(move |purpose: &JsText| {
        selected
            .borrow()
            .get(purpose)
            .expect("configured purpose")
            .clone()
    });
    config.retry = script.retry.map(|r| RetryPolicy {
        curve: BackoffCurve {
            base_ms: r.base_ms.value(),
            factor: r.factor.value(),
            cap_ms: r.cap_ms.value(),
            jitter: r.jitter,
        },
        budget: CountBound {
            max_attempts: r.max_attempts.value(),
        },
    });
    let knob: Knob = observe!(&calls, LlmCall::new, config, describe).with_rng(move || {
        let n = sampled.get();
        sampled.set(n + 1);
        rng[n.min(rng.len() - 1)]
    });
    let mut state = observe!(&calls, LlmCall::init, &knob);
    let mut slots = BTreeMap::new();
    let mut last: Option<Rc<llm::LlmMsg<JsText, PlainData, PlainData, HostValue>>> = None;
    let mut expected = None;
    let mut history = vec![];
    for action in script.actions {
        let previous = state.clone();
        let before = stored(&previous);
        let mut commands = vec![];
        let mut response = Value::Null;
        let mut error = Value::Null;
        let result: Result<(), Value> = (|| {
            match action {
                Action::Attempt {
                    purpose,
                    model,
                    payload,
                    at,
                    key,
                    slot,
                } => {
                    let input = Rc::new(Request::new(
                        JsText::from(purpose),
                        model.map(Into::into),
                        data(&payload),
                    ));
                    let step = match key {
                        Some(key) => observe!(
                            &calls,
                            LlmCall::attempt_keyed,
                            &knob,
                            &state,
                            JsText::from(key),
                            input,
                            at.value()
                        ),
                        None => {
                            observe!(&calls, LlmCall::attempt, &knob, &state, input, at.value())
                        }
                    }
                    .map_err(failure)?;
                    state = step.state;
                    commands = step.commands;
                    if let Some(cmd) = commands.first() {
                        slots.insert(slot, (cmd.input().key.clone(), cmd.input().input.clone()));
                    }
                }
                Action::Decode {
                    slot,
                    raw,
                    at,
                    apply,
                } => {
                    let (key, input) = slots.get(&slot).expect("stored command");
                    let cmd = observe!(
                        &calls,
                        demlik_tea::command::CmdDef::from_record,
                        observe!(&calls, LlmCall::run, &knob),
                        demlik_tea::resilience::resilient_call::RunInput {
                            key: key.clone(),
                            input: input.clone()
                        }
                    );
                    let outcome =
                        observe!(&calls, LlmCall::decode, &knob, &cmd, data(&raw)).unwrap();
                    expected = if matches!(&outcome, Outcome::Err { .. }) {
                        Some(schema_cause.clone())
                    } else {
                        None
                    };
                    response = snapshot(&outcome);
                    let msg = observe!(
                        &calls,
                        demlik_tea::command::CmdDef::settle,
                        observe!(&calls, LlmCall::run, &knob),
                        cmd,
                        Some(outcome),
                        at.value()
                    )
                    .unwrap()
                    .unwrap();
                    last = Some(Rc::new(msg));
                    if apply {
                        let msg = last.as_ref().unwrap();
                        let step = if matches!(msg.outcome(), Settlement::Ok(_)) {
                            observe!(&calls, LlmCall::succeed, &knob, &state, msg)
                        } else {
                            observe!(&calls, LlmCall::fail, &knob, &state, msg)
                        }
                        .map_err(failure)?;
                        state = step.state;
                        commands = step.commands;
                    }
                }
                Action::Reject {
                    slot,
                    cause,
                    field,
                    at,
                    apply,
                } => {
                    let (key, input) = slots.get(&slot).expect("stored command");
                    let cmd = observe!(&calls, LlmCall::run, &knob).from_record(
                        demlik_tea::resilience::resilient_call::RunInput {
                            key: key.clone(),
                            input: input.clone(),
                        },
                    );
                    let value = match cause {
                        Cause::Value { value } => {
                            let plain = data(&value);
                            if matches!(plain, PlainData::Undefined) {
                                None
                            } else {
                                Some(Rc::new(HostValue {
                                    plain,
                                    message: None,
                                }))
                            }
                        }
                        Cause::Error { message } => Some(Rc::new(HostValue {
                            plain: PlainData::Object(Default::default()),
                            message: Some(RefCell::new(message.into())),
                        })),
                        Cause::Undefined => None,
                    };
                    let value = value
                        .as_ref()
                        .map_or(CallValue::Undefined, |v| CallValue::shared(v.clone()));
                    expected = match field {
                        Field::Missing => None,
                        _ => match &value {
                            CallValue::Shared(value) => Some(value.clone()),
                            _ => None,
                        },
                    };
                    let error = match field {
                        Field::Own => {
                            let Outcome::Err { error } =
                                observe!(&calls, LlmCall::rejected, &knob, value)
                            else {
                                unreachable!()
                            };
                            error
                        }
                        Field::Missing => RunError::port_rejected(
                            Rejected::from_field(CauseField::Missing, Default::default()).unwrap(),
                        ),
                        Field::Inherited => RunError::port_rejected(
                            Rejected::from_field(CauseField::Inherited(value), Default::default())
                                .unwrap(),
                        ),
                    };
                    let own = matches!(error.details.cause(), CauseField::Own(_));
                    response = json!({"hasCause":!matches!(error.details.cause(),CauseField::Missing),"ownCause":own});
                    let msg = observe!(
                        &calls,
                        demlik_tea::command::CmdDef::settle,
                        observe!(&calls, LlmCall::run, &knob),
                        cmd,
                        Some(Outcome::err(error)),
                        at.value()
                    )
                    .unwrap()
                    .unwrap();
                    last = Some(Rc::new(msg));
                    if apply {
                        let step =
                            observe!(&calls, LlmCall::fail, &knob, &state, last.as_ref().unwrap())
                                .map_err(failure)?;
                        state = step.state;
                        commands = step.commands;
                    }
                }
                Action::ErrOf => {
                    let msg = last.as_ref().unwrap();
                    let carrier = match msg.outcome() {
                        Settlement::Err(demlik_tea::command::Failure::Declared(e)) => {
                            Some(&e.details)
                        }
                        _ => None,
                    };
                    let parsed = observe!(&calls, LlmCall::err_of, &knob, msg).map_err(failure)?;
                    response = err_view(&parsed, &expected, carrier);
                }
                Action::Fail => {
                    let step =
                        observe!(&calls, LlmCall::fail, &knob, &state, last.as_ref().unwrap())
                            .map_err(failure)?;
                    state = step.state;
                    commands = step.commands;
                }
                Action::Succeed => {
                    let step = observe!(
                        &calls,
                        LlmCall::succeed,
                        &knob,
                        &state,
                        last.as_ref().unwrap()
                    )
                    .map_err(failure)?;
                    state = step.state;
                    commands = step.commands;
                }
                Action::MutateCause { message } => {
                    if let Some(value) = &expected {
                        *value.message.as_ref().expect("actual Error").borrow_mut() =
                            message.into();
                    }
                }
                Action::FireNext { slot } => {
                    if let Some(timer) = observe!(&calls, LlmCall::timer, &knob, &state) {
                        let step = observe!(&calls, LlmCall::on_timer, &knob, &state, &timer.msg)
                            .map_err(failure)?;
                        state = step.state;
                        commands = step.commands;
                        if let Some(cmd) = commands.first() {
                            slots
                                .insert(slot, (cmd.input().key.clone(), cmd.input().input.clone()));
                        }
                    }
                }
                Action::Timer { id, at, slot } => {
                    let step = observe!(
                        &calls,
                        LlmCall::on_timer,
                        &knob,
                        &state,
                        &DeadlineExceeded {
                            kind: "deadline_exceeded".into(),
                            id: id.into(),
                            at_ms: at.value().into()
                        }
                    )
                    .map_err(failure)?;
                    state = step.state;
                    commands = step.commands;
                    if let Some(cmd) = commands.first() {
                        slots.insert(slot, (cmd.input().key.clone(), cmd.input().input.clone()));
                    }
                }
                Action::Schema { purpose, mode } => {
                    schemas.borrow_mut().insert(
                        purpose.into(),
                        Rc::new(Parser {
                            mode,
                            visits: visits.clone(),
                            failure: schema_cause.clone(),
                        }),
                    );
                }
                Action::SchemaOf { purpose } => {
                    let purpose = JsText::from(purpose);
                    let actual = observe!(&calls, LlmCall::schema_of, &knob, &purpose);
                    response =
                        json!({"same":Rc::ptr_eq(&actual,schemas.borrow().get(&purpose).unwrap())});
                }
                Action::RoundTrip => {
                    let encoded =
                        stringify_json(&demlik_tea::data::plain_data(&state).unwrap()).unwrap();
                    state = serde_json::from_str(&encoded)
                        .map_err(|e| json!({"name":"Error","message":e.to_string()}))?;
                }
                Action::RoundTripMsg => {
                    let encoded = stringify_json(
                        &demlik_tea::data::plain_data(last.as_ref().unwrap().as_ref()).unwrap(),
                    )
                    .unwrap();
                    last = Some(Rc::new(
                        serde_json::from_str(&encoded)
                            .map_err(|e| json!({"name":"Error","message":e.to_string()}))?,
                    ));
                    expected = None;
                }
                Action::Restore { encoded } => {
                    state = serde_json::from_str(&encoded)
                        .map_err(|e| json!({"name":"Error","message":e.to_string()}))?;
                }
                Action::Lift => {
                    struct Host {
                        resilience: State,
                        token: Rc<()>,
                    }
                    let token = Rc::new(());
                    let result = observe!(
                        &calls,
                        llm::lift_llm_call,
                        Host {
                            resilience: state.clone(),
                            token: token.clone()
                        },
                        Step::new(state.clone(), Vec::<()>::new()),
                        |mut host, s| {
                            host.resilience = s;
                            host
                        }
                    );
                    response = json!({"sameToken":Rc::ptr_eq(&token,&result.state.token),"cmds":result.commands.len()});
                    state = result.state.resilience;
                }
            }
            Ok(())
        })();
        if let Err(failure) = result {
            error = failure;
        }
        history.push(json!({"storedState":stored(&state),"sameState":state.same(&previous),"priorUnchanged":before==stored(&previous),"cmds":snapshot(&commands),"deadlines":observe!(&calls,LlmCall::deadlines,&knob,&state).iter().map(|d|{let mut v=snapshot(d);v.as_object_mut().unwrap().insert("name".into(),d.name.as_ref().map_or(json!({"$undefined":true}),|s|json!(s)));v}).collect::<Vec<_>>(),"timer":snapshot(&observe!(&calls,LlmCall::timer,&knob,&state)),"response":response,"error":error,"rngCalls":draws.get(),"parseCalls":visits.get()}));
    }
    json!({"value":{"name":observe!(&calls,LlmCall::name,&knob),"history":history},"calls":calls.borrow().as_slice()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let line = line.unwrap();
                let input: Input = serde_json::from_str(&line).unwrap();
                let output = match input.input {
                    Script::Pure { script } => pure(script),
                    Script::Runtime { profile, mode } => {
                        consumer::run(
                            match profile.as_str() {
                                "promise" => demlik_tea::runtime::Profile::Promise,
                                "effect" => demlik_tea::runtime::Profile::Effect,
                                _ => panic!("profile"),
                            },
                            &mode,
                        )
                        .await
                    }
                };
                println!("{}", json!({"id":input.id,"output":output}));
            }
        })
        .await;
}
