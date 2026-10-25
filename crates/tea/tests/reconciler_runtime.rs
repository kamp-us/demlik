use demlik_tea::{
    Machine, Step, Sub, Tagged, TimerDeps, Update,
    command::{
        CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Failure,
        Outcome, Settled, Settlement,
    },
    flow::reconciler::{Actuals, Config, Phase, Reconciler, State},
    paginate::paginated_walk::{PAGE_KEY, PageErr, PageOk},
    resilience::{
        deadline::DeadlineExceeded,
        resilient_call::{CallFailure, CallPhase, CallValue, RunCommand, RunError, RunSpec},
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
struct Actual {
    id: &'static str,
    version: u32,
    _local: Rc<()>,
}
struct Desired {
    version: u32,
}
struct Change {
    id: &'static str,
    _local: Rc<()>,
}
struct Page {
    next: Option<Rc<Cursor>>,
    rows: Vec<Rc<Actual>>,
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
    Apply(Rc<Change>),
}
impl From<Fetch> for Command {
    fn from(value: Fetch) -> Self {
        Self::Fetch(value)
    }
}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(value) => value.tag(),
            Self::Apply(_) => "apply_change",
        }
    }
}
enum Msg {
    Start(f64),
    Fetched(Settled<Spec>),
    Applied(Rc<Change>, f64),
    Timer(DeadlineExceeded),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Start(_) => "start",
            Self::Fetched(value) => value.tag(),
            Self::Applied(_, _) => "change_done",
            Self::Timer(value) => value.tag(),
        }
    }
}
impl Serialize for Msg {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Timer(value) => value.serialize(serializer),
            _ => Err(serde::ser::Error::custom(
                "opaque live message has no wire codec",
            )),
        }
    }
}
enum Complete {
    Fetch(Completion<Spec>),
    Apply(f64),
}
impl CommandFamily for Command {
    type Msg = Msg;
    type Completion = Complete;
    fn is_defined(&self) -> bool {
        matches!(self, Self::Fetch(_))
    }
    fn settle(self, value: Complete, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        match (self, value) {
            (Self::Fetch(command), Complete::Fetch(value)) => command
                .settle(value, at)
                .map(|values| values.into_iter().map(Msg::Fetched).collect()),
            (Self::Apply(change), Complete::Apply(at)) => Ok(vec![Msg::Applied(change, at)]),
            _ => Err(CommandContractError::mismatched(
                "reconciler completion",
                "different command variant",
            )),
        }
    }
    fn settle_in(
        self,
        value: Complete,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, value) {
            (Self::Fetch(command), Complete::Fetch(value)) => command
                .settle_in(value, edge)
                .map(|values| values.into_iter().map(Msg::Fetched).collect()),
            (Self::Apply(change), Complete::Apply(at)) => Ok(vec![Msg::Applied(change, at)]),
            _ => Err(CommandContractError::mismatched(
                "reconciler completion",
                "different command variant",
            )),
        }
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Fetched(value) => value.engine_stamp(),
            _ => None,
        }
    }
}
struct Backend {
    trace: Rc<RefCell<Vec<String>>>,
    attempts: Cell<u32>,
    fail_count: u32,
    second: Rc<Cursor>,
    fault: Rc<FetchFault>,
    clock: Rc<dyn Fn() -> f64>,
}
impl Interpreter<Command> for Backend {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Command,
        _context: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Complete, Infallible>> {
        Some(CommandWork::new(async move {
            let completion = match command {
                Command::Fetch(command) => {
                    let CallValue::Shared(cursor) = &command.input().input else {
                        panic!("typed cursor")
                    };
                    assert_eq!(command.input().key.as_utf8(), Some(PAGE_KEY));
                    self.trace
                        .borrow_mut()
                        .push(format!("fetch:{}", cursor.token));
                    let count = self.attempts.get() + 1;
                    self.attempts.set(count);
                    if count <= self.fail_count {
                        Complete::Fetch(Some(Outcome::err(RunError::port_rejected(
                            self.fault.clone(),
                        ))))
                    } else {
                        let first = cursor.token == "first";
                        Complete::Fetch(Some(Outcome::ok(CallValue::value(Page {
                            next: first.then(|| self.second.clone()),
                            rows: vec![Rc::new(Actual {
                                id: if first { "a" } else { "b" },
                                version: 1,
                                _local: Rc::new(()),
                            })],
                        }))))
                    }
                }
                Command::Apply(change) => {
                    self.trace.borrow_mut().push(format!("apply:{}", change.id));
                    Complete::Apply((self.clock)())
                }
            };
            Ok(completion)
        }))
    }
}
type Sync = Reconciler<
    'static,
    Actual,
    Desired,
    Page,
    Change,
    Cursor,
    Rc<FetchFault>,
    &'static str,
    Command,
