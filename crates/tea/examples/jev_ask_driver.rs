use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, TryUpdate,
    command::{
        CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Outcome,
        Settlement,
    },
    core::try_subscriptions,
    data::{JsText, decode_json, plain_data, stringify_json},
    describe_error::ErrorView,
    jev::{
        JevRequest, JevText, Question, Questions,
        ask::{self, JevAsk, JevAskConfig, JevAskError},
        reply::{HttpReply, JevAskErr},
    },
    resilience::{
        deadline::DeadlineExceeded,
        resilient_call::{CallFailure, CallPhase, CallValue, RunError, RunInput, RunSpec},
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
};

macro_rules! observe {
    ($obs:expr, $method:path $(, $arg:expr)* $(,)?) => {{
        $obs.trace.borrow_mut().push(stringify!($method));
        $method($($arg),*)
    }};
}

#[derive(Deserialize)]
struct Input {
    id: String,
    kind: String,
    scenario: String,
    profile: Option<String>,
    key: Option<String>,
    content: Option<String>,
    at: Option<f64>,
    stamp: Option<f64>,
}
fn js(value: &impl Serialize) -> Value {
    serde_json::from_str(&bytes(value)).unwrap()
}
fn bytes(value: &impl Serialize) -> String {
    stringify_json(&plain_data(value).unwrap()).unwrap()
}
fn questions() -> Rc<Questions> {
    Rc::new(
        [(
            "category".into(),
            Question::Choice {
                instructions: JevText::Text("Which invoice budget?".into()),
                criteria: [
                    ("freight".into(), Some(JevText::Text("Shipping".into()))),
                    (
                        "office".into(),
                        Some(JevText::Text("Office supplies".into())),
                    ),
                ]
                .into_iter()
                .collect(),
            },
        )]
        .into_iter()
        .collect(),
    )
}
fn body() -> PlainData {
    decode_json(r#"{"model":"jev-invoice","usage":{"input_tokens":11,"output_tokens":3},"answers":{"category":{"type":"choice","choice":"freight","confidence":0.9,"probabilities":{"freight":0.9,"office":0.1}}}}"#).unwrap()
}
#[derive(Clone, Deserialize, Serialize)]
struct Fields {
    left: String,
    right: String,
}
fn wire_case(input: &Input) -> (Value, Value) {
    let observations = Observations::default();
    let raw = match input.scenario.as_str() {
        "first" => r#"{"_tag":"port_rejected","left":"L","right":"R"}"#,
        "middle" => r#"{"left":"L","_tag":"port_rejected","right":"R"}"#,
        "authority" => r#"{"left":"L","_tag":"deadline_exceeded","right":"R"}"#,
        "last" => r#"{"left":"L","right":"R","_tag":"port_rejected"}"#,
        "deadline" => r#"{"_tag":"deadline_exceeded","left":"L","right":"R"}"#,
        "jev" => {
            let cause = Rc::new(JevAskErr::HttpTerminal {
                status: 401.0.into(),
            });
            let rejected = observe!(
                &observations,
                demlik_tea::jev::reply::JevRejected::new,
                Rc::clone(&cause)
            );
            let error = observe!(
                &observations,
                demlik_tea::jev::reply::JevRejected::into_run_error,
                rejected
            )
            .clone();
            let encoded = bytes(&error);
            let definition = demlik_tea::command::CmdDef::<
                RunSpec<String, (), demlik_tea::jev::reply::JevFailureDetails>,
            >::new();
            let command = definition.from_record(RunInput {
                key: "invoice:104".into(),
                input: CallValue::value("invoice".into()),
            });
            let message = observe!(
                &observations,
                demlik_tea::command::CmdDef::<
                    RunSpec<String, (), demlik_tea::jev::reply::JevFailureDetails>,
                >::settle_in,
                &definition,
                command,
                Some(Outcome::err(error)),
                &CommandEdge::new(|| 42.)
            )
            .unwrap()
            .unwrap();
            let Settlement::Err(declared) = message.outcome() else {
                unreachable!()
            };
            let demlik_tea::command::Failure::Declared(error) = declared else {
                unreachable!()
            };
            return (
                json!({"error":js(error),"errorBytes":encoded,"roundtripBytes":bytes(&decode_json(&encoded).unwrap()),"message":js(&message),"messageBytes":bytes(&message),"originalError":Rc::ptr_eq(&error.details.jev,&cause)}),
                json!({"nativeTrace":observations.trace.borrow().as_slice(),"originalSame":Rc::ptr_eq(&error.details.jev,&cause)}),
            );
        }
        _ => panic!("wire scenario"),
    };
    let decoded: RunError<Rc<Fields>> = serde_json::from_str(raw).unwrap();
    let mut error = decoded.clone();
    if input.scenario == "authority" {
        error.kind = demlik_tea::resilience::resilient_call::RunErrorKind::PortRejected;
    }
    let original = Rc::clone(&error.details);
    let encoded = bytes(&error);
    let restored: RunError<Rc<Fields>> = serde_json::from_str(&encoded).unwrap();
    let definition = demlik_tea::command::CmdDef::<RunSpec<String, (), Rc<Fields>>>::new();
    let command = definition.from_record(RunInput {
        key: "invoice:104".into(),
        input: CallValue::value("invoice".into()),
    });
    let message = observe!(
        &observations,
        demlik_tea::command::CmdDef::<RunSpec<String, (), Rc<Fields>>>::settle_in,
        &definition,
        command,
        Some(Outcome::err(error)),
        &CommandEdge::new(|| 42.)
    )
    .unwrap()
    .unwrap();
    let Settlement::Err(declared) = message.outcome() else {
        unreachable!()
    };
    let demlik_tea::command::Failure::Declared(error) = declared else {
        unreachable!()
    };
    (
        json!({"error":js(error),"errorBytes":encoded,"roundtripBytes":bytes(&restored),"message":js(&message),"messageBytes":bytes(&message),"originalError":Rc::ptr_eq(&error.details,&original)}),
        json!({"nativeTrace":observations.trace.borrow().as_slice(),"originalSame":Rc::ptr_eq(&error.details,&original)}),
    )
}
enum Message {
    Ask {
        key: String,
        content: Rc<JevText>,
        at: f64,
    },
    Settled(ask::JevMsg),
    Timer(DeadlineExceeded),
}
impl Tagged for Message {
    fn tag(&self) -> &str {
        match self {
            Self::Ask { .. } => "ask",
            Self::Settled(message) => message.tag(),
            Self::Timer(message) => message.tag(),
        }
    }
}
#[derive(Serialize)]
#[serde(transparent)]
struct Run(ask::RunCmd);
impl Tagged for Run {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
impl CommandFamily for Run {
    type Msg = Message;
    type Completion = Completion<ask::RunSpec>;
    fn is_defined(&self) -> bool {
        self.0.is_defined()
    }
    fn engine_stamp(message: &Message) -> Option<&EngineStamp> {
        match message {
            Message::Settled(msg) => msg.engine_stamp(),
            _ => None,
        }
    }
    fn settle(
        self,
        value: Self::Completion,
        at: f64,
    ) -> Result<Vec<Message>, CommandContractError> {
        self.0
            .settle(value, at)
            .map(|rows| rows.into_iter().map(Message::Settled).collect())
    }
    fn settle_in(
        self,
        value: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Message>, CommandContractError> {
        self.0
            .settle_in(value, edge)
            .map(|rows| rows.into_iter().map(Message::Settled).collect())
    }
}
#[derive(Default)]
struct Observations {
    frames: RefCell<Vec<Value>>,
    calls: RefCell<Vec<Value>>,
    commands: RefCell<Vec<Value>>,
    outcomes: RefCell<Vec<Value>>,
    settlements: RefCell<Vec<Value>>,
    diagnostics: RefCell<Vec<String>>,
    request: RefCell<Option<Rc<JevRequest>>>,
    last_error: RefCell<Option<Rc<JevAskErr>>>,
    identities: Cell<usize>,
    original: Cell<bool>,
    stamps: Cell<usize>,
    error_checks: Cell<usize>,
    trace: RefCell<Vec<&'static str>>,
}
impl Observations {
    fn same_request(&self, request: &Rc<JevRequest>) {
        let original = self.request.borrow();
        self.original
            .set(self.original.get() && original.as_ref().is_some_and(|x| Rc::ptr_eq(x, request)));
    }
}
struct Handler {
    ask: Rc<JevAsk<'static>>,
    observations: Rc<Observations>,
    queue: RefCell<VecDeque<Value>>,
    offline: bool,
}
impl Interpreter<Run> for Handler {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Run,
        _: CommandContext<Message, Infallible>,
    ) -> Option<CommandWork<'a, SelfCompletion, Infallible>> {
        Some(CommandWork::new(async move {
            let obs = &self.observations;
            let CallValue::Shared(request) = &command.0.input().input else {
                panic!("shared request")
            };
            obs.same_request(request);
            obs.identities.set(obs.identities.get() + 1);
            obs.commands.borrow_mut().push(js(command));
            let outcome = if self.offline {
                observe!(
                    obs,
                    demlik_tea::jev::ask::JevAsk::offline,
                    &self.ask,
                    request
                )
            } else {
                let status = self.queue.borrow_mut().pop_front().unwrap_or(json!(200));
                obs.calls.borrow_mut().push(status.clone());
                if status == "throw" {
                    observe!(
                        obs,
                        demlik_tea::jev::ask::JevAsk::rejected,
                        &self.ask,
                        ErrorView::ErrorMessage(&JsText::from("socket invoice"))
                    )
                    .unwrap()
                } else {
                    let payload = if status == 200 {
                        body()
                    } else {
                        PlainData::Null
                    };
                    observe!(
                        obs,
                        demlik_tea::jev::ask::JevAsk::decode,
                        &self.ask,
                        request,
                        HttpReply {
                            status: status.as_f64().unwrap(),
                            body: &payload
                        }
                    )
                }
            };
            if let Outcome::Err { error } = &outcome {
                *obs.last_error.borrow_mut() = Some(Rc::clone(&error.details.jev));
            }
            obs.outcomes.borrow_mut().push(js(&outcome));
            Ok(Some(outcome))
        }))
    }
}
type SelfCompletion = Completion<ask::RunSpec>;
async fn factory_case(input: &Input) -> (Value, Value) {
    let mut config = JevAskConfig::new(questions()).with_retry(RetryPolicy {
        curve: BackoffCurve {
            base_ms: 100.,
            factor: 2.,
            cap_ms: 1000.,
            jitter: Jitter::Full,
        },
        budget: CountBound { max_attempts: 3. },
    });
    if input.scenario == "named" {
        config.name = Some("invoice".into());
        config.model = Some("jev-named".into());
    }
    let observations = Rc::new(Observations::default());
    observations.original.set(true);
    let ask =
        Rc::new(observe!(&observations, demlik_tea::jev::ask::JevAsk::new, config).with_rng(|| 0.));
    let reduced = Rc::clone(&ask);
    let init = Rc::clone(&ask);
    let obs = Rc::clone(&observations);
    let stamp = input.stamp.unwrap();
    let machine: Machine<'static, ask::State, Message, Run, Sub<()>, (), JevAskError> = Machine {
        init: Box::new(move |loaded, _| Step::new(loaded.unwrap_or_else(|| init.init()), vec![])),
        update: TryUpdate::try_reducer_with_types(
            vec![
                "ask".into(),
                ask.run().ok_type(),
                ask.run().err_type(),
                if input.scenario == "named" {
                    "invoice_deadline".into()
                } else {
                    "deadline_exceeded".into()
                },
            ],
            move |state, msg| {
                let (op, step) = match msg {
                    Message::Ask { key, content, at } => {
                        let step = observe!(
                            &obs,
                            demlik_tea::jev::ask::JevAsk::attempt,
                            &reduced,
                            state,
                            key.as_str(),
                            Rc::clone(content),
                            *at
                        )?;
                        let CallValue::Shared(request) = &step.commands[0].input().input else {
                            panic!("request")
                        };
                        *obs.request.borrow_mut() = Some(Rc::clone(request));
                        ("attempt", step)
                    }
                    Message::Settled(message) => {
                        let CallValue::Shared(request) = &message.cmd().input().input else {
                            panic!("request")
                        };
                        obs.same_request(request);
                        assert_eq!(message.at().unwrap().number(), Some(stamp));
                        assert!(message.engine_stamp().is_some());
                        obs.stamps.set(obs.stamps.get() + 1);
                        obs.settlements.borrow_mut().push(js(message));
                        match message.outcome() {
                            Settlement::Ok(_) => (
                                "succeed",
                                observe!(
                                    &obs,
                                    demlik_tea::jev::ask::JevAsk::succeed,
                                    &reduced,
                                    state,
                                    message
                                )?,
                            ),
                            Settlement::Err(_) => {
                                let error = observe!(
                                    &obs,
                                    demlik_tea::jev::ask::JevAsk::err_of,
                                    &reduced,
                                    message
                                )?;
                                obs.original.set(
                                    obs.original.get()
                                        && obs
                                            .last_error
                                            .borrow()
                                            .as_ref()
                                            .is_some_and(|x| Rc::ptr_eq(&error, x)),
                                );
                                obs.error_checks.set(obs.error_checks.get() + 1);
                                let step = observe!(
                                    &obs,
                                    demlik_tea::jev::ask::JevAsk::fail,
                                    &reduced,
                                    state,
                                    message
                                )?;
                                if matches!(
                                    step.state.call(&message.cmd().input().key),
                                    Some(CallPhase::WaitingRetry { .. })
                                ) {
                                    let retry = step
                                        .state
                                        .snapshot()
                                        .retry
                                        .own_entries()
                                        .find(|(key, _)| *key == &message.cmd().input().key)
                                        .map(|(_, value)| value);
                                    let same = matches!(retry,Some(demlik_tea::js_record::RecordValue::Entry(progress)) if progress.last_error.as_ref().is_some_and(|last|matches!(last.as_ref(),CallFailure::External(actual)if Rc::ptr_eq(actual,&error))));
                                    obs.original.set(obs.original.get() && same);
                                    obs.error_checks.set(obs.error_checks.get() + 1);
                                }
                                if let Some(CallPhase::Failed { error: stored }) =
                                    step.state.call(&message.cmd().input().key)
                                {
                                    obs.original.set(obs.original.get()&&matches!(stored.as_ref(),CallFailure::External(e)if Rc::ptr_eq(e,&error)));
                                    obs.identities.set(obs.identities.get() + 1);
                                }
                                ("fail", step)
                            }
                        }
                    }
                    Message::Timer(message) => (
                        "timer",
                        observe!(
                            &obs,
                            demlik_tea::jev::ask::JevAsk::on_timer,
                            &reduced,
                            state,
                            message
                        )?,
                    ),
                };
                obs.frames
                    .borrow_mut()
                    .push(json!({"op":op,"state":js(&step.state),"commands":js(&step.commands)}));
                Ok(step.map(|s| s, Run))
            },
        ),
        subscriptions: try_subscriptions(|_| Ok(vec![])),
    };
    let statuses = match input.scenario.as_str() {
        "retry429" => vec![json!(429), json!(200)],
        "terminal401" => vec![json!(401)],
        "exhaust429" => vec![json!(429), json!(429), json!(429)],
        "thrownRetry" => vec![json!("throw"), json!(200)],
        "offline" => vec![],
        "named" => vec![json!(200)],
        _ => panic!("factory scenario"),
    };
    let mut options: Options<
        ask::State,
        Message,
        Infallible,
        Infallible,
        runtime::NoEvent,
        JevAskError,
    > = Options::new(if input.profile.as_deref() == Some("promise") {
        Profile::Promise
    } else {
        Profile::Effect
    });
    options.clock = Rc::new(move || stamp);
    let reports = Rc::clone(&observations);
    options.on_error = Some(Rc::new(move |error, _| {
        reports.diagnostics.borrow_mut().push(error.name().into())
    }));
    let live = observe!(
        &observations,
        demlik_tea::runtime::try_launch,
        machine,
        (),
        Handler {
            ask: Rc::clone(&ask),
            observations: Rc::clone(&observations),
            queue: RefCell::new(statuses.into()),
            offline: input.scenario == "offline"
        },
        NoSubscriptions::new(),
        options
    );
    live.ready().await.unwrap();
    live.dispatch(Message::Ask {
        key: input.key.clone().unwrap(),
        content: Rc::new(JevText::Text(input.content.clone().unwrap().into())),
        at: input.at.unwrap(),
    })
    .await
    .unwrap();
    live.idle().await.unwrap();
    for _ in 0..5 {
        let state = live.get_state().unwrap();
        let timer = observe!(
            &observations,
            demlik_tea::jev::ask::JevAsk::timer,
            &ask,
            &state
        );
        observations.frames.borrow_mut().push(json!({"op":"observe","deadlines":js(&observe!(&observations, demlik_tea::jev::ask::JevAsk::deadlines, &ask, &state)),"timer":timer.as_ref().map_or(Value::Null,js)}));
        if !matches!(
            state.call(input.key.as_deref().unwrap()),
            Some(CallPhase::WaitingRetry { .. })
        ) {
            break;
        }
        live.dispatch(Message::Timer(timer.unwrap().msg))
            .await
            .unwrap();
        live.idle().await.unwrap();
    }
    let state = js(live.get_state().unwrap().as_ref());
    live.stop().await;
    let output = json!({"state":state,"frames":observations.frames.borrow().as_slice(),"calls":observations.calls.borrow().as_slice(),"commands":observations.commands.borrow().as_slice(),"outcomes":observations.outcomes.borrow().as_slice(),"settlements":observations.settlements.borrow().as_slice(),"identityChecks":observations.identities.get(),"diagnostics":observations.diagnostics.borrow().as_slice()});
    let evidence = json!({"originalSame":observations.original.get(),"stampChecks":observations.stamps.get(),"errorChecks":observations.error_checks.get(),"nativeTrace":observations.trace.borrow().as_slice()});
    (output, evidence)
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let input: Input = serde_json::from_str(&line.unwrap()).unwrap();
                let (output, evidence) = if input.kind == "wire" {
                    wire_case(&input)
                } else {
                    factory_case(&input).await
                };
                println!(
                    "{}",
                    json!({"id":input.id,"ok":true,"output":output,"evidence":evidence})
                );
            }
        })
        .await;
}
