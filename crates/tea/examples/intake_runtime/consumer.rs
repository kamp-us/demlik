use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandEdge, CommandFamily, EngineStamp, Outcome},
    core::Message,
    data::{JsText, NumberOrNull},
    idempotency::intake::{self, Config, Intake, IntakeValue, State},
    runtime::{
        self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence,
        Profile,
    },
    storage::{Migrated, Store, refuse},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};
pub type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
macro_rules! observe_async{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Slow,
    Done,
    Unfinished,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Bytes,
    Retained,
}
#[derive(Serialize, Deserialize)]
struct Hook {
    key: JsText,
    amount: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    charged_cents: f64,
}
#[derive(Serialize, Deserialize)]
struct Model {
    intake: Rc<State<Hook, Receipt>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "intake"
    }
}
enum Msg {
    Receive {
        payload: Rc<Hook>,
        at: NumberOrNull,
        id: JsText,
    },
    Claim {
        at: NumberOrNull,
    },
    Complete {
        key: JsText,
        result: Rc<Receipt>,
        at: NumberOrNull,
    },
    Boot,
    Notification(intake::Msg<Hook, Receipt>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Receive { .. } => "receive",
            Self::Claim { .. } => "claim",
            Self::Complete { .. } => "complete",
            Self::Boot => "boot",
            Self::Notification(m) => m.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &[
        "receive",
        "claim",
        "complete",
        "boot",
        "intake:process_ok",
        "intake:process_err",
        "intake:replay_ok",
        "intake:replay_err",
    ];
}
enum Cmd {
    Intake(intake::Cmd<Hook, Receipt>),
    Work { key: JsText, payload: Rc<Hook> },
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Intake(c) => c.tag(),
            Self::Work { .. } => "intake:work",
        }
    }
}
enum Completion {
    Defined(Option<Outcome<PlainData, intake::TransportFailure>>),
    Plain(Vec<Msg>),
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Completion;
    fn is_defined(&self) -> bool {
        matches!(self, Self::Intake(_))
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Notification(m) => <intake::Cmd<Hook, Receipt> as CommandFamily>::engine_stamp(m),
            _ => None,
        }
    }
    fn settle(self, c: Completion, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(c, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        c: Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, c) {
            (Self::Intake(cmd), Completion::Defined(c)) => Ok(cmd
                .settle_in(c, edge)?
                .into_iter()
                .map(Msg::Notification)
                .collect()),
            (Self::Work { .. }, Completion::Plain(m)) => Ok(m),
            _ => panic!("typed interpreter channel"),
        }
    }
}
fn message(msg: &Msg) -> Value {
    match msg {
        Msg::Receive { payload, at, id } => {
            json!({"type":"receive","payload":payload,"at":at,"id":id})
        }
        Msg::Claim { at } => json!({"type":"claim","at":at}),
        Msg::Complete { key, result, at } => {
            json!({"type":"complete","key":key,"result":result,"at":at})
        }
        Msg::Boot => json!({"type":"boot"}),
        Msg::Notification(m) => {
            let mut value = match m {
                intake::Msg::Process(m) => serde_json::to_value(m).unwrap(),
                intake::Msg::Replay(m) => serde_json::to_value(m).unwrap(),
            };
            if m.tag().ends_with("_ok") {
                value
                    .as_object_mut()
                    .unwrap()
                    .insert("value".into(), json!({"$undefined":true}));
            }
            value
        }
    }
}
fn command(cmd: &Cmd) -> Value {
    match cmd {
        Cmd::Intake(c) => serde_json::to_value(c).unwrap(),
        Cmd::Work { key, payload } => json!({"type":"intake:work","key":key,"payload":payload}),
    }
}
#[derive(Clone)]
enum Raw {
    Bytes(String),
    Retained(Rc<State<Hook, Receipt>>),
}
#[derive(Clone)]
struct Saved {
    storage: Storage,
    cell: Rc<RefCell<Option<Raw>>>,
    trace: Rc<RefCell<Vec<Value>>>,
}
impl Saved {
    fn snapshot(&self) -> Value {
        match self.cell.borrow().as_ref() {
            None => Value::Null,
            Some(Raw::Bytes(encoded)) => serde_json::from_str(encoded).unwrap(),
            Some(Raw::Retained(state)) => json!({"intake":state}),
        }
    }
}
impl Store<Model> for Saved {
    type Raw = Option<Raw>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Infallible> {
        let value = self.snapshot();
        self.trace
            .borrow_mut()
            .push(json!({"kind":"load","state":value}));
        Ok(self.cell.borrow().clone())
    }
    async fn save(&self, model: &Model) -> Result<(), Infallible> {
        let encoded = serde_json::to_string(model).unwrap();
        let value: Value = serde_json::from_str(&encoded).unwrap();
        self.trace
            .borrow_mut()
            .push(json!({"kind":"save","state":value}));
        *self.cell.borrow_mut() = Some(match self.storage {
            Storage::Bytes => Raw::Bytes(encoded),
            Storage::Retained => Raw::Retained(model.intake.clone()),
        });
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        match raw {
            None => Migrated::Fresh,
            Some(Raw::Retained(intake)) => Migrated::State(Model { intake }),
            Some(Raw::Bytes(encoded)) => match serde_json::from_str(&encoded) {
                Ok(model) => Migrated::State(model),
                Err(error) => Migrated::Refused(refuse(error.to_string())),
            },
        }
    }
}
struct Host {
    mode: Mode,
    finish: Rc<Cell<bool>>,
    workers: Rc<Cell<usize>>,
    processes: Rc<Cell<usize>>,
    replays: Rc<Cell<usize>>,
    trace: Rc<RefCell<Vec<Value>>>,
    // The actual runtime host owns a local callback; no model/context Send or
    // serde bound is introduced by the interpreter.
    capability: Box<dyn Fn() -> f64>,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        ctx: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Completion, Infallible>> {
        Some(CommandWork::new(async move {
            self.trace
                .borrow_mut()
                .push(json!({"kind":"handler","command":command(cmd)}));
            Ok(match cmd {
                Cmd::Intake(intake::Cmd::Process(_)) => {
                    self.processes.set(self.processes.get() + 1);
                    if !matches!(self.mode, Mode::Slow) {
                        ctx.dispatch(Msg::Claim { at: 1.0.into() }).unwrap();
                    }
                    Completion::Defined(Some(Outcome::ok(PlainData::Undefined)))
                }
                Cmd::Intake(intake::Cmd::Replay(_)) => {
                    self.replays.set(self.replays.get() + 1);
                    Completion::Defined(Some(Outcome::ok(PlainData::Undefined)))
                }
                Cmd::Work { key, payload } => {
                    self.workers.set(self.workers.get() + 1);
                    Completion::Plain(if self.finish.get() {
                        vec![Msg::Complete {
                            key: key.clone(),
                            result: Rc::new(Receipt {
                                charged_cents: payload.amount * (self.capability)(),
                            }),
                            at: 10.0.into(),
                        }]
                    } else {
                        vec![]
                    })
                }
            })
        }))
    }
}
fn machine(
    knob: Rc<Intake<'static, Hook, Receipt>>,
    calls: Calls,
) -> Machine<'static, Model, Msg, Cmd, Sub<PlainData>> {
    let init = knob.clone();
    let init_calls = calls.clone();
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(
                loaded.unwrap_or_else(|| Model {
                    intake: observe!(&init_calls, Intake::init, &init),
                }),
                vec![],
            )
        }),
        update: Update::reducer(move |model: &Model, msg: &Msg| {
            let next = match msg {
                Msg::Receive { payload, at, id } => observe!(
                    &calls,
                    Intake::receive,
                    &knob,
                    &model.intake,
                    payload.clone(),
                    *at,
                    id.clone()
                )
                .unwrap(),
                Msg::Complete { key, result, at } => observe!(
                    &calls,
                    Intake::complete,
                    &knob,
                    &model.intake,
                    key.clone(),
                    IntakeValue::Value(result.clone()),
                    *at
                )
                .unwrap(),
                Msg::Boot => observe!(&calls, Intake::boot, &knob, &model.intake).unwrap(),
                Msg::Claim { at } => {
                    return match observe!(&calls, Intake::claim_next, &knob, &model.intake, *at)
                        .unwrap()
                    {
                        Some(claim) => Step::new(
                            Model {
                                intake: claim.state,
                            },
                            vec![Cmd::Work {
                                key: claim.claimed.input.key.clone(),
                                payload: claim.claimed.input.clone(),
                            }],
                        ),
                        None => Step::new(
                            Model {
                                intake: model.intake.clone(),
                            },
                            vec![],
                        ),
                    };
                }
                Msg::Notification(_) => Step::new(model.intake.clone(), vec![]),
            };
            Step::new(
                Model { intake: next.state },
                next.commands.into_iter().map(Cmd::Intake).collect(),
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_: &Model| vec![]),
    }
}
pub async fn run(profile: Profile, mode: Mode, storage: Storage) -> Value {
    let calls = Calls::default();
    let trace = Rc::new(RefCell::new(vec![]));
    let saved = Saved {
        storage,
        cell: Rc::new(RefCell::new(None)),
        trace: trace.clone(),
    };
    let workers = Rc::new(Cell::new(0));
    let processes = Rc::new(Cell::new(0));
    let replays = Rc::new(Cell::new(0));
    let finish = Rc::new(Cell::new(matches!(mode, Mode::Done)));
    let knob = Rc::new(observe!(
        &calls,
        Intake::new,
        Config::new(|p: &Hook| Ok(p.key.clone())).with_ttl(1000.0)
    ));
    let mut snapshots = vec![];
    for life in 0..2 {
        let mut options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
        options.clock = Rc::new(|| 123.25);
        options.store = Some(Persistence::new(saved.clone()));
        let commits = trace.clone();
        options.on_commit.push(Rc::new(move |msg, model| {
            commits
                .borrow_mut()
                .push(json!({"kind":"commit","msg":msg.map(message),"state":model}))
        }));
        let runtime = observe!(
            &calls,
            runtime::launch,
            machine(knob.clone(), calls.clone()),
            (),
            Host {
                mode,
                finish: finish.clone(),
                workers: workers.clone(),
                processes: processes.clone(),
                replays: replays.clone(),
                trace: trace.clone(),
                capability: Box::new(|| 100.0)
            },
            NoSubscriptions::new(),
            options
        );
        observe_async!(&calls, runtime::Runtime::ready, &runtime).unwrap();
        if life == 0 {
            observe_async!(
                &calls,
                runtime::Runtime::dispatch,
                &runtime,
                Msg::Receive {
                    payload: Rc::new(Hook {
                        key: "evt_1".into(),
                        amount: 5.0
                    }),
                    at: 0.0.into(),
                    id: "q1".into()
                }
            )
            .unwrap();
            observe_async!(&calls, runtime::Runtime::idle, &runtime).unwrap();
            if matches!(mode, Mode::Slow) {
                observe_async!(
                    &calls,
                    runtime::Runtime::dispatch,
                    &runtime,
                    Msg::Receive {
                        payload: Rc::new(Hook {
                            key: "evt_1".into(),
                            amount: 5.0
                        }),
                        at: 2000.0.into(),
                        id: "q2".into()
                    }
                )
                .unwrap();
                observe_async!(&calls, runtime::Runtime::idle, &runtime).unwrap();
            }
        } else {
            finish.set(true);
            observe_async!(&calls, runtime::Runtime::dispatch, &runtime, Msg::Boot).unwrap();
            observe_async!(
                &calls,
                runtime::Runtime::dispatch,
                &runtime,
                Msg::Claim { at: 100.0.into() }
            )
            .unwrap();
            observe_async!(&calls, runtime::Runtime::idle, &runtime).unwrap();
            observe_async!(
                &calls,
                runtime::Runtime::dispatch,
                &runtime,
                Msg::Receive {
                    payload: Rc::new(Hook {
                        key: "evt_1".into(),
                        amount: 5.0
                    }),
                    at: 101.0.into(),
                    id: "duplicate".into()
                }
            )
            .unwrap();
            observe_async!(&calls, runtime::Runtime::idle, &runtime).unwrap();
        }
        let state = observe!(&calls, runtime::Runtime::get_state, &runtime).unwrap();
        snapshots.push(json!({"life":life,"state":state.as_ref(),"saved":saved.snapshot(),"workers":workers.get(),"processes":processes.get(),"replays":replays.get()}));
        observe_async!(&calls, runtime::Runtime::stop, &runtime);
    }
    json!({"value":{"snapshots":snapshots,"trace":trace.borrow().clone()},"calls":calls.borrow().clone()})
}
