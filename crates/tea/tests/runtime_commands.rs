use std::cell::{Cell, RefCell};
use std::rc::Rc;

use demlik_tea::command::{
    Cmd, CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandSpec, Completion,
    EngineStamp, Outcome, SchemaError, Settled,
};
use demlik_tea::core::Message;
use demlik_tea::runtime::{
    CommandContext, CommandWork, ErrorPhase, Interpreter, NoSubscriptions, Options, Profile,
    RuntimeError, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

type Log = Rc<RefCell<Vec<String>>>;
#[derive(Clone, Copy, Serialize, Deserialize)]
enum Mode {
    Success,
    Expected,
    Malformed,
    Undeclared,
    Defect,
    Panic,
    Forged,
    Empty,
    Plain,
}
#[derive(Serialize, Deserialize)]
struct Input {
    mode: Mode,
}
#[derive(Serialize, Deserialize)]
struct Output {
    value: u32,
}
#[derive(Serialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
enum ExpectedError {
    Temporary { after_ms: u32 },
    Unknown { reason: &'static str },
}
impl Tagged for ExpectedError {
    fn tag(&self) -> &str {
        match self {
            Self::Temporary { .. } => "temporary",
            Self::Unknown { .. } => "unknown",
        }
    }
}
struct Request;
impl CommandSpec for Request {
    type Input = Input;
    type RawOutput = Value;
    type Output = Output;
    type Error = ExpectedError;
    const NAME: &'static str = "request";
    const ERROR_TAGS: &'static [&'static str] = &["temporary"];
    fn parse_input(value: Value) -> Result<Input, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
    fn parse_output(value: Value) -> Result<Output, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
}
enum Msg {
    Start(Mode),
    Settled(Settled<Request>),
    Progress,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Start(_) => "start",
            Self::Settled(msg) => msg.tag(),
            Self::Progress => "progress",
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["start", "request_ok", "request_err", "progress"];
}
enum Cmds {
    Defined(Cmd<Request>),
    After,
    Plain,
}
impl Tagged for Cmds {
    fn tag(&self) -> &str {
        match self {
            Self::Defined(cmd) => cmd.tag(),
            Self::After => "after",
            Self::Plain => "plain",
        }
    }
}
enum Completed {
    Defined(Completion<Request>),
    Plain(Vec<Msg>),
}
impl CommandFamily for Cmds {
    type Msg = Msg;
    type Completion = Completed;
    fn is_defined(&self) -> bool {
        matches!(self, Self::Defined(_))
    }
    fn engine_stamp(message: &Msg) -> Option<&EngineStamp> {
        match message {
            Msg::Settled(msg) => msg.engine_stamp(),
            _ => None,
        }
    }
    fn settle(self, completion: Completed, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Defined(cmd), Completed::Defined(completion)) => Ok(cmd
                .settle(completion, at)?
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
        completion: Completed,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Defined(cmd), Completed::Defined(completion)) => Ok(cmd
                .settle_in(completion, edge)?
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
struct State {
    outcomes: Vec<Value>,
    progress: u32,
    terminal: bool,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
fn machine() -> Machine<'static, State, Msg, Cmds, Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(
                loaded.unwrap_or(State {
                    outcomes: vec![],
                    progress: 0,
                    terminal: false,
                }),
                vec![],
            )
        }),
        update: Update::reducer(|state: &State, msg: &Msg| {
            let mut next = State {
                outcomes: state.outcomes.clone(),
                progress: state.progress,
                terminal: state.terminal,
            };
            let commands = match msg {
                Msg::Start(mode) => {
                    next.terminal = true;
                    vec![
                        if matches!(mode, Mode::Plain) {
                            Cmds::Plain
                        } else {
                            Cmds::Defined(
                                CmdDef::<Request>::new()
                                    .build(Input { mode: *mode })
                                    .unwrap(),
                            )
                        },
                        Cmds::After,
                    ]
                }
                Msg::Settled(msg) => {
                    next.outcomes.push(serde_json::to_value(msg).unwrap());
                    vec![]
                }
                Msg::Progress => {
                    next.progress += 1;
                    vec![]
                }
            };
            Step::new(next, commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
struct Handlers(Log);
impl Interpreter<Cmds> for Handlers {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmds,
        ctx: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Completed, Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.borrow_mut().push(cmd.tag().into());
            let Cmds::Defined(cmd) = cmd else {
                return match cmd {
                    Cmds::Plain => Err("plain failure"),
                    _ => Ok(Completed::Plain(vec![])),
                };
            };
            let completion = match cmd.input().mode {
                Mode::Success => Some(Outcome::ok(json!({"value":42,"extra":"stripped"}))),
                Mode::Expected => Some(Outcome::err(ExpectedError::Temporary { after_ms: 10 })),
                Mode::Malformed => Some(Outcome::ok(json!({"value":"wrong"}))),
                Mode::Undeclared => Some(Outcome::err(ExpectedError::Unknown {
                    reason: "undeclared detail",
                })),
                Mode::Defect => return Err("defined handler defect"),
                Mode::Panic => panic!("defined panic payload"),
                Mode::Forged => {
                    let replay = || {
                        CmdDef::<Request>::new().ok(
                            CmdDef::<Request>::new()
                                .build(Input { mode: Mode::Forged })
                                .unwrap(),
                            Output { value: 999 },
                            Some(17.0),
                        )
                    };
                    assert!(ctx.dispatch(Msg::Settled(replay())).is_err());
                    let producer = ctx.producer();
                    std::thread::spawn(move || producer.emit(Msg::Settled(replay())))
                        .join()
                        .unwrap()
                        .unwrap_err();
                    ctx.dispatch(Msg::Progress).unwrap();
                    None
                }
                Mode::Empty => None,
                Mode::Plain => unreachable!(),
            };
            Ok(Completed::Defined(completion))
        }))
    }
}
fn options(
    profile: Profile,
    log: Log,
    clock: Rc<Cell<u32>>,
) -> Options<State, Msg, std::convert::Infallible, &'static str> {
    let mut options = Options::new(profile);
    options.clock = Rc::new(move || {
        clock.set(clock.get() + 1);
        17.0
    });
    options.terminal = Some(Rc::new(|state: &State| state.terminal));
    options.on_commit.push(Rc::new(move |msg: Option<&Msg>, _| {
        if let Some(msg) = msg {
            log.borrow_mut().push(format!("commit:{}", msg.tag()));
        }
    }));
    options
}
#[tokio::test(flavor = "current_thread")]
async fn declared_success_error_and_malformed_output_are_engine_stamped_messages_without_defect_reports()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for mode in [Mode::Success, Mode::Expected, Mode::Malformed] {
                    let log = Rc::new(RefCell::new(vec![]));
                    let clock = Rc::new(Cell::new(0));
                    let runtime = launch(
                        machine(),
                        (),
                        Handlers(Rc::clone(&log)),
                        NoSubscriptions::new(),
                        options(profile, Rc::clone(&log), Rc::clone(&clock)),
                    );
                    runtime.ready().await.unwrap();
                    runtime.dispatch(Msg::Start(mode)).await.unwrap();
                    let state = runtime.get_state().unwrap();
                    assert_eq!(state.outcomes.len(), 1);
                    assert_eq!(clock.get(), 1);
                    let outcome = &state.outcomes[0];
                    assert_eq!(outcome["at"], 17.0);
                    assert_eq!(outcome["cmd"]["type"], "request");
                    match mode {
                        Mode::Success => {
                            assert_eq!(outcome["type"], "request_ok");
                            assert_eq!(outcome["value"], json!({"value":42}));
                        }
                        Mode::Expected => {
                            assert_eq!(outcome["type"], "request_err");
                            assert_eq!(outcome["error"], json!({"_tag":"temporary","after_ms":10}));
                        }
                        Mode::Malformed => {
                            assert_eq!(outcome["type"], "request_err");
                            assert_eq!(outcome["error"]["_tag"], "malformed_result");
                            assert!(!outcome["error"]["issues"].as_array().unwrap().is_empty());
                        }
                        _ => unreachable!(),
                    }
                    assert!(runtime.reports().is_empty());
                    assert_eq!(&log.borrow()[..3], &["request", "after", "commit:start"]);
                    assert_eq!(
                        log.borrow()[3],
                        format!("commit:{}", outcome["type"].as_str().unwrap())
                    );
                    runtime.stop().await;
                }
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn defined_defects_and_forgery_report_interpret_failures_and_still_run_the_next_command() {
    tokio::task::LocalSet::new().run_until(async {
        for profile in [Profile::Promise,Profile::Effect]{for mode in [Mode::Undeclared,Mode::Defect,Mode::Panic,Mode::Forged,Mode::Empty]{
            let log=Rc::new(RefCell::new(vec![]));let clock=Rc::new(Cell::new(0));
            let runtime=launch(machine(),(),Handlers(Rc::clone(&log)),NoSubscriptions::new(),options(profile,Rc::clone(&log),Rc::clone(&clock)));
            runtime.ready().await.unwrap();runtime.dispatch(Msg::Start(mode)).await.unwrap();
            assert!(runtime.get_state().unwrap().outcomes.is_empty());
            assert_eq!(&log.borrow()[..3],&["request","after","commit:start"]);
            let reports=runtime.reports();
            assert!(reports.iter().all(|report|report.phase==ErrorPhase::Interpret));
            match mode {
                Mode::Undeclared=>assert!(matches!(&*reports[0].error,RuntimeError::Contract(error) if matches!(error.as_ref(),CommandContractError::UndeclaredFailure{failure,..} if failure["reason"]=="undeclared detail"))),
                Mode::Defect=>assert!(matches!(&*reports[0].error,RuntimeError::Handler("defined handler defect"))),
                Mode::Panic=>assert!(matches!(&*reports[0].error,RuntimeError::Panic(cause) if cause.summary=="defined panic payload")),
                Mode::Forged=>{assert_eq!(reports.len(),2);assert!(reports.iter().all(|report|matches!(&*report.error,RuntimeError::Contract(error) if error.name()=="OutcomeContractError")));assert_eq!(runtime.get_state().unwrap().progress,1);},
                Mode::Empty=>assert!(reports.is_empty()),
                _=>unreachable!(),
            }
            runtime.stop().await;
        }}
    }).await;
}
#[tokio::test(flavor = "current_thread")]
async fn a_plain_handler_failure_rejects_its_dispatch_after_saved_state_reaches_commit_and_terminal_waiters()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(vec![]));
                let clock = Rc::new(Cell::new(0));
                let runtime = launch(
                    machine(),
                    (),
                    Handlers(Rc::clone(&log)),
                    NoSubscriptions::new(),
                    options(profile, Rc::clone(&log), clock),
                );
                runtime.ready().await.unwrap();
                let done = {
                    let rt = runtime.clone();
                    tokio::task::spawn_local(async move { rt.done().await })
                };
                tokio::task::yield_now().await;
                assert!(matches!(
                    &*runtime.dispatch(Msg::Start(Mode::Plain)).await.unwrap_err(),
                    RuntimeError::Handler("plain failure")
                ));
                assert!(runtime.result().is_some());
                assert!(done.await.unwrap().unwrap().terminal);
                assert_eq!(&*log.borrow(), &["plain", "commit:start"]);
                assert!(runtime.reports().is_empty());
                runtime.dispatch(Msg::Progress).await.unwrap();
                assert_eq!(runtime.get_state().unwrap().progress, 1);
                runtime.stop().await;
            }
        })
        .await;
}
