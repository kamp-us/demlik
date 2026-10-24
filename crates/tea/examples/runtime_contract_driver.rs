use demlik_tea::command::{
    Cmd, CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandSpec, Completion,
    EngineStamp, Issue, Outcome, SchemaError, Settled,
};
use demlik_tea::core::Message;
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, RuntimeError,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};

type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.borrow_mut().push(stringify!($function));
        result
    }};
}
macro_rules! observe_async {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*).await;
        $calls.borrow_mut().push(stringify!($function));
        result
    }};
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Case {
    Success,
    Declared,
    Malformed,
    Undefined,
    Undeclared,
    Defect,
    Forged,
    PlainFailure,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    profile: SelectedProfile,
    steps: Vec<Case>,
    issue: String,
    at: f64,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchInput {
    mode: Case,
}
struct RawOutput {
    value: Option<Value>,
    issue: String,
}
#[derive(Serialize)]
struct Body {
    body: String,
}
#[derive(Serialize)]
#[serde(transparent)]
struct RawFailure(Value);
impl Tagged for RawFailure {
    fn tag(&self) -> &str {
        self.0["_tag"].as_str().unwrap_or("")
    }
}
struct Fetch;
impl CommandSpec for Fetch {
    type Input = FetchInput;
    type RawOutput = RawOutput;
    type Output = Body;
    type Error = RawFailure;
    const NAME: &'static str = "fetch";
    const ERROR_TAGS: &'static [&'static str] = &["timeout"];
    fn parse_input(value: Value) -> Result<FetchInput, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
    fn parse_output(raw: RawOutput) -> Result<Body, SchemaError> {
        raw.value
            .as_ref()
            .and_then(|value| value.get("body"))
            .and_then(Value::as_str)
            .map(|body| Body { body: body.into() })
            .ok_or_else(|| SchemaError::Issues(vec![Issue::new("body", raw.issue)]))
    }
}
enum Msg {
    Start(Case),
    Settled(Settled<Fetch>),
    Progress { note: &'static str },
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Start(_) => "Start",
            Self::Settled(msg) => msg.tag(),
            Self::Progress { .. } => "Progress",
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["Start", "fetch_ok", "fetch_err", "Progress"];
}
fn message_data(msg: &Msg) -> Value {
    match msg {
        Msg::Start(mode) => json!({"type":"Start","mode":mode}),
        Msg::Settled(msg) => serde_json::to_value(msg).unwrap(),
        Msg::Progress { note } => json!({"type":"Progress","note":note}),
    }
}
enum Command {
    Fetch(Cmd<Fetch>),
    After,
    Plain,
}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(cmd) => cmd.tag(),
            Self::After => "After",
            Self::Plain => "Plain",
        }
    }
}
fn command_data(cmd: &Command) -> Value {
    match cmd {
        Command::Fetch(cmd) => serde_json::to_value(cmd).unwrap(),
        other => json!({"type":other.tag()}),
    }
}
enum Completed {
    Fetch(Completion<Fetch>),
    Plain(Vec<Msg>),
}
impl CommandFamily for Command {
    type Msg = Msg;
    type Completion = Completed;
    fn is_defined(&self) -> bool {
        matches!(self, Self::Fetch(_))
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Settled(msg) => msg.engine_stamp(),
            _ => None,
        }
    }
    fn settle(self, completed: Completed, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completed) {
            (Self::Fetch(cmd), Completed::Fetch(outcome)) => Ok(cmd
                .settle(outcome, at)?
                .into_iter()
                .map(Msg::Settled)
                .collect()),
            (Self::After | Self::Plain, Completed::Plain(messages)) => Ok(messages),
            (cmd, _) => Err(CommandContractError::mismatched(
                cmd.tag(),
                "wrong completion",
            )),
        }
    }
    fn settle_in(
        self,
        completed: Completed,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completed) {
            (Self::Fetch(cmd), Completed::Fetch(outcome)) => Ok(cmd
                .settle_in(outcome, edge)?
                .into_iter()
                .map(Msg::Settled)
                .collect()),
            (Self::After | Self::Plain, Completed::Plain(messages)) => Ok(messages),
            (cmd, _) => Err(CommandContractError::mismatched(
                cmd.tag(),
                "wrong completion",
            )),
        }
    }
}
#[derive(Clone, Serialize)]
struct Model {
    started: u32,
    progress: u32,
    settled: Vec<Value>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
fn machine(calls: Calls) -> Machine<'static, Model, Msg, Command, Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(
                loaded.unwrap_or(Model {
                    started: 0,
                    progress: 0,
                    settled: vec![],
                }),
                vec![],
            )
        }),
        update: Update::reducer(move |state: &Model, msg: &Msg| {
            let mut next = state.clone();
            let commands = match msg {
                Msg::Start(mode) => {
                    next.started += 1;
                    vec![
                        if matches!(mode, Case::PlainFailure) {
                            Command::Plain
                        } else {
                            let definition =
                                observe!(calls, demlik_tea::command::CmdDef::<Fetch>::new);
                            Command::Fetch(
                                observe!(
                                    calls,
                                    demlik_tea::command::CmdDef::<Fetch>::build,
                                    &definition,
                                    FetchInput { mode: *mode }
                                )
                                .unwrap(),
                            )
                        },
                        Command::After,
                    ]
                }
                Msg::Settled(msg) => {
                    next.settled.push(serde_json::to_value(msg).unwrap());
                    vec![]
                }
                Msg::Progress { .. } => {
                    next.progress += 1;
                    vec![]
                }
            };
            Step::new(next, commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
type Trace = Rc<RefCell<Vec<Value>>>;
#[derive(Clone)]
struct Saved {
    state: Rc<RefCell<Option<Model>>>,
    trace: Trace,
}
impl Store<Model> for Saved {
    type Raw = Option<Model>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.state.borrow().clone())
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        self.trace
            .borrow_mut()
            .push(json!({"kind":"save","state":state}));
        *self.state.borrow_mut() = Some(state.clone());
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
}
#[derive(Debug, Serialize)]
struct HostError {
    name: &'static str,
    message: &'static str,
}
impl HostError {
    fn new(message: &'static str) -> Self {
        Self {
            name: "Error",
            message,
        }
    }
}
struct Handlers {
    calls: Calls,
    profile: SelectedProfile,
    issue: String,
    at: f64,
    trace: Trace,
}
impl Interpreter<Command> for Handlers {
    type Error = HostError;
    fn interpret<'a>(
        &'a self,
        command: &'a Command,
        ctx: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Completed, Self::Error>> {
        Some(CommandWork::new(async move {
            self.trace
                .borrow_mut()
                .push(json!({"kind":"handler","command":command_data(command)}));
            let Command::Fetch(cmd) = command else {
                return match command {
                    Command::Plain => Err(HostError::new("plain handler failure")),
                    _ => Ok(Completed::Plain(vec![Msg::Progress { note: "after" }])),
                };
            };
            let raw = |value| RawOutput {
                value,
                issue: self.issue.clone(),
            };
            let returned = match cmd.input().mode {
                Case::Success => Some(Outcome::ok(raw(Some(
                    json!({"body":"kept","extra":"stripped"}),
                )))),
                Case::Declared => Some(Outcome::err(RawFailure(
                    json!({"_tag":"timeout","afterMs":12,"details":{"attempt":2}}),
                ))),
                Case::Malformed => Some(Outcome::ok(raw(Some(json!({"body":12}))))),
                Case::Undefined => match self.profile {
                    SelectedProfile::Promise => None,
                    SelectedProfile::Effect => Some(Outcome::ok(raw(None))),
                },
                Case::Undeclared => Some(Outcome::err(RawFailure(
                    json!({"_tag":"unknown","reason":"undeclared detail"}),
                ))),
                Case::Defect => return Err(HostError::new("defined handler defect")),
                Case::Forged => {
                    let forged = CmdDef::<Fetch>::new().ok(
                        CmdDef::<Fetch>::new().build(*cmd.input()).unwrap(),
                        Body {
                            body: "forged".into(),
                        },
                        Some(self.at),
                    );
                    match self.profile {
                        SelectedProfile::Promise => {
                            let _ = observe!(
                                self.calls,
                                demlik_tea::runtime::CommandContext::dispatch,
                                &ctx,
                                Msg::Settled(forged)
                            );
                            None
                        }
                        SelectedProfile::Effect => Some(Outcome::ok(raw(Some(
                            serde_json::to_value(forged).unwrap(),
                        )))),
                    }
                }
                Case::PlainFailure => unreachable!(),
            };
            Ok(Completed::Fetch(returned))
        }))
    }
}
fn failure(error: &RuntimeError<&'static str, HostError>) -> Value {
    match error {
        RuntimeError::Handler(cause) => json!({"category":"handler","cause":cause}),
        RuntimeError::Contract(cause) => json!({"category":"contract","cause":cause.as_ref()}),
        other => json!({"category":"unexpected","name":other.name(),"debug":format!("{other:?}")}),
    }
}
async fn execute(script: Script) -> Value {
    let calls: Calls = Rc::new(RefCell::new(vec![]));
    let trace = Rc::new(RefCell::new(vec![]));
    let reports = Rc::new(RefCell::new(vec![]));
    let state = Rc::new(RefCell::new(None));
    let store = Saved {
        state: Rc::clone(&state),
        trace: Rc::clone(&trace),
    };
    let profile = match script.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options = Options::new(profile);
    options.store = Some(observe!(
        calls,
        demlik_tea::runtime::Persistence::new,
        store
    ));
    let at = script.at;
    let clock_calls = Rc::new(std::cell::Cell::new(0));
    let counted = Rc::clone(&clock_calls);
    options.clock = Rc::new(move || {
        counted.set(counted.get() + 1);
        at
    });
    let reported = Rc::clone(&reports);
    options.on_error = Some(Rc::new(move |error, phase| {
        reported
            .borrow_mut()
            .push(json!({"phase":phase,"error":failure(error)}))
    }));
    let committed = Rc::clone(&trace);
    options
        .on_commit
        .push(Rc::new(move |msg: Option<&Msg>, state: &Model| {
            committed
                .borrow_mut()
                .push(json!({"kind":"commit","msg":msg.map(message_data),"state":state}))
        }));
    let runtime = observe!(
        calls,
        demlik_tea::runtime::launch,
        machine(Rc::clone(&calls)),
        (),
        Handlers {
            calls: Rc::clone(&calls),
            profile: script.profile,
            issue: script.issue,
            at,
            trace: Rc::clone(&trace),
        },
        NoSubscriptions::new(),
        options,
    );
    observe_async!(calls, demlik_tea::runtime::Runtime::ready, &runtime).unwrap();
    let mut dispatches = vec![];
    for case in script.steps {
        let error = observe_async!(
            calls,
            demlik_tea::runtime::Runtime::dispatch,
            &runtime,
            Msg::Start(case)
        )
        .err()
        .map(|error| failure(&error));
        dispatches.push(json!({"case":case,"error":error}));
        observe_async!(
            calls,
            demlik_tea::runtime::Runtime::dispatch,
            &runtime,
            Msg::Progress { note: "check" }
        )
        .unwrap();
    }
    let final_state = serde_json::to_value(
        observe!(calls, demlik_tea::runtime::Runtime::get_state, &runtime)
            .unwrap()
            .as_ref(),
    )
    .unwrap();
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &runtime);
    json!({"comparison":{"state":final_state,"saved":state.borrow().as_ref(),"trace":&*trace.borrow(),"reports":&*reports.borrow(),"dispatches":dispatches,"clockCalls":clock_calls.get()},"observedRustCalls":&*calls.borrow()})
}
fn main() {
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.is_empty() {
            continue;
        }
        let script: Script =
            serde_json::from_str(&line).expect("validated runtime contract script");
        let output = host.block_on(tokio::task::LocalSet::new().run_until(execute(script)));
        println!("{}", serde_json::to_string(&output).unwrap());
    }
}