>;
struct Model {
    rec: State<Actual, Change, Page, Cursor, Rc<FetchFault>>,
    failures: Vec<Rc<FetchFault>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
fn machine(sync: Rc<Sync>) -> Machine<'static, Model, Msg, Command, Sub<TimerDeps<Msg>>> {
    let init = sync.clone();
    let selector = sync.clone();
    type Reducer = dyn Fn(&Model, &Msg) -> Step<Model, Command>;
    let reducer: Rc<Reducer> = Rc::new(move |state, msg| {
        let mut failures = state.failures.clone();
        let result = match msg {
            Msg::Start(at) => sync.scan(&state.rec, *at),
            Msg::Fetched(settled) => {
                let at = settled.at().unwrap();
                let key = settled.cmd().input().key.clone();
                match settled.outcome() {
                    Settlement::Ok(page) => {
                        sync.page_ok(&state.rec, PageOk::new(key, page.clone(), at))
                    }
                    Settlement::Err(Failure::Declared(error)) => {
                        failures.push(error.details.clone());
                        sync.page_err(
                            &state.rec,
                            PageErr::new(
                                key,
                                CallFailure::Run(Rc::new(RunError {
                                    kind: error.kind,
                                    details: error.details.clone(),
                                })),
                                at,
                            ),
                        )
                    }
                    Settlement::Err(Failure::Malformed(error)) => sync.page_err(
                        &state.rec,
                        PageErr::new(key, CallFailure::Malformed(error.clone()), at),
                    ),
                }
            }
            Msg::Applied(change, at) => {
                sync.applied(&state.rec, CallValue::shared(change.clone()), *at)
            }
            Msg::Timer(msg) => sync.on_timer(&state.rec, msg),
        }
        .unwrap();
        Step::new(
            Model {
                rec: result.state,
                failures,
            },
            result.commands,
        )
    });
    let mut cells: demlik_tea::core::Row<'static, Model, Msg, Command> = Default::default();
    for tag in [
        "start",
        "resilient_run_ok",
        "resilient_run_err",
        "change_done",
        "deadline_exceeded",
    ] {
        let reducer = reducer.clone();
        cells.insert(tag.into(), Box::new(move |state, msg| reducer(state, msg)));
    }
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(
                loaded.unwrap_or_else(|| Model {
                    rec: init.init(),
                    failures: vec![],
                }),
                vec![],
            )
        }),
        update: Update::RawReducer(cells),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
            selector
                .timer(&state.rec)
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

async fn run_scenario(profile: Profile, fail_count: u32) {
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
    let mut config = Config::with_id(
        Rc::new(Desired { version: 2 }),
        CallValue::shared(first),
        Rc::new(|page: &CallValue<Page>| match page {
            CallValue::Shared(page) => Ok(page.next.clone()),
            _ => Err("missing page"),
        }),
        Rc::new(|page: &CallValue<Page>| match page {
            CallValue::Shared(page) => Ok(page.rows.clone()),
            _ => Err("missing page"),
        }),
        Rc::new(|desired: &Desired, actual: &Actuals<Actual>| {
            Ok(Rc::new(
                actual
                    .iter()
                    .filter(|row| row.version < desired.version)
                    .map(|row| {
                        CallValue::value(Change {
                            id: row.id,
                            _local: Rc::new(()),
                        })
                    })
                    .collect(),
            ))
        }),
        Rc::new(|change: &Rc<Change>| Ok(Command::Apply(change.clone()))),
        Rc::new(|change: &CallValue<Change>| match change {
            CallValue::Shared(change) => Ok(change.id.into()),
            _ => Err("missing change"),
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
    let sync: Rc<Sync> = Rc::new(Reconciler::new(config));
    let terminal = sync.clone();
    let mut options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
    options.terminal = Some(Rc::new(move |state: &Model| {
        terminal.is_complete(&state.rec) || state.rec.phase() == Phase::Failed
    }));
    let clock = options.clock.clone();
    let trace = Rc::new(RefCell::new(vec![]));
    let runtime = launch(
        machine(sync.clone()),
        (),
        Backend {
            trace: trace.clone(),
            attempts: Cell::new(0),
            fail_count,
            second,
            fault: fault.clone(),
            clock: clock.clone(),
        },
        NoSubscriptions::new(),
        options,
    );
    runtime.ready().await.unwrap();
    runtime.dispatch(Msg::Start(clock())).await.unwrap();
    let state = tokio::time::timeout(Duration::from_secs(2), runtime.done())
        .await
        .unwrap()
        .unwrap();
    let expected = if fail_count == 3 {
        vec!["fetch:first", "fetch:first", "fetch:first"]
    } else {
        let mut expected = vec![];
        if fail_count == 1 {
            expected.push("fetch:first");
        }
        expected.extend(["fetch:first", "fetch:second", "apply:a", "apply:b"]);
        expected
    };
    assert_eq!(&*trace.borrow(), &expected);
    if fail_count == 3 {
        assert_eq!(state.rec.phase(), Phase::Failed);
        assert!(!sync.is_complete(&state.rec));
        assert!(matches!(state.rec.walk().resilience().call(PAGE_KEY),
            Some(CallPhase::Failed {error}) if matches!(error.as_ref(),
                CallFailure::Run(error) if Rc::ptr_eq(&error.details, &fault))));
    } else {
        assert!(sync.is_complete(&state.rec));
        assert_eq!(state.rec.actual().len(), 2);
        assert_eq!(state.rec.applied_cursor().number(), Some(2.0));
        assert_eq!(state.rec.applied().entries.own_entries().count(), 2);
    }
    assert_eq!(state.failures.len(), fail_count as usize);
    assert!(state.failures.iter().all(|value| Rc::ptr_eq(value, &fault)));
    fault.counter.set(9);
    assert!(state.failures.iter().all(|value| value.counter.get() == 9));
    assert!(runtime.reports().is_empty());
    runtime.stop().await;
    println!(
        "RECONCILER_RUNTIME:{}",
        serde_json::json!({
            "profile": format!("{profile:?}"), "failures": fail_count, "trace": &*trace.borrow(),
            "complete": sync.is_complete(&state.rec), "failed": state.rec.phase() == Phase::Failed,
            "sharedFailures": state.failures.len(), "reports": runtime.reports().len(),
        })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn actual_runtime_scans_then_applies_opaque_changes_serially_and_retains_failure_identity() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for failures in [0, 1, 3] {
                    run_scenario(profile, failures).await;
                }
            }
        })
        .await;
}
