use demlik_tea::{
    Machine, Step, Sub, Tagged, TimerDeps, Update,
    command::{
        CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Failure,
        Outcome, Settled, Settlement,
    },
    paginate::paginated_walk::{Config, PageErr, PageOk, PaginatedWalk, State},
    resilience::{
        deadline::DeadlineExceeded,
        resilient_call::{CallFailure, CallValue, RunCommand, RunError, RunSpec},
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{
        CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, launch,
    },
};
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};

struct Cursor {
    token: &'static str,
    _local: Rc<()>,
}
struct Page {
    next: Option<Rc<Cursor>>,
    body: &'static str,
    _local: Rc<()>,
}
#[derive(Serialize)]
struct FetchFault {
    code: &'static str,
    counter: Rc<Cell<u32>>,
}
type Fetch = RunCommand<Cursor, Page, Rc<FetchFault>>;
type Spec = RunSpec<Cursor, Page, Rc<FetchFault>>;
enum Command {
    Fetch(Fetch),
    Process(Rc<Page>),
}
impl From<Fetch> for Command {
    fn from(command: Fetch) -> Self {
        Self::Fetch(command)
    }
}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(command) => command.tag(),
            Self::Process(_) => "process_page",
        }
    }
}
enum Msg {
    Start,
    Fetched(Settled<Spec>),
    Timer(DeadlineExceeded),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Start => "start",
            Self::Fetched(msg) => msg.tag(),
            Self::Timer(msg) => msg.tag(),
        }
    }
}
impl Serialize for Msg {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Timer(msg) => msg.serialize(serializer),
            _ => Err(serde::ser::Error::custom(
                "only this machine's timer messages cross the dependency wire",
            )),
        }
    }
}
enum Complete {
    Fetch(Completion<Spec>),
    Process,
}
impl CommandFamily for Command {
    type Msg = Msg;
    type Completion = Complete;
    fn is_defined(&self) -> bool {
        matches!(self, Self::Fetch(_))
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Fetched(msg) => msg.engine_stamp(),
            _ => None,
        }
    }
    fn settle(self, completion: Complete, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Fetch(command), Complete::Fetch(completion)) => command
                .settle(completion, at)
                .map(|messages| messages.into_iter().map(Msg::Fetched).collect()),
            (Self::Process(_), Complete::Process) => Ok(vec![]),
            (command, _) => Err(CommandContractError::mismatched(
                command.tag(),
                "wrong machine completion",
            )),
        }
    }
    fn settle_in(
        self,
        completion: Complete,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Fetch(command), Complete::Fetch(completion)) => command
                .settle_in(completion, edge)
                .map(|messages| messages.into_iter().map(Msg::Fetched).collect()),
            (Self::Process(_), Complete::Process) => Ok(vec![]),
            (command, _) => Err(CommandContractError::mismatched(
                command.tag(),
                "wrong machine completion",
            )),
        }
    }
}
type Walk = PaginatedWalk<'static, Cursor, Page, Rc<FetchFault>, &'static str, Command>;
struct Model {
    walk: State<Cursor, Page, Rc<FetchFault>>,
    failures: Vec<Rc<FetchFault>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
struct Backend {
    trace: Rc<RefCell<Vec<String>>>,
    attempts: Cell<u32>,
    fail_count: u32,
    second: Rc<Cursor>,
    fault: Rc<FetchFault>,
}
impl Interpreter<Command> for Backend {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Command,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Complete, Infallible>> {
        Some(CommandWork::new(async move {
            Ok(match command {
                Command::Fetch(command) => {
                    let CallValue::Shared(cursor) = &command.input().input else {
                        panic!("this backend receives defined cursors")
                    };
                    self.trace
                        .borrow_mut()
                        .push(format!("fetch:{}", cursor.token));
                    let attempt = self.attempts.get();
                    self.attempts.set(attempt + 1);
                    if attempt < self.fail_count {
                        Complete::Fetch(Some(Outcome::err(RunError::port_rejected(Rc::clone(
                            &self.fault,
                        )))))
                    } else {
                        Complete::Fetch(Some(Outcome::ok(CallValue::value(Page {
                            next: (cursor.token == "first").then(|| Rc::clone(&self.second)),
                            body: cursor.token,
                            _local: Rc::new(()),
                        }))))
                    }
                }
                Command::Process(page) => {
                    self.trace
                        .borrow_mut()
                        .push(format!("process:{}", page.body));
                    Complete::Process
                }
            })
        }))
    }
}
fn machine(walk: Rc<Walk>) -> Machine<'static, Model, Msg, Command, Sub<TimerDeps<Msg>>> {
    let initialize = walk.clone();
    let selectors = walk.clone();
    type Reducer = dyn Fn(&Model, &Msg) -> Step<Model, Command>;
    let reducer: Rc<Reducer> = Rc::new(move |state, msg| {
        let mut failures = state.failures.clone();
        let step = match msg {
            Msg::Start => walk.start(&state.walk, 0.0).unwrap(),
            Msg::Timer(msg) => walk.on_timer(&state.walk, msg).unwrap(),
            Msg::Fetched(msg) => {
                let key = msg.cmd().input().key.clone();
                let at = msg.at().expect("the engine owns this stamp");
                match msg.outcome() {
                    Settlement::Ok(page) => walk
                        .page_ok(&state.walk, PageOk::new(key, page.clone(), at))
                        .unwrap(),
                    Settlement::Err(error) => {
                        let error = match error {
                            Failure::Declared(error) => {
                                failures.push(Rc::clone(&error.details));
                                CallFailure::Run(Rc::new(RunError {
                                    kind: error.kind,
                                    details: Rc::clone(&error.details),
                                }))
                            }
                            Failure::Malformed(error) => CallFailure::Malformed(error.clone()),
                        };
                        walk.page_err(&state.walk, PageErr::new(key, error, at))
                            .unwrap()
                    }
                }
            }
        };
        Step::new(
            Model {
                walk: step.state,
                failures,
            },
            step.commands,
        )
    });
    let mut cells: demlik_tea::core::Row<'static, Model, Msg, Command> = Default::default();
    for kind in [
        "start",
        "resilient_run_ok",
        "resilient_run_err",
        "deadline_exceeded",
    ] {
        let reducer = reducer.clone();
        cells.insert(kind.into(), Box::new(move |state, msg| reducer(state, msg)));
    }
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(
                loaded.unwrap_or_else(|| Model {
                    walk: initialize.init(),
                    failures: vec![],
                }),
                vec![],
            )
        }),
        update: Update::RawReducer(cells),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
            selectors
                .timer(&state.walk)
                .map(|timer| {
                    Sub::new(
                        "timer",
                        TimerDeps {
                            ms: timer.ms,
                            msg: Msg::Timer(timer.msg),
                        },
                    )
                    .unwrap()
                })
                .into_iter()
                .collect()
        }),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn actual_runtime_fetches_and_processes_opaque_pages_in_order_and_surfaces_shared_failure_data()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for fail_count in [0, 1, 3] {
                    let first = Rc::new(Cursor {
                        token: "first",
                        _local: Rc::new(()),
                    });
                    let second = Rc::new(Cursor {
                        token: "second",
                        _local: Rc::new(()),
                    });
                    let fault = Rc::new(FetchFault {
                        code: "offline",
                        counter: Rc::new(Cell::new(7)),
                    });
                    let mut config = Config::new(
                        CallValue::shared(first),
                        Rc::new(|page: &CallValue<Page>| match page {
                            CallValue::Shared(page) => Ok(page.next.clone()),
                            _ => Err("page missing"),
                        }),
                        Rc::new(|page: &CallValue<Page>| match page {
                            CallValue::Shared(page) => Ok(vec![Command::Process(page.clone())]),
                            _ => Err("page missing"),
                        }),
                    );
                    config.retry = Some(RetryPolicy {
                        curve: BackoffCurve {
                            base_ms: 1.0,
                            factor: 1.0,
                            cap_ms: 1.0,
                            jitter: Jitter::None,
                        },
                        budget: CountBound { max_attempts: 3.0 },
                    });
                    let walk: Rc<Walk> = Rc::new(PaginatedWalk::new(config));
                    let trace = Rc::new(RefCell::new(vec![]));
                    let terminal = walk.clone();
                    let mut options: Options<Model, Msg, Infallible, Infallible> =
                        Options::new(profile);
                    options.terminal = Some(Rc::new(move |state: &Model| {
                        terminal.is_complete(&state.walk) || terminal.is_stuck(&state.walk)
                    }));
                    let runtime = launch(
                        machine(walk.clone()),
                        (),
                        Backend {
                            trace: trace.clone(),
                            attempts: Cell::new(0),
                            fail_count,
                            second,
                            fault: fault.clone(),
                        },
                        NoSubscriptions::new(),
                        options,
                    );
                    runtime.ready().await.unwrap();
                    runtime.dispatch(Msg::Start).await.unwrap();
                    let state = tokio::time::timeout(Duration::from_secs(2), runtime.done())
                        .await
                        .unwrap()
                        .unwrap();
                    if fail_count == 3 {
                        assert!(walk.is_stuck(&state.walk));
                        assert!(!walk.is_complete(&state.walk));
                        assert_eq!(
                            &*trace.borrow(),
                            &["fetch:first", "fetch:first", "fetch:first"]
                        );
                        assert!(
                            matches!(walk.failure(&state.walk).map(|error| error.as_ref()),
                            Some(CallFailure::Run(error)) if Rc::ptr_eq(&error.details, &fault))
                        );
                    } else {
                        assert!(walk.is_complete(&state.walk));
                        assert_eq!(state.walk.walk().pages(), 2.0);
                        let expected = if fail_count == 0 {
                            vec![
                                "fetch:first",
                                "process:first",
                                "fetch:second",
                                "process:second",
                            ]
                        } else {
                            vec![
                                "fetch:first",
                                "fetch:first",
                                "process:first",
                                "fetch:second",
                                "process:second",
                            ]
                        };
                        assert_eq!(&*trace.borrow(), &expected);
                    }
                    assert_eq!(state.failures.len(), fail_count as usize);
                    assert!(state.failures.iter().all(|error| Rc::ptr_eq(error, &fault)));
                    fault.counter.set(9);
                    assert!(state.failures.iter().all(|error| error.counter.get() == 9));
                    assert!(runtime.reports().is_empty());
                    runtime.stop().await;
                    println!("PAGINATED_WALK_RUNTIME:{}", serde_json::json!({
                        "profile": format!("{profile:?}"), "failures": fail_count,
                        "trace": &*trace.borrow(), "complete": walk.is_complete(&state.walk),
                        "stuck": walk.is_stuck(&state.walk), "sharedFailures": state.failures.len(),
                        "reports": runtime.reports().len(),
                    }));
                }
            }
        })
        .await;
}
