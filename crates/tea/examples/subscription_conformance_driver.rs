use demlik_tea::{
    Machine, Step, Sub, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    core::{ProjectionError, SubEntry},
    runtime::{
        self, CommandContext, CommandWork, EffectScope, Interpreter, NoEvent, Options, Producer,
        Profile, RuntimeError, SubscriptionWork, Subscriptions, Supervision,
    },
    storage::{self, MemoryStore, MemoryStoreError, Migrated, RestoreCause, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    io::{self, BufRead},
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe { ($calls:expr,$f:path $(,$a:expr)* $(,)?) => {{let r=$f($($a),*);$calls.borrow_mut().push(stringify!($f));r}}; }
macro_rules! observe_async { ($calls:expr,$f:path $(,$a:expr)* $(,)?) => {{let r=$f($($a),*).await;$calls.borrow_mut().push(stringify!($f));r}}; }
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Policy {
    Stop,
    Escalate,
    Restart,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Origin {
    Caller,
    Producer,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Verb {
    Dispatch,
    Once,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    Fresh,
    Storeless,
    Stored,
    Recover,
    TwoFailures,
    BootProjection,
    StoredProjection,
    LoadFailure,
    MigrateRefusal,
    MigrateThrow,
    BootSaveFailure,
    StepSaveFailure,
    MixedRunner,
    MixedCleanup,
    MixedAll,
    HeldLoad,
    HeldLoadDispatch,
    HeldSave,
    HeldSaveProjection,
    HeldCleanup,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    profile: SelectedProfile,
    scenario: Scenario,
    policy: Policy,
    origin: Origin,
    verb: Verb,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Input,
}
type Trace = Rc<RefCell<Vec<String>>>;
type CapturedProducer = (Producer<Msg>, Rc<Cell<bool>>);
// Deliberately opaque: no Debug/Clone/serde/Send implementation.
struct Cause {
    kind: &'static str,
    original: Rc<Cell<u8>>,
}
struct Model {
    n: i64,
    original: Rc<Cell<u8>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
struct Msg(i64);
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "set"
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["set"];
}
struct Cmd(i64);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "effect"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, c: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(c)
    }
}
#[derive(Clone, Debug)]
struct HostError {
    kind: &'static str,
    original: Rc<Cell<u8>>,
}
#[derive(Debug)]
enum StoreError {
    Fault(HostError),
    Memory(MemoryStoreError),
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fault(e) => write!(f, "{} broke", e.kind),
            Self::Memory(e) => e.fmt(f),
        }
    }
}
type Failure = Rc<Cause>;
type Error = RuntimeError<StoreError, HostError, Failure>;
#[derive(Default)]
struct Gate {
    released: Cell<bool>,
    changed: Notify,
}
impl Gate {
    async fn wait(&self) {
        loop {
            let changed = self.changed.notified();
            if self.released.get() {
                return;
            }
            changed.await;
        }
    }
    fn release(&self) {
        self.released.set(true);
        self.changed.notify_waiters();
    }
}
struct Shared {
    trace: Trace,
    saved: RefCell<Vec<i64>>,
    active: RefCell<Vec<String>>,
    effects: Cell<u32>,
    commits: Cell<u32>,
    boot_callbacks: Cell<u32>,
    reductions: Cell<u32>,
    restarts: Cell<u32>,
    load_entered: Cell<bool>,
    save_entered: Cell<bool>,
    cleanup_entered: Cell<bool>,
    load_gate: Gate,
    save_gate: Gate,
    cleanup_gate: Gate,
    producer: RefCell<Option<CapturedProducer>>,
    reports: RefCell<Vec<Value>>,
    errors: RefCell<Vec<usize>>,
    raw: RefCell<Vec<Value>>,
    original: Rc<Cell<u8>>,
    first: Failure,
    second: Failure,
    scenario: Scenario,
}
impl Shared {
    fn log(&self, s: impl Into<String>) {
        self.trace.borrow_mut().push(s.into());
    }
    fn detail(&self, error: &Error) -> Value {
        let (kind, same) = match error {
            RuntimeError::Projection { failures } => match &failures[0].cause {
                ProjectionError::Declared(c) => (
                    c.kind,
                    Some(
                        (Rc::ptr_eq(c, &self.first) || Rc::ptr_eq(c, &self.second))
                            && Rc::ptr_eq(&c.original, &self.original)
                            && c.original.get() == 73,
                    ),
                ),
                _ => panic!("unexpected projection boundary"),
            },
            RuntimeError::Handler(c) => (c.kind, Some(Rc::ptr_eq(&c.original, &self.original))),
            RuntimeError::Restore(_) => ("restore", None),
            RuntimeError::Save(_) => ("save", None),
            RuntimeError::Stopped { .. } => ("stopped", None),
            RuntimeError::Discarded { .. } => ("discarded", None),
            RuntimeError::DrainTimeout { .. } => ("drain-timeout", None),
            RuntimeError::DisposeTimeout { .. } => ("dispose-timeout", None),
            _ => panic!("unexpected runtime category {}", error.name()),
        };
        self.raw.borrow_mut().push(json!({"kind":kind,"name":error.name(),"projectionFailures":match error {RuntimeError::Projection{failures}=>Some(failures.iter().map(|f|match &f.cause {ProjectionError::Declared(c)=>json!({"kind":f.kind,"cause":c.kind}),_=>Value::Null}).collect::<Vec<_>>()),_=>None}}));
        let mut d = json!({"kind":kind,"sameOriginal":same});
        if let RuntimeError::Restore(e) = error {
            d["reason"] = json!(e.reason);
            d["loadCause"] = json!(
                matches!(&e.cause,Some(RestoreCause::Load(StoreError::Fault(c)))if c.kind=="load"&&Rc::ptr_eq(&c.original,&self.original))
            );
        }
        d
    }
}
struct Saved {
    state: MemoryStore<Arc<Model>>,
    shared: Rc<Shared>,
    ordinal: Cell<usize>,
}
impl Store<Arc<Model>> for Saved {
    type Raw = Option<Arc<Model>>;
    type Error = StoreError;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.shared.log("load");
        self.shared.load_entered.set(true);
        if matches!(
            self.shared.scenario,
            Scenario::HeldLoad | Scenario::HeldLoadDispatch
        ) {
            self.shared.load_gate.wait().await;
        }
        if self.shared.scenario == Scenario::LoadFailure {
            return Err(StoreError::Fault(HostError {
                kind: "load",
                original: Rc::clone(&self.shared.original),
            }));
        }
        self.state.load().await.map_err(StoreError::Memory)
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Arc<Model>> {
        self.shared.log("migrate");
        match self.shared.scenario {
            Scenario::MigrateRefusal => Migrated::Refused(storage::refuse("fixture refused")),
            Scenario::MigrateThrow => panic!("migration broke"),
            _ => self.state.migrate(raw),
        }
    }
    async fn save(&self, state: &Arc<Model>) -> Result<(), Self::Error> {
        let ordinal = self.ordinal.get() + 1;
        self.ordinal.set(ordinal);
        self.shared.log(format!("save:{}:begin", state.n));
        if matches!(
            self.shared.scenario,
            Scenario::HeldSave | Scenario::HeldSaveProjection
        ) && ordinal == 2
        {
            self.shared.save_entered.set(true);
            self.shared.save_gate.wait().await;
        }
        if (self.shared.scenario == Scenario::BootSaveFailure && ordinal == 1)
            || (self.shared.scenario == Scenario::StepSaveFailure && ordinal == 2)
        {
            return Err(StoreError::Fault(HostError {
                kind: "save",
                original: Rc::clone(&self.shared.original),
            }));
        }
        self.state.save(state).await.map_err(StoreError::Memory)?;
        self.shared.saved.borrow_mut().push(state.n);
        self.shared.log(format!("save:{}:end", state.n));
        Ok(())
    }
}
struct Host(Rc<Shared>);
impl Interpreter<Cmd> for Host {
    type Error = HostError;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, HostError>,
    ) -> Option<CommandWork<'a, Vec<Msg>, HostError>> {
        Some(CommandWork::new(async move {
            self.0.effects.set(self.0.effects.get() + 1);
            self.0.log(format!("effect:{}", cmd.0));
            Ok(vec![])
        }))
    }
}
#[derive(Serialize)]
struct Deps {
    n: i64,
}
struct Runners(Rc<Shared>);
impl Subscriptions<Sub<Deps>, Msg> for Runners {
    type Error = HostError;
    fn start(
        &self,
        sub: Sub<Deps>,
        producer: Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<HostError>>, HostError> {
        let kind = sub.kind();
        let n = sub.deps().n;
        let key = format!("{kind}:{n}");
        self.0.log(format!("start:{key}"));
        if kind == "steady"
            && n == 1
            && matches!(self.0.scenario, Scenario::MixedRunner | Scenario::MixedAll)
        {
            return Err(HostError {
                kind: "runner",
                original: Rc::clone(&self.0.original),
            });
        }
        let open = Rc::new(Cell::new(true));
        if kind == "signal" {
            *self.0.producer.borrow_mut() = Some((producer, Rc::clone(&open)));
        }
        self.0.active.borrow_mut().push(key.clone());
        let shared = Rc::clone(&self.0);
        Ok(Some(SubscriptionWork::new(move || async move {
            open.set(false);
            shared.log(format!("cleanup:{key}:begin"));
            shared.active.borrow_mut().retain(|s| s != &key);
            if key == "obsolete:0" && shared.scenario == Scenario::HeldCleanup {
                shared.cleanup_entered.set(true);
                shared.cleanup_gate.wait().await;
            }
            shared.log(format!("cleanup:{key}:end"));
            if key == "obsolete:0"
                && matches!(shared.scenario, Scenario::MixedCleanup | Scenario::MixedAll)
            {
                return Err(HostError {
                    kind: "cleanup",
                    original: Rc::clone(&shared.original),
                });
            }
            Ok(())
        })))
    }
}
type Live = runtime::Runtime<Arc<Model>, Msg, StoreError, HostError, NoEvent, Failure>;
async fn turn() {
    tokio::task::yield_now().await;
}
async fn wait_for(mut check: impl FnMut() -> bool) {
    for _ in 0..10_000 {
        if check() {
            return;
        }
        turn().await;
    }
    panic!("fixture gate did not enter")
}
fn snapshot(label: &str, live: &Live, loaded: &Arc<Model>, shared: &Shared) -> Value {
    let state = live.get_state();
    let mut active = shared.active.borrow().clone();
    active.sort();
    json!({"label":label,"n":state.as_ref().map(|s|s.n),"loadedSame":state.as_ref().is_some_and(|s|Arc::ptr_eq(s.as_ref(),loaded)),"original":state.as_ref().is_some_and(|s|Rc::ptr_eq(&s.original,&shared.original)),"active":active,"saved":*shared.saved.borrow(),"effects":shared.effects.get(),"commits":shared.commits.get(),"bootCallbacks":shared.boot_callbacks.get()})
}
fn outcome(
    label: &str,
    result: Result<(), runtime::Failure<StoreError, HostError, Failure>>,
    cached: &mut Option<runtime::Failure<StoreError, HostError, Failure>>,
    shared: &Shared,
) -> Value {
    match result {
        Ok(()) => {
            shared.log(format!("receipt:{label}:ok"));
            json!({"label":label,"ok":true})
        }
        Err(error) => {
            let mut detail = shared.detail(&error);
            let kind = detail["kind"].as_str().unwrap();
            shared.log(format!("receipt:{label}:{kind}"));
            detail["label"] = json!(label);
            detail["ok"] = json!(false);
            detail["sameCached"] = cached
                .as_ref()
                .map(|c| Rc::ptr_eq(c, &error))
                .map_or(Value::Null, Value::Bool);
            detail["sameReport"] = json!(
                shared
                    .errors
                    .borrow()
                    .iter()
                    .any(|e| *e == std::ptr::from_ref(error.as_ref()).addr())
            );
            if label == "ready" {
                *cached = Some(error);
            }
            detail
        }
    }
}
async fn dispatch(
    live: &Live,
    n: i64,
    verb: Verb,
    calls: &Calls,
) -> Result<(), runtime::Failure<StoreError, HostError, Failure>> {
    match verb {
        Verb::Dispatch => {
            observe_async!(calls, demlik_tea::runtime::Runtime::dispatch, live, Msg(n))
        }
        Verb::Once => observe_async!(
            calls,
            demlik_tea::runtime::Runtime::dispatch_once,
            live,
            Msg(n)
        ),
    }
}
#[expect(
    clippy::arc_with_non_send_sync,
    reason = "The local actor and memory store retain the same model handle without requiring opaque Rc payloads to be Send or Clone."
)]
async fn execute(input: Input, calls: &Calls) -> Value {
    let scenario = input.scenario;
    let original = Rc::new(Cell::new(73));
    let first = Rc::new(Cause {
        kind: "projection:first",
        original: Rc::clone(&original),
    });
    let second = Rc::new(Cause {
        kind: "projection:second",
        original: Rc::clone(&original),
    });
    let shared = Rc::new(Shared {
        trace: Rc::new(RefCell::new(vec![])),
        saved: RefCell::new(vec![]),
        active: RefCell::new(vec![]),
        effects: Cell::new(0),
        commits: Cell::new(0),
        boot_callbacks: Cell::new(0),
        reductions: Cell::new(0),
        restarts: Cell::new(0),
        load_entered: Cell::new(false),
        save_entered: Cell::new(false),
        cleanup_entered: Cell::new(false),
        load_gate: Gate::default(),
        save_gate: Gate::default(),
        cleanup_gate: Gate::default(),
        producer: RefCell::new(None),
        reports: RefCell::new(vec![]),
        errors: RefCell::new(vec![]),
        raw: RefCell::new(vec![]),
        original,
        first,
        second,
        scenario,
    });
    let initial_n = if matches!(
        scenario,
        Scenario::BootProjection | Scenario::StoredProjection
    ) {
        1
    } else if matches!(
        scenario,
        Scenario::Stored | Scenario::HeldLoad | Scenario::HeldLoadDispatch
    ) {
        4
    } else {
        0
    };
    let loaded = Arc::new(Model {
        n: initial_n,
        original: Rc::clone(&shared.original),
    });
    let stored = matches!(
        scenario,
        Scenario::Stored
            | Scenario::StoredProjection
            | Scenario::HeldLoad
            | Scenario::HeldLoadDispatch
    )
    .then(|| Arc::clone(&loaded));
    let init = Rc::clone(&shared);
    let update = Rc::clone(&shared);
    let entries = ["fragile", "second", "steady", "obsolete", "signal"]
        .into_iter()
        .map(|kind| {
            let s = Rc::clone(&shared);
            SubEntry::try_new(kind, move |state: &Arc<Model>| {
                let n = state.n;
                s.log(format!("project:{kind}:{n}"));
                let fail = matches!(
                    scenario,
                    Scenario::Recover
                        | Scenario::TwoFailures
                        | Scenario::MixedRunner
                        | Scenario::MixedCleanup
                        | Scenario::MixedAll
                        | Scenario::HeldSaveProjection
                        | Scenario::BootProjection
                        | Scenario::StoredProjection
                );
                if kind == "fragile" && n == 1 && fail {
                    return Err(Rc::clone(&s.first));
                }
                if kind == "second" && n == 1 && scenario == Scenario::TwoFailures {
                    return Err(Rc::clone(&s.second));
                }
                if (kind == "obsolete" && n != 0) || (kind == "fragile" && n == 3) {
                    return Ok(None);
                }
                Ok(Some(Deps {
                    n: if kind == "signal" { 0 } else { n },
                }))
            })
        })
        .collect();
    let machine: Machine<'static, Arc<Model>, Msg, Cmd, Sub<Deps>, (), Failure> = Machine {
        init: Box::new(move |loaded, _| {
            let fresh = loaded.is_none();
            let state = loaded.unwrap_or_else(|| {
                Arc::new(Model {
                    n: initial_n,
                    original: Rc::clone(&init.original),
                })
            });
            init.log(format!(
                "init:{}:{}",
                state.n,
                if fresh { "fresh" } else { "loaded" }
            ));
            let n = state.n;
            Step::new(state, vec![Cmd(n)])
        }),
        update: TryUpdate::try_reducer(move |s: &Arc<Model>, m: &Msg| {
            update.reductions.set(update.reductions.get() + 1);
            update.log(format!("reduce:{}->{}", s.n, m.0));
            Ok(Step::new(
                Arc::new(Model {
                    n: m.0,
                    original: Rc::clone(&s.original),
                }),
                vec![Cmd(m.0)],
            ))
        }),
        subscriptions: Box::new(observe!(
            calls,
            demlik_tea::core::SubscriptionEntries::new,
            entries
        )),
    };
    let profile = match input.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options: Options<Arc<Model>, Msg, StoreError, HostError, NoEvent, Failure> =
        Options::new(profile);
    if scenario != Scenario::Storeless {
        options.store = Some(observe!(
            calls,
            demlik_tea::runtime::Persistence::new,
            Saved {
                state: storage::memory_store(stored),
                shared: Rc::clone(&shared),
                ordinal: Cell::new(0)
            }
        ));
    }
    options.dispose_timeout = if matches!(
        scenario,
        Scenario::HeldLoad
            | Scenario::HeldLoadDispatch
            | Scenario::HeldSave
            | Scenario::HeldSaveProjection
            | Scenario::HeldCleanup
    ) {
        Duration::ZERO
    } else {
        Duration::from_secs(1)
    };
    let report = Rc::clone(&shared);
    options.on_error = Some(Rc::new(move |error, phase| {
        report
            .errors
            .borrow_mut()
            .push(std::ptr::from_ref(error).addr());
        let d = report.detail(error);
        let p = serde_json::to_value(phase).unwrap();
        report.log(format!(
            "report:{}:{}",
            p.as_str().unwrap(),
            d["kind"].as_str().unwrap()
        ));
        let mut row = d;
        row["phase"] = p;
        row["saved"] = json!(*report.saved.borrow());
        row["effects"] = json!(report.effects.get());
        report.reports.borrow_mut().push(row);
    }));
    options.supervision = match input.policy {
        Policy::Stop => Supervision::Stop,
        Policy::Escalate => Supervision::Escalate,
        Policy::Restart => {
            let shared = Rc::clone(&shared);
            Supervision::Restart(Rc::new(move |s, _, _| {
                shared.restarts.set(shared.restarts.get() + 1);
                shared.log("rehydrate");
                Arc::clone(s)
            }))
        }
    };
    let live = match input.profile {
        SelectedProfile::Promise => observe!(
            calls,
            demlik_tea::runtime::try_launch,
            machine,
            (),
            Host(Rc::clone(&shared)),
            Runners(Rc::clone(&shared)),
            options
        ),
        SelectedProfile::Effect => observe_async!(
            calls,
            demlik_tea::runtime::try_run,
            machine,
            (),
            Host(Rc::clone(&shared)),
            Runners(Rc::clone(&shared)),
            options
        ),
    };
    let scope = EffectScope::new();
    if profile == Profile::Effect {
        scope.attach(&live).await.unwrap();
    }
    let boot_log = Rc::clone(&shared);
    let unboot = observe!(
        calls,
        demlik_tea::runtime::Runtime::on_boot,
        &live,
        move |s| {
            boot_log
                .boot_callbacks
                .set(boot_log.boot_callbacks.get() + 1);
            boot_log.log(format!("boot:{}", s.n));
        }
    );
    let log = Rc::clone(&shared);
    let off = observe!(
        calls,
        demlik_tea::runtime::Runtime::observe,
        &live,
        move |m, s| {
            log.commits.set(log.commits.get() + 1);
            log.log(format!("observe:{}:{}", m.0, s.n));
        }
    );
    let mut receipts = vec![];
    let mut snapshots = vec![];
    let mut cached = None;
    if matches!(scenario, Scenario::HeldLoad | Scenario::HeldLoadDispatch) {
        wait_for(|| shared.load_entered.get()).await;
        snapshots.push(snapshot("load-held", &live, &loaded, &shared));
        let pending = if scenario == Scenario::HeldLoadDispatch {
            let l = live.clone();
            let verb = input.verb;
            let calls = Rc::clone(calls);
            Some(tokio::task::spawn_local(async move {
                dispatch(&l, 9, verb, &calls).await
            }))
        } else {
            None
        };
        turn().await;
        observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
        shared.log("stopped-held");
        snapshots.push(snapshot("after-stop", &live, &loaded, &shared));
        shared.load_gate.release();
        receipts.push(outcome(
            "ready",
            observe_async!(calls, demlik_tea::runtime::Runtime::ready, &live).map(|_| ()),
            &mut cached,
            &shared,
        ));
        if let Some(p) = pending {
            receipts.push(outcome("queued", p.await.unwrap(), &mut cached, &shared));
        }
        snapshots.push(snapshot("late-boot", &live, &loaded, &shared));
        receipts.push(outcome(
            "after-stop",
            dispatch(&live, 9, input.verb, calls).await,
            &mut cached,
            &shared,
        ));
    } else {
        receipts.push(outcome(
            "ready",
            observe_async!(calls, demlik_tea::runtime::Runtime::ready, &live).map(|_| ()),
            &mut cached,
            &shared,
        ));
        snapshots.push(snapshot("boot", &live, &loaded, &shared));
        if cached.is_some() {
            receipts.push(outcome(
                "ready-again",
                observe_async!(calls, demlik_tea::runtime::Runtime::ready, &live).map(|_| ()),
                &mut cached,
                &shared,
            ));
            receipts.push(outcome(
                "cached-dispatch",
                dispatch(&live, 2, input.verb, calls).await,
                &mut cached,
                &shared,
            ));
            let captured_producer = shared.producer.borrow().clone();
            if let Some((p, open)) = captured_producer {
                if profile == Profile::Promise || open.get() {
                    let _ = p.emit(Msg(2));
                }
                let _ = live.idle().await;
                turn().await;
            }
        } else if matches!(scenario, Scenario::HeldSave | Scenario::HeldSaveProjection) {
            let l = live.clone();
            let verb = input.verb;
            let cc = Rc::clone(calls);
            let pending = tokio::task::spawn_local(async move { dispatch(&l, 1, verb, &cc).await });
            wait_for(|| shared.save_entered.get()).await;
            snapshots.push(snapshot("save-held", &live, &loaded, &shared));
            observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
            shared.log("stopped-held");
            snapshots.push(snapshot("after-stop", &live, &loaded, &shared));
            shared.save_gate.release();
            receipts.push(outcome(
                "held",
                pending.await.unwrap(),
                &mut cached,
                &shared,
            ));
            snapshots.push(snapshot("late-save", &live, &loaded, &shared));
        } else {
            let actions = if matches!(
                scenario,
                Scenario::Recover
                    | Scenario::TwoFailures
                    | Scenario::MixedRunner
                    | Scenario::MixedCleanup
                    | Scenario::MixedAll
                    | Scenario::StepSaveFailure
                    | Scenario::HeldCleanup
            ) {
                vec![1, 2, 3]
            } else {
                vec![2]
            };
            for n in actions {
                if matches!(input.origin, Origin::Producer) {
                    let (producer, open) = shared.producer.borrow().as_ref().unwrap().clone();
                    if profile == Profile::Promise || open.get() {
                        let _ = observe!(
                            calls,
                            demlik_tea::runtime::Producer::emit,
                            &producer,
                            Msg(n)
                        );
                    }
                    let _ = observe_async!(calls, demlik_tea::runtime::Runtime::idle, &live);
                    turn().await;
                    shared.log(format!("receipt:producer:{n}"));
                    receipts.push(json!({"label":format!("producer:{n}"),"ok":true}));
                } else {
                    receipts.push(outcome(
                        &format!("set:{n}"),
                        dispatch(&live, n, input.verb, calls).await,
                        &mut cached,
                        &shared,
                    ));
                }
                turn().await;
                snapshots.push(snapshot(&format!("set:{n}"), &live, &loaded, &shared));
            }
        }
    }
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
    shared.log("stopped");
    if scenario == Scenario::HeldCleanup {
        shared.cleanup_gate.release();
        wait_for(|| {
            shared
                .trace
                .borrow()
                .iter()
                .any(|s| s == "cleanup:obsolete:0:end")
        })
        .await;
    }
    turn().await;
    snapshots.push(snapshot("final", &live, &loaded, &shared));
    let final_saved = shared.saved.borrow().clone();
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
    off();
    unboot();
    scope.close().await;
    json!({"comparison":{"trace":*shared.trace.borrow(),"receipts":receipts,"reports":*shared.reports.borrow(),"snapshots":snapshots,"saved":*shared.saved.borrow(),"effects":shared.effects.get(),"commits":shared.commits.get(),"bootCallbacks":shared.boot_callbacks.get(),"reduceCount":shared.reductions.get(),"restarts":shared.restarts.get(),"stopIdempotent":*shared.saved.borrow()==final_saved},"errorProfile":*shared.raw.borrow()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new().run_until(async{for line in io::stdin().lock().lines(){let line=line.expect("stdin");let answer=match serde_json::from_str::<Request>(&line){Err(_)=>json!({"id":Value::Null,"ok":false,"error":{"kind":"protocol"}}),Ok(request)=>{let calls=Rc::new(RefCell::new(vec![]));let output=execute(request.input,&calls).await;json!({"id":request.id,"ok":true,"output":output,"observedCalls":*calls.borrow()})}};println!("{answer}");}}).await;
}
