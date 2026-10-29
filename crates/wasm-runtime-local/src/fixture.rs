#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The host deliberately retains opaque local state without Send or Clone bounds."
)]
use crate::node_timer::{NodeTimer, sleep};
use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, DriveOptions, Interpreter, Options, Persistence, Profile, Runtime,
    RuntimeError, RuntimeTimer, SubscriptionWork, Subscriptions, drive_to_done,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{EitherSub, Machine, Step, Sub, Tagged, TimerDeps, Update};
use futures::channel::oneshot;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::Rc,
    time::Duration,
};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

type Log = Rc<RefCell<Vec<Value>>>;
struct Model {
    count: i32,
    timer: Option<u32>,
    owner: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "state"
    }
}
fn model(count: i32) -> Model {
    Model {
        count,
        timer: None,
        owner: Rc::new(()),
    }
}
fn view(state: &Model) -> Value {
    json!({"type":"state","count":state.count,"timer":state.timer})
}
fn wire(state: &Model) -> String {
    serde_json::to_string(&view(state)).expect("fixture state is JSON")
}
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Msg {
    Add { by: i32 },
    Work,
    Background,
    Arm { ms: Option<u32> },
    Tick,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add { .. } => "add",
            Self::Work => "work",
            Self::Background => "background",
            Self::Arm { .. } => "arm",
            Self::Tick => "tick",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["add", "work", "background", "arm", "tick"];
}
enum Cmd {
    Work,
    Background,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Work => "work",
            Self::Background => "background",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, completion: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(completion)
    }
}
type Subs = EitherSub<Sub<TimerDeps<Msg>>, Sub>;
fn machine(feed: bool) -> Machine<'static, Model, Msg, Cmd, Subs, ()> {
    Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_else(|| model(0)), vec![])),
        update: Update::reducer(|state: &Model, msg: &Msg| {
            let mut next = Model {
                count: state.count,
                timer: state.timer,
                owner: Rc::clone(&state.owner),
            };
            let commands = match msg {
                Msg::Add { by } => {
                    next.count += by;
                    vec![]
                }
                Msg::Work => {
                    next.count += 10;
                    vec![Cmd::Work]
                }
                Msg::Background => vec![Cmd::Background],
                Msg::Arm { ms } => {
                    next.timer = *ms;
                    vec![]
                }
                Msg::Tick => {
                    next.count += 1;
                    next.timer = None;
                    vec![]
                }
            };
            Step::new(next, commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
            let mut subscriptions = vec![];
            if let Some(ms) = state.timer {
                subscriptions.push(EitherSub::Left(
                    Sub::timer(f64::from(ms), Msg::Tick).expect("valid timer"),
                ));
            }
            if feed {
                subscriptions.push(EitherSub::Right(
                    Sub::new("feed", json!({"on":true})).expect("valid feed"),
                ));
            }
            subscriptions
        }),
    }
}
struct Gate {
    sender: RefCell<Option<oneshot::Sender<()>>>,
    receiver: RefCell<Option<oneshot::Receiver<()>>>,
}
impl Gate {
    fn new() -> Self {
        let (tx, rx) = oneshot::channel();
        Self {
            sender: RefCell::new(Some(tx)),
            receiver: RefCell::new(Some(rx)),
        }
    }
    async fn wait(&self) {
        let receiver = self
            .receiver
            .borrow_mut()
            .take()
            .expect("single operation gate");
        let _ = receiver.await;
    }
    fn release(&self) {
        if let Some(sender) = self.sender.borrow_mut().take() {
            let _ = sender.send(());
        }
    }
}
#[derive(Debug)]
struct StoreFault {
    code: u32,
    _owner: Rc<()>,
}
impl fmt::Display for StoreFault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "store fault {}", self.code)
    }
}
struct Shared {
    trace: Log,
    reports: Rc<RefCell<Vec<Value>>>,
    stored: RefCell<String>,
    work: Gate,
    background: Gate,
    cleanup: Gate,
    fail_load: bool,
    fail_save: Cell<bool>,
    fault: Rc<StoreFault>,
    timer: Rc<NodeTimer>,
}
impl Shared {
    fn log(&self, row: Value) {
        self.trace.borrow_mut().push(row);
    }
}
#[derive(Clone)]
struct Saved(Rc<Shared>);
async fn turn() {
    let _ = JsFuture::from(js_sys::Promise::resolve(&JsValue::UNDEFINED)).await;
}
impl Store<Model> for Saved {
    type Raw = String;
    type Error = Rc<StoreFault>;
    async fn load(&self) -> Result<String, Self::Error> {
        self.0.log(json!(["load"]));
        turn().await;
        if self.0.fail_load {
            Err(Rc::clone(&self.0.fault))
        } else {
            Ok(self.0.stored.borrow().clone())
        }
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        let wire = wire(state);
        self.0.log(json!(["save", wire]));
        turn().await;
        if self.0.fail_save.replace(false) {
            Err(Rc::clone(&self.0.fault))
        } else {
            *self.0.stored.borrow_mut() = wire;
            Ok(())
        }
    }
    fn migrate(&self, raw: String) -> Migrated<Model> {
        self.0.log(json!(["migrate"]));
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Stored {
            r#type: String,
            count: i32,
            timer: Option<u32>,
        }
        let checked: Stored = serde_json::from_str(&raw).expect("valid fixture store JSON");
        assert_eq!(checked.r#type, "state");
        Migrated::State(Model {
            count: checked.count,
            timer: checked.timer,
            owner: Rc::new(()),
        })
    }
}
struct Commands(Rc<Shared>);
impl Interpreter<Cmd> for Commands {
    type Error = String;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        context: CommandContext<Msg, String>,
    ) -> Option<CommandWork<'a, Vec<Msg>, String>> {
        let shared = Rc::clone(&self.0);
        Some(match command {
            Cmd::Work => CommandWork::promise(move |_| async move {
                shared.log(json!(["work:start"]));
                shared.work.wait().await;
                shared.log(json!(["work:end"]));
                Ok(vec![Msg::Add { by: 3 }])
            }),
            Cmd::Background => CommandWork::promise(move |_| async move {
                shared.log(json!(["background:start"]));
                let producer = context.producer();
                context.wait_until(async move {
                    shared.background.wait().await;
                    shared.log(json!(["background:end"]));
                    let _ = producer.emit(Msg::Add { by: 4 });
                    Ok(())
                });
                Ok(vec![])
            }),
        })
    }
}
struct Sources(Rc<Shared>);
impl Subscriptions<Subs, Msg> for Sources {
    type Error = String;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "feed"
    }
    fn start(
        &self,
        _: Subs,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<String>>, String> {
        self.0.log(json!(["feed:start"]));
        let shared = Rc::clone(&self.0);
        Ok(Some(SubscriptionWork::new(move || async move {
            shared.log(json!(["feed:cleanup:start"]));
            shared.cleanup.wait().await;
            shared.log(json!(["feed:cleanup:end"]));
            Ok(())
        })))
    }
}
type Actor = Runtime<Model, Msg, Rc<StoreFault>, String>;
struct Host {
    runtime: Actor,
    shared: Rc<Shared>,
    off_listener: Box<dyn Fn()>,
    off_observer: Box<dyn Fn()>,
    off_boot: Box<dyn Fn()>,
}
fn start(seed: i32, feed: bool, load_fails: bool, profile: Profile) -> Host {
    let shared = Rc::new(Shared {
        trace: Rc::new(RefCell::new(vec![])),
        reports: Rc::new(RefCell::new(vec![])),
        stored: RefCell::new(wire(&model(seed))),
        work: Gate::new(),
        background: Gate::new(),
        cleanup: Gate::new(),
        fail_load: load_fails,
        fail_save: Cell::new(false),
        fault: Rc::new(StoreFault {
            code: 41,
            _owner: Rc::new(()),
        }),
        timer: Rc::new(NodeTimer::default()),
    });
    let mut options = Options::new(profile);
    options.clock = Rc::new(|| 123.0);
    options.dispose_timeout = Duration::from_millis(15);
    options.timer = Some(RuntimeTimer::new(Rc::clone(&shared.timer)));
    options.store = Some(Persistence::new(Saved(Rc::clone(&shared))));
    let reports = Rc::clone(&shared.reports);
    options.on_error = Some(Rc::new(move |error, phase| {
        reports
            .borrow_mut()
            .push(json!({"name":error.name(),"phase":phase}))
    }));
    let runtime = demlik_tea::runtime::try_launch(
        machine(feed),
        (),
        Commands(Rc::clone(&shared)),
        Sources(Rc::clone(&shared)),
        options,
    );
    let seen = Rc::clone(&shared);
    let off_listener = runtime.subscribe(move || seen.log(json!(["listener"])));
    let seen = Rc::clone(&shared);
    let off_observer =
        runtime.observe(move |msg, state| seen.log(json!(["observe", msg.tag(), state.count])));
    let seen = Rc::clone(&shared);
    let off_boot = runtime.on_boot(move |state| seen.log(json!(["boot", state.count])));
    Host {
        runtime,
        shared,
        off_listener: Box::new(off_listener),
        off_observer: Box::new(off_observer),
        off_boot: Box::new(off_boot),
    }
}
fn error(error: impl fmt::Debug) -> JsValue {
    JsValue::from_str(&format!("{error:?}"))
}
async fn until(check: impl Fn() -> bool) -> Result<(), JsValue> {
    for _ in 0..1000 {
        if check() {
            return Ok(());
        }
        sleep(1).await?;
    }
    Err(JsValue::from_str("fixture condition did not settle"))
}
fn saw(host: &Host, kind: &str) -> bool {
    host.shared.trace.borrow().iter().any(|row| row[0] == kind)
}
fn output(host: &Host) -> Value {
    json!({"trace":&*host.shared.trace.borrow(),"reports":&*host.shared.reports.borrow(),"model":view(&host.runtime.get_state().expect("ready actor state")),"stored":&*host.shared.stored.borrow()})
}
async fn basic(seed: i32) -> Result<(Value, Value), JsValue> {
    let h = start(seed, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    h.shared.log(json!(["ready"]));
    h.runtime
        .dispatch(Msg::Add { by: 1 })
        .await
        .map_err(error)?;
    h.shared.log(json!(["receipt:add"]));
    let pending = h.runtime.dispatch_once(Msg::Work);
    until(|| saw(&h, "work:start")).await?;
    h.shared.log(json!([
        "work:pending",
        h.runtime.get_state().unwrap().count
    ]));
    h.shared.work.release();
    pending.await.map_err(error)?;
    h.shared.log(json!(["receipt:work"]));
    h.runtime.idle().await.map_err(error)?;
    h.runtime
        .dispatch_once(Msg::Background)
        .await
        .map_err(error)?;
    h.shared.log(json!(["receipt:background"]));
    h.shared.background.release();
    h.runtime.idle().await.map_err(error)?;
    h.runtime
        .dispatch(Msg::Arm { ms: Some(10000) })
        .await
        .map_err(error)?;
    h.runtime
        .dispatch(Msg::Arm { ms: None })
        .await
        .map_err(error)?;
    h.runtime
        .dispatch(Msg::Arm { ms: Some(4) })
        .await
        .map_err(error)?;
    until(|| h.runtime.get_state().unwrap().timer.is_none()).await?;
    h.runtime.idle().await.map_err(error)?;
    (h.off_listener)();
    (h.off_listener)();
    (h.off_observer)();
    (h.off_boot)();
    h.runtime
        .dispatch(Msg::Add { by: 2 })
        .await
        .map_err(error)?;
    h.runtime.stop().await;
    h.shared.log(json!(["stopped"]));
    Ok((output(&h), h.shared.timer.stats()))
}
async fn drain() -> Result<(Value, Value), JsValue> {
    let h = start(2, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    let pending = h.runtime.dispatch_once(Msg::Work);
    until(|| saw(&h, "work:start")).await?;
    let queued = h.runtime.dispatch_once(Msg::Add { by: 100 });
    let began = js_sys::Date::now();
    h.runtime.stop().await;
    let elapsed = js_sys::Date::now() - began;
    let at_stop = h.shared.stored.borrow().clone();
    h.shared.log(json!(["stopped"]));
    h.shared.work.release();
    pending.await.map_err(error)?;
    let queued = queued.await.expect_err("queued work discarded").name();
    sleep(2).await?;
    assert_eq!(
        *h.shared.stored.borrow(),
        at_stop,
        "late completion saved after stop"
    );
    let mut result = output(&h);
    result["queued"] = json!(queued);
    result["timeout_observed"] = json!(elapsed >= 10.0);
    Ok((result, h.shared.timer.stats()))
}
async fn dispose() -> Result<(Value, Value), JsValue> {
    let h = start(3, true, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    let began = js_sys::Date::now();
    h.runtime.stop().await;
    let elapsed = js_sys::Date::now() - began;
    h.shared.log(json!(["stopped"]));
    h.shared.cleanup.release();
    until(|| saw(&h, "feed:cleanup:end")).await?;
    let mut result = output(&h);
    result["timeout_observed"] = json!(elapsed >= 10.0);
    Ok((result, h.shared.timer.stats()))
}
async fn save_failure() -> Result<Value, JsValue> {
    let h = start(5, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    h.shared.fail_save.set(true);
    let failure = h
        .runtime
        .dispatch_once(Msg::Add { by: 2 })
        .await
        .expect_err("injected save failure");
    let original =
        matches!(&*failure,RuntimeError::Save(cause) if Rc::ptr_eq(cause,&h.shared.fault));
    h.shared.log(json!(["save:error", original]));
    h.runtime.stop().await;
    Ok(output(&h))
}
async fn load_failure() -> Result<Value, JsValue> {
    let h = start(5, false, true, Profile::Promise);
    let refused = match h.runtime.ready().await {
        Err(error) => error.name(),
        Ok(_) => return Err(JsValue::from_str("load failure unexpectedly accepted")),
    };
    h.runtime.stop().await;
    Ok(
        json!({"trace":&*h.shared.trace.borrow(),"reports":&*h.shared.reports.borrow(),"refused":refused,"stored":&*h.shared.stored.borrow()}),
    )
}
async fn driven() -> Result<Value, JsValue> {
    let h = start(0, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    let result = drive_to_done(
        &h.runtime,
        Msg::Add { by: 9 },
        |state| state.count == 9,
        DriveOptions::default(),
    )
    .await
    .map_err(error)?;
    h.shared.log(json!(["driven", result.count]));
    Ok(output(&h))
}
pub(super) async fn run() -> Result<Value, JsValue> {
    let (a, b) = futures::join!(basic(7), basic(70));
    let (a, at) = a?;
    let (b, bt) = b?;
    let (drain, dt) = drain().await?;
    let (dispose, ct) = dispose().await?;
    Ok(
        json!({"observations":{"a":a,"b":b,"drain":drain,"dispose":dispose,"save_failure":save_failure().await?,"load_failure":load_failure().await?,"drive":driven().await?},"timers":{"a":at,"b":bt,"drain":dt,"dispose":ct}}),
    )
}

fn arm_failure_cause(host: &Host) -> bool {
    host.runtime
        .reports()
        .iter()
        .any(|report| match &*report.error {
            RuntimeError::Timer(error)
                if report.phase == demlik_tea::runtime::ErrorPhase::Discard
                    && error.message == "deadline arm refused (code 73)" =>
            {
                error.cause.as_ref().is_some_and(|cause| {
                    cause.with_payload(|payload| payload.downcast_ref::<u32>() == Some(&73))
                })
            }
            _ => false,
        })
}
pub(super) async fn host_seams() -> Result<Value, JsValue> {
    let h = start(2, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    let pending = h.runtime.dispatch_once(Msg::Work);
    until(|| saw(&h, "work:start")).await?;
    drop(h.runtime.stop());
    until(|| {
        h.shared.timer.stats()["arms"]
            .as_array()
            .is_some_and(|arms| !arms.is_empty())
    })
    .await?;
    h.shared.work.release();
    pending.await.map_err(error)?;
    h.runtime.stop().await;
    let cancelled = h.shared.timer.stats();
    if cancelled["active"] != json!([]) || cancelled["clears"] != json!([1]) {
        return Err(JsValue::from_str(&format!(
            "deadline canceler leaked after dropped stop waiter: {cancelled}"
        )));
    }
    let dropped_stop = json!({"timers":cancelled,"gate":format!("{:?}",h.runtime.gate()),"reports":&*h.shared.reports.borrow()});

    let h = start(2, false, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    let pending = h.runtime.dispatch_once(Msg::Work);
    until(|| saw(&h, "work:start")).await?;
    h.shared.timer.fail_next();
    h.runtime.stop().await;
    if !arm_failure_cause(&h) {
        return Err(JsValue::from_str("drain arm error lost its original cause"));
    }
    let drain_arm = json!({"original_cause":true,"timers":h.shared.timer.stats(),"reports":&*h.shared.reports.borrow(),"gate":format!("{:?}",h.runtime.gate())});
    h.shared.work.release();
    pending.await.map_err(error)?;

    let h = start(3, true, false, Profile::Promise);
    h.runtime.ready().await.map_err(error)?;
    h.shared.timer.fail_next();
    h.runtime.stop().await;
    if !arm_failure_cause(&h) {
        return Err(JsValue::from_str(
            "disposal arm error lost its original cause",
        ));
    }
    let dispose_arm = json!({"original_cause":true,"timers":h.shared.timer.stats(),"reports":&*h.shared.reports.borrow(),"gate":format!("{:?}",h.runtime.gate())});
    h.shared.cleanup.release();
    until(|| saw(&h, "feed:cleanup:end")).await?;

    let h = start(1, false, false, Profile::Effect);
    let scope = demlik_tea::runtime::EffectScope::new();
    scope.attach(&h.runtime).await.map_err(error)?;
    let runtime = h.runtime.clone();
    let outcome = scope
        .run(async move {
            runtime.ready().await.map_err(error)?;
            runtime
                .dispatch(Msg::Arm { ms: Some(0) })
                .await
                .map_err(error)?;
            until(|| runtime.get_state().unwrap().timer.is_none()).await?;
            runtime.idle().await.map_err(error)?;
            Ok::<_, JsValue>(runtime.get_state().unwrap().count)
        })
        .await;
    let count = match outcome {
        demlik_tea::runtime::ScopeExit::Success(count) => count,
        _ => return Err(JsValue::from_str("generic Effect scope did not finish")),
    };
    let effect_scope = json!({"count":count,"closed":scope.is_closed(),"timers":h.shared.timer.stats(),"reports":&*h.shared.reports.borrow()});
    let timer = Rc::new(NodeTimer::default());
    let seen = Rc::new(RefCell::new(Vec::new()));
    let telemetry = Rc::clone(&seen);
    let mut options: Options<Model, Msg, std::convert::Infallible, std::convert::Infallible> =
        Options::new(Profile::Promise);
    options.timer = Some(RuntimeTimer::new(Rc::clone(&timer)));
    options.telemetry = Some(demlik_tea::runtime::Telemetry::new(move |event| {
        let seen = Rc::clone(&telemetry);
        async move {
            turn().await;
            seen.borrow_mut().push(event);
            Ok(())
        }
    }));
    let runtime = demlik_tea::runtime::try_launch(
        machine(false),
        (),
        demlik_tea::runtime::NoInterpreter::new(),
        demlik_tea::runtime::NoSubscriptions::new(),
        options,
    );
    runtime.ready().await.map_err(error)?;
    runtime.dispatch(Msg::Add { by: 1 }).await.map_err(error)?;
    until(|| seen.borrow().len() == 1).await?;
    runtime.stop().await;
    let clock_telemetry = json!({"events":&*seen.borrow(),"timers":timer.stats()});
    Ok(
        json!({"dropped_stop":dropped_stop,"drain_arm_failure":drain_arm,"dispose_arm_failure":dispose_arm,"effect_scope":effect_scope,"clock_telemetry":clock_telemetry}),
    )
}
