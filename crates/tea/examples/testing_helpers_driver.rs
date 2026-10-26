use demlik_tea::{
    Machine, NoCellError, PlainData, Replay, Step, Sub, Subscription, Tagged, Update,
    core::{Row, subscriptions},
    data::plain_data,
    flow::poller::{Poller, PollerConfig, PollerPhase, PollerRetry, PollerState, create_poller},
    idempotency::{self, StoreOptions},
    resilience::deadline::deadline_sub,
    testing::{self, BoundMachine, CheckError, ReplayOpts},
    work_queue::QueueField,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::Arc,
};
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
use wire::Number;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Fail {
    Init,
    Update,
    Subs,
    MatcherError,
    MatcherPanic,
}
impl Fail {
    fn name(self) -> &'static str {
        match self {
            Self::Init => "init",
            Self::Update => "update",
            Self::Subs => "subs",
            Self::MatcherError => "matcherError",
            Self::MatcherPanic => "matcherPanic",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Form {
    Reducer,
    Transitions,
    Disambiguated,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CounterSeed {
    n: Number,
    done: bool,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum CounterMsg {
    Add { by: Number },
    Noop,
    Finish,
    Unknown,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Nullable {
    Number(Number),
    Null(()),
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Which {
    None,
    Pending,
    Ready,
}
#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
enum PollerSeed {
    Polling {
        tick: Number,
        #[serde(rename = "nextAt")]
        next_at: Nullable,
        last: Which,
    },
    Done {
        tick: Number,
        last: Which,
    },
    GaveUp {
        tick: Number,
        last: Which,
    },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum PollerMsg {
    Begin { at: Number },
    Deadline,
    Read { value: Which, at: Number },
    Unknown,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum CommandName {
    Boot,
    Added,
    Fetch,
}
impl CommandName {
    fn name(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Added => "added",
            Self::Fetch => "fetch",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandSeed {
    name: CommandName,
    n: Number,
}
#[derive(Deserialize)]
#[serde(tag = "name", rename_all = "camelCase", deny_unknown_fields)]
enum SubSeed {
    A { n: Number },
    B { n: Number },
    Deadline { at: Number },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Operation<S, M> {
    Step { state: S, msg: M },
    Replay,
    Final { expected: S },
    Contains { expected: CommandSeed },
    Commands { expected: Vec<CommandSeed> },
    Subs { expected: Vec<SubSeed> },
}
impl<S, M> Operation<S, M> {
    fn map<T, N>(
        self,
        mut state: impl FnMut(S) -> T,
        mut msg: impl FnMut(M) -> N,
    ) -> Operation<T, N> {
        match self {
            Self::Step { state: s, msg: m } => Operation::Step {
                state: state(s),
                msg: msg(m),
            },
            Self::Replay => Operation::Replay,
            Self::Final { expected } => Operation::Final {
                expected: state(expected),
            },
            Self::Contains { expected } => Operation::Contains { expected },
            Self::Commands { expected } => Operation::Commands { expected },
            Self::Subs { expected } => Operation::Subs { expected },
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CounterScript {
    bound: bool,
    form: Form,
    #[serde(default, deserialize_with = "present")]
    loaded: Option<CounterSeed>,
    delta: Number,
    boot: bool,
    subs: usize,
    messages: Vec<CounterMsg>,
    operation: Operation<CounterSeed, CounterMsg>,
    #[serde(default, deserialize_with = "present")]
    fail: Option<Fail>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PollerScript {
    bound: bool,
    #[serde(default, deserialize_with = "present")]
    loaded: Option<PollerSeed>,
    messages: Vec<PollerMsg>,
    operation: Operation<PollerSeed, PollerMsg>,
    #[serde(default, deserialize_with = "present")]
    fail: Option<Fail>,
}
#[derive(Deserialize)]
#[serde(tag = "scenario", rename_all = "camelCase")]
enum Script {
    Counter(CounterScript),
    Poller(PollerScript),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
struct Token {
    id: &'static str,
}
struct Counter {
    n: f64,
    done: bool,
    payload: Rc<Token>,
}
#[derive(Serialize)]
struct Reading {
    status: &'static str,
}
#[derive(Serialize)]
struct Fault;
struct PollerModel {
    poll: Rc<PollerState<Reading, Fault>>,
}
enum Model {
    Counter(Rc<Counter>),
    Poller(Rc<PollerModel>),
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        match self {
            Self::Counter(s) => {
                if s.done {
                    "done"
                } else {
                    "active"
                }
            }
            Self::Poller(_) => "(untagged state)",
        }
    }
}
enum Event {
    Add(f64),
    Noop,
    Finish,
    Unknown,
    Begin(f64),
    Deadline,
    Read(Rc<Reading>, f64),
}
impl Tagged for Event {
    fn tag(&self) -> &str {
        match self {
            Self::Add(_) => "add",
            Self::Noop => "noop",
            Self::Finish => "finish",
            Self::Unknown => "unknown",
            Self::Begin(_) => "begin",
            Self::Deadline => "deadline",
            Self::Read(..) => "read",
        }
    }
}
struct Command {
    name: String,
    n: f64,
    payload: Rc<Token>,
}
struct Cause {
    phase: &'static str,
    code: u32,
    capability: Box<dyn Fn() -> bool + Send + Sync>,
}
struct MatcherCause {
    phase: &'static str,
    code: u32,
    capability: Box<dyn Fn() -> bool>,
}
#[derive(Clone)]
struct Readings {
    pending: Rc<Reading>,
    ready: Rc<Reading>,
}
impl Readings {
    fn get(&self, which: Which) -> Option<Rc<Reading>> {
        match which {
            Which::None => None,
            Which::Pending => Some(Rc::clone(&self.pending)),
            Which::Ready => Some(Rc::clone(&self.ready)),
        }
    }
    fn reference(&self, value: &Rc<Reading>) -> Option<&'static str> {
        if Rc::ptr_eq(value, &self.pending) {
            Some("pending")
        } else if Rc::ptr_eq(value, &self.ready) {
            Some("ready")
        } else {
            None
        }
    }
}
fn counter(seed: CounterSeed, payload: &Rc<Token>) -> Model {
    Model::Counter(Rc::new(Counter {
        n: seed.n.value(),
        done: seed.done,
        payload: Rc::clone(payload),
    }))
}
fn counter_msg(msg: CounterMsg) -> Event {
    match msg {
        CounterMsg::Add { by } => Event::Add(by.value()),
        CounterMsg::Noop => Event::Noop,
        CounterMsg::Finish => Event::Finish,
        CounterMsg::Unknown => Event::Unknown,
    }
}
fn poller(seed: PollerSeed, r: &Readings) -> Model {
    let (phase, tick, last) = match seed {
        PollerSeed::Polling {
            tick,
            next_at,
            last,
        } => (
            PollerPhase::Polling {
                next_at_ms: match next_at {
                    Nullable::Number(n) => n.value().into(),
                    Nullable::Null(()) => demlik_tea::data::NumberOrNull(None),
                },
            },
            tick,
            last,
        ),
        PollerSeed::Done { tick, last } => (PollerPhase::Done, tick, last),
        PollerSeed::GaveUp { tick, last } => (PollerPhase::GaveUp, tick, last),
    };
    Model::Poller(Rc::new(PollerModel {
        poll: Rc::new(PollerState {
            phase,
            tick: tick.value().into(),
            last_result: r.get(last).map_or(QueueField::Absent, QueueField::Value),
            retry: Rc::new(PollerRetry::new()),
            dedupe: Rc::new(idempotency::init_store(StoreOptions::default())),
        }),
    }))
}
fn poller_msg(msg: PollerMsg, r: &Readings) -> Event {
    match msg {
        PollerMsg::Begin { at } => Event::Begin(at.value()),
        PollerMsg::Deadline => Event::Deadline,
        PollerMsg::Read { value, at } => Event::Read(r.get(value).expect("read value"), at.value()),
        PollerMsg::Unknown => Event::Unknown,
    }
}
fn same_model(a: &Model, b: &Model) -> bool {
    match (a, b) {
        (Model::Counter(a), Model::Counter(b)) => Rc::ptr_eq(a, b),
        (Model::Poller(a), Model::Poller(b)) => Rc::ptr_eq(a, b),
        _ => false,
    }
}
fn same_slice(a: &Model, b: &Model) -> Option<bool> {
    match (a, b) {
        (Model::Poller(a), Model::Poller(b)) => Some(Rc::ptr_eq(&a.poll, &b.poll)),
        _ => None,
    }
}
fn command_view(c: &Command) -> Value {
    json!({"type":c.name,"n":wire::number(c.n),"payload":{"id":c.payload.id}})
}
fn model_view(s: &Model, r: &Readings) -> Value {
    match s {
        Model::Counter(s) => {
            json!({"type":if s.done{"done"}else{"active"},"n":wire::number(s.n),"payload":{"id":s.payload.id}})
        }
        Model::Poller(model) => {
            let p = &model.poll;
            json!({"value":{"poll":serde_json::to_value(p).unwrap()},"lastOwn":!p.last_result.is_absent(),"lastUndefined":!matches!(p.last_result,QueueField::Value(_)),"lastRef":p.last_result.value().and_then(|v|r.reference(v))})
        }
    }
}
fn same_number(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}
fn model_equal(a: &Model, b: &Model) -> bool {
    match (a, b) {
        (Model::Counter(a), Model::Counter(b)) => {
            same_number(a.n, b.n) && a.done == b.done && Rc::ptr_eq(&a.payload, &b.payload)
        }
        (Model::Poller(a), Model::Poller(b)) => {
            let a = &a.poll;
            let b = &b.poll;
            serde_json::to_value(a).unwrap() == serde_json::to_value(b).unwrap()
                && match (a.last_result.value(), b.last_result.value()) {
                    (Some(a), Some(b)) => Rc::ptr_eq(a, b),
                    (None, None) => true,
                    _ => false,
                }
        }
        _ => false,
    }
}
fn cmd(seed: CommandSeed, payload: &Rc<Token>) -> Rc<Command> {
    Rc::new(Command {
        name: seed.name.name().to_owned(),
        n: seed.n.value(),
        payload: Rc::clone(payload),
    })
}
fn sub(seed: SubSeed) -> Sub<PlainData> {
    match seed {
        SubSeed::A { n } => {
            Sub::new("a", wire::data(&json!({"n":wire::number(n.value())}))).unwrap()
        }
        SubSeed::B { n } => {
            Sub::new("b", wire::data(&json!({"n":wire::number(n.value())}))).unwrap()
        }
        SubSeed::Deadline { at } => {
            let at = at.value();
            Sub::new(
                "deadline",
                plain_data(&vec![deadline_sub(format!("poller:tick:{}", at), at)]).unwrap(),
            )
            .unwrap()
        }
    }
}
type AppMachine = Machine<'static, Model, Event, Rc<Command>, Sub<PlainData>>;
struct World {
    machine: AppMachine,
    loaded: Option<Model>,
    messages: Vec<Event>,
    operation: Operation<Model, Event>,
    bound: bool,
    fail: Option<Fail>,
    cause: Arc<Cause>,
    matcher: Rc<MatcherCause>,
    log: Rc<RefCell<Vec<Value>>>,
    payload: Rc<Token>,
    readings: Readings,
}
fn world(script: Script) -> World {
    let payload = Rc::new(Token { id: "shared" });
    let readings = Readings {
        pending: Rc::new(Reading { status: "pending" }),
        ready: Rc::new(Reading { status: "ready" }),
    };
    let log = Rc::new(RefCell::new(vec![]));
    let (bound, fail) = match &script {
        Script::Counter(s) => (s.bound, s.fail),
        Script::Poller(s) => (s.bound, s.fail),
    };
    let phase = fail.map_or("none", Fail::name);
    let cause = Arc::new(Cause {
        phase,
        code: 17,
        capability: Box::new(|| true),
    });
    let matcher = Rc::new(MatcherCause {
        phase,
        code: 17,
        capability: Box::new(|| true),
    });
    let (machine, loaded, messages, operation) = match script {
        Script::Counter(s) => {
            let loaded = s.loaded.map(|s| counter(s, &payload));
            let messages = s.messages.into_iter().map(counter_msg).collect();
            let operation = s.operation.map(|s| counter(s, &payload), counter_msg);
            let row = || {
                let mut row: Row<'static, Model, Event, Rc<Command>> = Row::new();
                for kind in ["add", "noop", "finish"] {
                    let log = Rc::clone(&log);
                    let cause = Arc::clone(&cause);
                    row.insert(
                        kind.into(),
                        Box::new(move |state, event| {
                            let Model::Counter(s) = state else {
                                panic!("counter state")
                            };
                            log.borrow_mut().push(json!([
                                "cell",
                                state.tag(),
                                wire::number(s.n),
                                event.tag()
                            ]));
                            if matches!(fail, Some(Fail::Update)) {
                                std::panic::panic_any(Arc::clone(&cause));
                            }
                            match event {
                                Event::Noop => Step::new(Model::Counter(Rc::clone(s)), vec![]),
                                Event::Finish => Step::new(
                                    Model::Counter(Rc::new(Counter {
                                        n: s.n,
                                        done: true,
                                        payload: Rc::clone(&s.payload),
                                    })),
                                    vec![],
                                ),
                                Event::Add(by) => {
                                    let n = s.n + by;
                                    Step::new(
                                        Model::Counter(Rc::new(Counter {
                                            n,
                                            done: s.done,
                                            payload: Rc::clone(&s.payload),
                                        })),
                                        vec![Rc::new(Command {
                                            name: "added".into(),
                                            n,
                                            payload: Rc::clone(&s.payload),
                                        })],
                                    )
                                }
                                _ => panic!("counter cell"),
                            }
                        }),
                    );
                }
                row
            };
            let update = match s.form {
                Form::Reducer => Update::RawReducer(row()),
                Form::Transitions | Form::Disambiguated => Update::RawTransitions(
                    [("active".into(), row()), ("done".into(), row())]
                        .into_iter()
                        .collect(),
                ),
            };
            let initial_log = Rc::clone(&log);
            let initial_payload = Rc::clone(&payload);
            let initial_cause = Arc::clone(&cause);
            let initial_readings = readings.clone();
            let delta = s.delta.value();
            let boot = s.boot;
            let sub_log = Rc::clone(&log);
            let sub_cause = Arc::clone(&cause);
            let subs = s.subs;
            let machine: AppMachine = Machine {
                init: Box::new(move |loaded, _| {
                    initial_log.borrow_mut().push(json!([
                        "init",
                        loaded.as_ref().map(|s| model_view(s, &initial_readings))
                    ]));
                    if matches!(fail, Some(Fail::Init)) {
                        std::panic::panic_any(Arc::clone(&initial_cause));
                    }
                    let old = loaded.unwrap_or_else(|| {
                        Model::Counter(Rc::new(Counter {
                            n: 0.0,
                            done: false,
                            payload: Rc::clone(&initial_payload),
                        }))
                    });
                    let Model::Counter(old) = old else {
                        panic!("counter init")
                    };
                    let next = if delta == 0.0 {
                        old
                    } else {
                        Rc::new(Counter {
                            n: old.n + delta,
                            done: old.done,
                            payload: Rc::clone(&old.payload),
                        })
                    };
                    let commands = if boot {
                        vec![Rc::new(Command {
                            name: "boot".into(),
                            n: next.n,
                            payload: Rc::clone(&initial_payload),
                        })]
                    } else {
                        vec![]
                    };
                    Step::new(Model::Counter(next), commands)
                }),
                update,
                subscriptions: subscriptions(move |state: &Model| {
                    let Model::Counter(s) = state else {
                        panic!("counter subs")
                    };
                    let mut result = vec![];
                    for i in 0..subs {
                        sub_log.borrow_mut().push(json!([
                            "subs",
                            i,
                            state.tag(),
                            wire::number(s.n)
                        ]));
                        if matches!(fail, Some(Fail::Subs)) {
                            std::panic::panic_any(Arc::clone(&sub_cause));
                        }
                        result.push(
                            Sub::new(
                                if i == 0 { "a" } else { "b" },
                                wire::data(&json!({"n":wire::number(s.n)})),
                            )
                            .unwrap(),
                        );
                    }
                    result
                }),
            };
            (machine, loaded, messages, operation)
        }
        Script::Poller(s) => {
            let loaded = s.loaded.map(|s| poller(s, &readings));
            let messages = s
                .messages
                .into_iter()
                .map(|m| poller_msg(m, &readings))
                .collect();
            let operation = s
                .operation
                .map(|s| poller(s, &readings), |m| poller_msg(m, &readings));
            let fetch = Rc::new(Command {
                name: "fetch".into(),
                n: 0.0,
                payload: Rc::clone(&payload),
            });
            let poll: Rc<dyn Poller<Reading, Command, Fault>> =
                Rc::new(create_poller(PollerConfig::new(
                    5.0,
                    |_: &Model| panic!("consumer supplies untilHeld"),
                    move || Rc::clone(&fetch),
                )));
            let init = Rc::clone(&poll);
            let init_log = Rc::clone(&log);
            let init_cause = Arc::clone(&cause);
            let init_readings = readings.clone();
            let mut row: Row<'static, Model, Event, Rc<Command>> = Row::new();
            for kind in ["begin", "deadline", "read"] {
                let poll = Rc::clone(&poll);
                let log = Rc::clone(&log);
                let cause = Arc::clone(&cause);
                row.insert(
                    kind.into(),
                    Box::new(move |s, m| {
                        let Model::Poller(s) = s else {
                            panic!("poller state")
                        };
                        log.borrow_mut().push(json!(["cell", m.tag()]));
                        if matches!(fail, Some(Fail::Update)) {
                            std::panic::panic_any(Arc::clone(&cause));
                        }
                        let next = match m {
                            Event::Begin(at) => poll.start(&s.poll, *at),
                            Event::Deadline => poll.tick(&s.poll),
                            Event::Read(r, at) => poll
                                .tick_result(&s.poll, Rc::clone(r), *at, r.status == "ready")
                                .unwrap(),
                            _ => panic!("poller cell"),
                        };
                        Step::new(
                            Model::Poller(Rc::new(PollerModel { poll: next.state })),
                            next.commands,
                        )
                    }),
                );
            }
            let sub_log = Rc::clone(&log);
            let sub_cause = Arc::clone(&cause);
            let machine: AppMachine = Machine {
                init: Box::new(move |loaded, _| {
                    init_log.borrow_mut().push(json!([
                        "init",
                        loaded.as_ref().map(|s| model_view(s, &init_readings))
                    ]));
                    if matches!(fail, Some(Fail::Init)) {
                        std::panic::panic_any(Arc::clone(&init_cause));
                    }
                    Step::new(
                        loaded.unwrap_or_else(|| {
                            Model::Poller(Rc::new(PollerModel { poll: init.init() }))
                        }),
                        vec![],
                    )
                }),
                update: Update::RawReducer(row),
                subscriptions: subscriptions(move |s: &Model| {
                    sub_log.borrow_mut().push(json!(["subs"]));
                    if matches!(fail, Some(Fail::Subs)) {
                        std::panic::panic_any(Arc::clone(&sub_cause));
                    }
                    let Model::Poller(p) = s else {
                        panic!("poller subs")
                    };
                    let deps = poll.subs(&p.poll);
                    if deps.is_empty() {
                        vec![]
                    } else {
                        vec![Sub::new("deadline", plain_data(&deps).unwrap()).unwrap()]
                    }
                }),
            };
            (machine, loaded, messages, operation)
        }
    };
    World {
        machine,
        loaded,
        messages,
        operation,
        bound,
        fail,
        cause,
        matcher,
        log,
        payload,
        readings,
    }
}
fn gate(
    fail: Option<Fail>,
    matcher: &Rc<MatcherCause>,
    cause: &Arc<Cause>,
) -> Result<(), Rc<MatcherCause>> {
    match fail {
        Some(Fail::MatcherError) => Err(Rc::clone(matcher)),
        Some(Fail::MatcherPanic) => std::panic::panic_any(Arc::clone(cause)),
        _ => Ok(()),
    }
}
fn cause_data(phase: &str, code: u32) -> Value {
    json!({"phase":phase,"code":code})
}
fn refusal(e: NoCellError, log: &RefCell<Vec<Value>>) -> Value {
    json!({"status":"refusal","log":log.borrow().clone(),"error":wire::snapshot(&e)})
}
fn execute(case: Case) -> Value {
    let w = world(case.input);
    let calls = Calls::default();
    let comparisons = RefCell::new(vec![]);
    let bound = if w.bound {
        Some(observe!(calls, testing::bind_machine, &w.machine, &()))
    } else {
        None
    };
    let model_cmp = |a: &Model, b: &Model| {
        comparisons.borrow_mut().push(json!({"kind":"state","actual":model_view(a,&w.readings),"expected":model_view(b,&w.readings)}));
        gate(w.fail, &w.matcher, &w.cause)?;
        Ok(model_equal(a, b))
    };
    let cmd_cmp = |a: &Rc<Command>, b: &Rc<Command>| {
        comparisons
            .borrow_mut()
            .push(json!({"kind":"command","actual":command_view(a),"expected":command_view(b)}));
        gate(w.fail, &w.matcher, &w.cause)?;
        Ok(a.name == b.name && same_number(a.n, b.n) && Rc::ptr_eq(&a.payload, &b.payload))
    };
    let sub_cmp = |a: &Sub<PlainData>, b: &Sub<PlainData>| {
        comparisons
            .borrow_mut()
            .push(json!({"kind":"sub","actual":wire::snapshot(a),"expected":wire::snapshot(b)}));
        gate(w.fail, &w.matcher, &w.cause)?;
        Ok(a.id() == b.id()
            && a.kind() == b.kind()
            && wire::normalized(a.deps()) == wire::normalized(b.deps()))
    };
    let mut native_diag = Value::Null;
    let output = catch_unwind(AssertUnwindSafe(|| {
        let opts = ReplayOpts {
            loaded: w.loaded,
            msgs: w.messages,
        };
        let result: Result<(), CheckError<Rc<MatcherCause>>> = match w.operation {
            Operation::Step { state, msg } => {
                let result = match &bound {
                    Some(h) => observe!(calls, BoundMachine::step, h, &state, &msg),
                    None => observe!(calls, testing::step, &w.machine, &state, &msg, &()),
                };
                return match result {
                    Ok(s) => {
                        json!({"status":"ok","log":w.log.borrow().clone(),"result":{"state":model_view(&s.state,&w.readings),"commands":s.commands.iter().map(|c|command_view(c)).collect::<Vec<_>>(),"sameInput":same_model(&s.state,&state),"sameSlice":same_slice(&s.state,&state)}})
                    }
                    Err(e) => refusal(e, &w.log),
                };
            }
            Operation::Replay => {
                let h = bound.as_ref().expect("bound replay");
                let before = opts.loaded.as_ref().map(|s| match s {
                    Model::Counter(s) => Rc::as_ptr(s) as usize,
                    Model::Poller(s) => Rc::as_ptr(s) as usize,
                });
                let result: Result<Replay<_, _, _>, _> =
                    observe!(calls, BoundMachine::replay, h, opts);
                return match result {
                    Ok(s) => {
                        let ptr = match &s.state {
                            Model::Counter(s) => Rc::as_ptr(s) as usize,
                            Model::Poller(s) => Rc::as_ptr(s) as usize,
                        };
                        json!({"status":"ok","log":w.log.borrow().clone(),"result":{"state":model_view(&s.state,&w.readings),"commands":s.commands.iter().map(|c|command_view(c)).collect::<Vec<_>>(),"subs":s.subs.iter().map(wire::snapshot).collect::<Vec<_>>(),"sameLoaded":before==Some(ptr)}})
                    }
                    Err(e) => refusal(e, &w.log),
                };
            }
            Operation::Final { expected } => match &bound {
                Some(h) => observe!(
                    calls,
                    BoundMachine::expect_final_state,
                    h,
                    opts,
                    &expected,
                    model_cmp
                ),
                None => observe!(
                    calls,
                    testing::expect_final_state,
                    &w.machine,
                    &(),
                    opts,
                    &expected,
                    model_cmp
                ),
            },
            Operation::Contains { expected } => {
                let expected = cmd(expected, &w.payload);
                match &bound {
                    Some(h) => observe!(
                        calls,
                        BoundMachine::expect_cmd_emitted,
                        h,
                        opts,
                        &expected,
                        cmd_cmp
                    ),
                    None => observe!(
                        calls,
                        testing::expect_cmd_emitted,
                        &w.machine,
                        &(),
                        opts,
                        &expected,
                        cmd_cmp
                    ),
                }
            }
            Operation::Commands { expected } => {
                let expected = expected
                    .into_iter()
                    .map(|s| cmd(s, &w.payload))
                    .collect::<Vec<_>>();
                match &bound {
                    Some(h) => observe!(
                        calls,
                        BoundMachine::expect_cmd_sequence,
                        h,
                        opts,
                        &expected,
                        cmd_cmp
                    ),
                    None => observe!(
                        calls,
                        testing::expect_cmd_sequence,
                        &w.machine,
                        &(),
                        opts,
                        &expected,
                        cmd_cmp
                    ),
                }
            }
            Operation::Subs { expected } => {
                let expected = expected.into_iter().map(sub).collect::<Vec<_>>();
                match &bound {
                    Some(h) => observe!(
                        calls,
                        BoundMachine::expect_active_subs,
                        h,
                        opts,
                        &expected,
                        sub_cmp
                    ),
                    None => observe!(
                        calls,
                        testing::expect_active_subs,
                        &w.machine,
                        &(),
                        opts,
                        &expected,
                        sub_cmp
                    ),
                }
            }
        };
        match result {
            Ok(()) => json!({"status":"ok","log":w.log.borrow().clone()}),
            Err(CheckError::Replay(e)) => refusal(e, &w.log),
            Err(CheckError::Matcher(e)) => {
                native_diag = json!({"variant":"Matcher","sameCause":Rc::ptr_eq(&e,&w.matcher),"cause":cause_data(e.phase,e.code),"capabilityRetained":(e.capability)()});
                json!({"status":"callback","log":w.log.borrow().clone(),"sameCause":Rc::ptr_eq(&e,&w.matcher),"cause":cause_data(e.phase,e.code)})
            }
            Err(e) => {
                native_diag = match e {
                    CheckError::FinalStateMismatch => json!({"variant":"FinalStateMismatch"}),
                    CheckError::CmdNotEmitted => json!({"variant":"CmdNotEmitted"}),
                    CheckError::CmdSequenceLength { actual, expected } => {
                        json!({"variant":"CmdSequenceLength","actual":actual,"expected":expected})
                    }
                    CheckError::CmdSequenceItem { index } => {
                        json!({"variant":"CmdSequenceItem","index":index})
                    }
                    CheckError::ActiveSubsLength { actual, expected } => {
                        json!({"variant":"ActiveSubsLength","actual":actual,"expected":expected})
                    }
                    CheckError::ActiveSubsItem { index } => {
                        json!({"variant":"ActiveSubsItem","index":index})
                    }
                    _ => unreachable!(),
                };
                json!({"status":"mismatch","log":w.log.borrow().clone()})
            }
        }
    }));
    let comparison = match output {
        Ok(v) => v,
        Err(e) => {
            let actual = e.downcast_ref::<Arc<Cause>>().expect("actual panic cause");
            native_diag = json!({"variant":"Panic","sameCause":Arc::ptr_eq(actual,&w.cause),"cause":cause_data(actual.phase,actual.code),"capabilityRetained":(actual.capability)()});
            json!({"status":"callback","log":w.log.borrow().clone(),"sameCause":Arc::ptr_eq(actual,&w.cause),"cause":cause_data(actual.phase,actual.code)})
        }
    };
    json!({"id":case.id,"comparison":comparison,"observedRustCalls":calls.borrow().clone(),"nativeDiagnostics":native_diag,"nativeComparisons":comparisons.borrow().clone()})
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if !line.trim().is_empty() {
            println!("{}", execute(serde_json::from_str(&line).unwrap()));
        }
    }
}
