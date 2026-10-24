use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, ErrorPhase, Gate, Interpreter, Options, Persistence, Profile,
    RuntimeError, SubscriptionWork, Subscriptions, launch,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use tokio::sync::Notify;

type Log = Rc<RefCell<Vec<String>>>;
struct State(u32);
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
messages! {enum Msg { Start, Queued, Late }}
enum Cmd {
    Hold,
    After,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Hold => "hold",
            Self::After => "after",
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
fn machine(boot_commands: bool, sub: bool) -> Machine<'static, State, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(
                loaded.unwrap_or(State(0)),
                if boot_commands {
                    vec![Cmd::Hold, Cmd::After]
                } else {
                    vec![]
                },
            )
        }),
        update: Update::reducer(|_: &State, msg: &Msg| match msg {
            Msg::Start => Step::new(State(1), vec![Cmd::Hold, Cmd::After]),
            Msg::Queued => Step::new(State(2), vec![]),
            Msg::Late => Step::new(State(3), vec![]),
        }),
        subscriptions: demlik_tea::core::subscriptions(move |_: &State| {
            if sub {
                vec![Sub::new("source", serde_json::json!({})).unwrap()]
            } else {
                vec![]
            }
        }),
    }
}
#[derive(Clone)]
struct Saved {
    state: Rc<Cell<Option<u32>>>,
    calls: Rc<Cell<usize>>,
    hold_save: Option<usize>,
    hold_load: bool,
    entered: Rc<Notify>,
    release: Rc<Notify>,
    log: Log,
}
impl Saved {
    fn new(log: Log) -> Self {
        Self {
            state: Rc::new(Cell::new(None)),
            calls: Rc::new(Cell::new(0)),
            hold_save: None,
            hold_load: false,
            entered: Rc::new(Notify::new()),
            release: Rc::new(Notify::new()),
            log,
        }
    }
}
impl Store<State> for Saved {
    type Raw = Option<u32>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.log.borrow_mut().push("load:start".into());
        if self.hold_load {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.log.borrow_mut().push("load:done".into());
        Ok(self.state.get())
    }
    async fn save(&self, state: &State) -> Result<(), Self::Error> {
        let call = self.calls.get() + 1;
        self.calls.set(call);
        self.log
            .borrow_mut()
            .push(format!("save:{call}:{}:start", state.0));
        if self.hold_save == Some(call) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.state.set(Some(state.0));
        self.log
            .borrow_mut()
            .push(format!("save:{call}:{}:done", state.0));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<State> {
        raw.map_or(Migrated::Fresh, |n| Migrated::State(State(n)))
    }
}
struct BodyGuard(Log);
impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.borrow_mut().push("body:dropped".into());
    }
}
#[derive(Clone)]
struct Held {
    entered: Rc<Notify>,
    release: Rc<Notify>,
    closing: Rc<Notify>,
    closed: Rc<Notify>,
    hold_cleanup: bool,
    uninterruptible: bool,
    external: Option<Rc<Notify>>,
    log: Log,
}
impl Held {
    fn new(log: Log) -> Self {
        Self {
            entered: Rc::new(Notify::new()),
            release: Rc::new(Notify::new()),
            closing: Rc::new(Notify::new()),
            closed: Rc::new(Notify::new()),
            hold_cleanup: false,
            uninterruptible: false,
            external: None,
            log,
        }
    }
}
impl Interpreter<Cmd> for Held {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        ctx: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        if matches!(cmd, Cmd::After) {
            return Some(CommandWork::new(async {
                self.log.borrow_mut().push("after".into());
                Ok(vec![])
            }));
        }
        let work = CommandWork::new(async move {
            let _guard = BodyGuard(Rc::clone(&self.log));
            self.log.borrow_mut().push("body:start".into());
            if let Some(release) = &self.external {
                let release = Rc::clone(release);
                let log = Rc::clone(&self.log);
                ctx.wait_until(async move {
                    log.borrow_mut().push("external:start".into());
                    release.notified().await;
                    log.borrow_mut().push("external:done".into());
                    Ok(())
                });
            }
            self.entered.notify_one();
            self.release.notified().await;
            self.log.borrow_mut().push("body:done".into());
            Ok(vec![Msg::Late])
        })
        .with_cleanup(|| async {
            self.log.borrow_mut().push("cleanup:start".into());
            self.closing.notify_one();
            if self.hold_cleanup {
                self.closed.notified().await;
            }
            self.log.borrow_mut().push("cleanup:done".into());
            Ok(())
        });
        Some(if self.uninterruptible {
            work.uninterruptible()
        } else {
            work
        })
    }
}
struct Source {
    release: Rc<Notify>,
    log: Log,
}
impl Subscriptions<Sub, Msg> for Source {
    type Error = &'static str;
    fn start(
        &self,
        _: Sub,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error> {
        let release = Rc::clone(&self.release);
        let log = Rc::clone(&self.log);
        Ok(Some(SubscriptionWork::new(move || async move {
            log.borrow_mut().push("sub:closing".into());
            release.notified().await;
            log.borrow_mut().push("sub:closed".into());
            Ok(())
        })))
    }
}
fn options(profile: Profile, store: Saved) -> Options<State, Msg, &'static str, &'static str> {
    let mut options = Options::new(profile);
    options.store = Some(Persistence::new(store));
    options.dispose_timeout = Duration::from_millis(15);
    options
}
#[tokio::test(flavor = "current_thread")]
async fn promise_and_uninterruptible_effect_bound_both_waits_then_drop_late_work_without_late_saves()
 {
    tokio::task::LocalSet::new().run_until(async {
        for profile in [Profile::Promise,Profile::Effect]{
            let log=Rc::new(RefCell::new(vec![]));let store=Saved::new(Rc::clone(&log));
            let mut handler=Held::new(Rc::clone(&log));handler.uninterruptible=profile==Profile::Effect;
            let sub_release=Rc::new(Notify::new());
            let runtime=launch(machine(false,true),(),handler.clone(),Source{release:Rc::clone(&sub_release),log:Rc::clone(&log)},options(profile,store.clone()));
            runtime.ready().await.unwrap();
            let current={let rt=runtime.clone();tokio::task::spawn_local(async move{rt.dispatch_once(Msg::Start).await})};
            handler.entered.notified().await;
            let queued={let rt=runtime.clone();tokio::task::spawn_local(async move{rt.dispatch_once(Msg::Queued).await})};
            tokio::task::yield_now().await;
            let start=std::time::Instant::now();
            tokio::time::timeout(Duration::from_secs(1),runtime.stop()).await.unwrap();
            assert!(start.elapsed()>=Duration::from_millis(30));
            assert_eq!(runtime.gate(),Gate::Abandoned);
            assert!(!current.is_finished());assert!(!queued.is_finished());
            assert_eq!(store.calls.get(),3);assert_eq!(store.state.get(),Some(1));
            let reports=runtime.reports();
            assert!(reports.iter().any(|r|matches!(&*r.error,RuntimeError::RuntimeDiscarded{pending:1})));
            assert!(reports.iter().any(|r|matches!(&*r.error,RuntimeError::DrainTimeout{cmd_types,pending:1,..} if cmd_types==&["hold"])));
            assert!(reports.iter().any(|r|matches!(&*r.error,RuntimeError::DisposeTimeout{pending:1,..})));
            handler.release.notify_one();sub_release.notify_one();
            current.await.unwrap().unwrap();
            assert!(matches!(&*queued.await.unwrap().unwrap_err(),RuntimeError::Discarded{msg_type} if msg_type=="Queued"));
            runtime.idle().await.unwrap();
            assert_eq!(runtime.get_state().unwrap().0,1);assert_eq!(store.calls.get(),3);
            assert!(!log.borrow().iter().any(|entry|entry=="after"));
            assert!(runtime.reports().iter().any(|r|matches!(&*r.error,RuntimeError::Discarded{msg_type} if msg_type=="Late")));
            runtime.stop().await;assert_eq!(store.calls.get(),3);
        }
    }).await;
}
#[tokio::test(flavor = "current_thread")]
async fn effect_interrupt_drops_body_before_awaited_finalizer_then_drains_already_accepted_messages()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved::new(Rc::clone(&log));
            let mut handler = Held::new(Rc::clone(&log));
            handler.hold_cleanup = true;
            let runtime = launch(
                machine(false, false),
                (),
                handler.clone(),
                demlik_tea::runtime::NoSubscriptions::new(),
                options(Profile::Effect, store.clone()),
            );
            runtime.ready().await.unwrap();
            let current = {
                let rt = runtime.clone();
                tokio::task::spawn_local(async move { rt.dispatch_once(Msg::Start).await })
            };
            handler.entered.notified().await;
            let queued = {
                let rt = runtime.clone();
                tokio::task::spawn_local(async move { rt.dispatch_once(Msg::Queued).await })
            };
            tokio::task::yield_now().await;
            let stopped = {
                let rt = runtime.clone();
                tokio::task::spawn_local(async move { rt.stop().await })
            };
            handler.closing.notified().await;
            assert!(!stopped.is_finished());
            let before = log.borrow().clone();
            let dropped = before
                .iter()
                .position(|x| x == "body:dropped")
                .expect("interrupt must drop body before finalizer");
            let closing = before.iter().position(|x| x == "cleanup:start").unwrap();
            assert!(dropped < closing);
            handler.closed.notify_one();
            stopped.await.unwrap();
            current.await.unwrap().unwrap();
            queued.await.unwrap().unwrap();
            assert_eq!(runtime.gate(), Gate::Closed);
            assert_eq!(runtime.get_state().unwrap().0, 2);
            assert_eq!(store.state.get(), Some(2));
            assert_eq!(store.calls.get(), 4);
            assert!(
                !log.borrow()
                    .iter()
                    .any(|x| x == "body:done" || x == "after")
            );
            assert!(
                !runtime
                    .reports()
                    .iter()
                    .any(|r| matches!(&*r.error, RuntimeError::DrainTimeout { .. }))
            );
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn effect_external_wait_until_is_still_polled_after_owned_handler_interruption() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved::new(Rc::clone(&log));
            let external = Rc::new(Notify::new());
            let mut handler = Held::new(Rc::clone(&log));
            handler.external = Some(Rc::clone(&external));
            let runtime = launch(
                machine(false, false),
                (),
                handler.clone(),
                demlik_tea::runtime::NoSubscriptions::new(),
                options(Profile::Effect, store.clone()),
            );
            runtime.ready().await.unwrap();
            let current = {
                let rt = runtime.clone();
                tokio::task::spawn_local(async move { rt.dispatch_once(Msg::Start).await })
            };
            handler.entered.notified().await;
            runtime.stop().await;
            current.await.unwrap().unwrap();
            assert_eq!(runtime.gate(), Gate::Abandoned);
            assert!(log.borrow().iter().any(|x| x == "external:start"));
            assert!(!log.borrow().iter().any(|x| x == "external:done"));
            external.notify_one();
            runtime.idle().await.unwrap();
            assert!(log.borrow().iter().any(|x| x == "external:done"));
            assert_eq!(store.calls.get(), 3);
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn late_boot_after_abandonment_installs_restored_state_and_never_starts_a_save_or_effect() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(vec![]));
                let mut store = Saved::new(Rc::clone(&log));
                store.hold_load = true;
                store.state.set(Some(5));
                let handler = Held::new(Rc::clone(&log));
                let runtime = launch(
                    machine(true, false),
                    (),
                    handler,
                    demlik_tea::runtime::NoSubscriptions::new(),
                    options(profile, store.clone()),
                );
                store.entered.notified().await;
                runtime.stop().await;
                assert_eq!(store.calls.get(), 0);
                assert!(runtime.get_state().is_none());
                store.release.notify_one();
                runtime.ready().await.unwrap();
                assert_eq!(runtime.get_state().unwrap().0, 5);
                assert_eq!(store.calls.get(), 0);
                assert_eq!(&*log.borrow(), &["load:start", "load:done"]);
                runtime.stop().await;
                assert_eq!(store.calls.get(), 0);
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn stop_does_not_cancel_an_existing_save_and_starts_no_store_call_after_return() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(vec![]));
                let mut store = Saved::new(Rc::clone(&log));
                store.hold_save = Some(2);
                let handler = Held::new(Rc::clone(&log));
                let runtime = launch(
                    machine(false, false),
                    (),
                    handler,
                    demlik_tea::runtime::NoSubscriptions::new(),
                    options(profile, store.clone()),
                );
                runtime.ready().await.unwrap();
                let pending = {
                    let rt = runtime.clone();
                    tokio::task::spawn_local(async move { rt.dispatch_once(Msg::Start).await })
                };
                store.entered.notified().await;
                assert_eq!(runtime.get_state().unwrap().0, 1);
                assert_eq!(store.state.get(), Some(0));
                runtime.stop().await;
                assert_eq!(store.calls.get(), 3);
                assert_eq!(store.state.get(), Some(1));
                assert!(!pending.is_finished());
                store.release.notify_one();
                pending.await.unwrap().unwrap();
                runtime.idle().await.unwrap();
                assert_eq!(store.calls.get(), 3);
                assert!(log.borrow().iter().any(|x| x == "save:2:1:done"));
                assert!(
                    !log.borrow()
                        .iter()
                        .any(|x| x == "body:start" || x == "after")
                );
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn send_producer_refusal_reaches_the_sink_while_serial_handler_is_held() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved::new(Rc::clone(&log));
            let handler = Held::new(Rc::clone(&log));
            let phases = Rc::new(RefCell::new(vec![]));
            let sink = Rc::clone(&phases);
            let mut options = options(Profile::Promise, store);
            options.on_error = Some(Rc::new(move |_, phase| sink.borrow_mut().push(phase)));
            let runtime = launch(
                machine(false, false),
                (),
                handler.clone(),
                demlik_tea::runtime::NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            runtime.producer().emit(Msg::Start).unwrap();
            handler.entered.notified().await;
            let stopped = {
                let rt = runtime.clone();
                tokio::task::spawn_local(async move { rt.stop().await })
            };
            tokio::task::yield_now().await;
            assert!(runtime.producer().emit(Msg::Late).is_err());
            tokio::task::yield_now().await;
            assert_eq!(
                &*phases.borrow(),
                &[ErrorPhase::Discard, ErrorPhase::Discard]
            );
            handler.release.notify_one();
            stopped.await.unwrap();
            runtime.idle().await.unwrap();
        })
        .await;
}

struct FailingSource {
    fail: Rc<Notify>,
    closing: Rc<Notify>,
    release: Rc<Notify>,
    log: Log,
}
impl Subscriptions<Sub, Msg> for FailingSource {
    type Error = &'static str;
    fn start(
        &self,
        _: Sub,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error> {
        self.log.borrow_mut().push("source:start".into());
        let fail = Rc::clone(&self.fail);
        let closing = Rc::clone(&self.closing);
        let release = Rc::clone(&self.release);
        let log = Rc::clone(&self.log);
        Ok(Some(
            SubscriptionWork::new(move || async move {
                log.borrow_mut().push("source:cleanup:start".into());
                closing.notify_one();
                release.notified().await;
                log.borrow_mut().push("source:cleanup:done".into());
                Ok(())
            })
            .with_source(async move {
                fail.notified().await;
                Err("unmapped source failure")
            }),
        ))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn an_unmapped_subscription_source_failure_stops_the_run_and_awaits_explicit_cleanup() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(vec![]));
                let fail = Rc::new(Notify::new());
                let closing = Rc::new(Notify::new());
                let release = Rc::new(Notify::new());
                let options: Options<State, Msg, std::convert::Infallible, &'static str> =
                    Options::new(profile);
                let runtime = launch(
                    machine(false, true),
                    (),
                    demlik_tea::runtime::NoInterpreter::new(),
                    FailingSource {
                        fail: Rc::clone(&fail),
                        closing: Rc::clone(&closing),
                        release: Rc::clone(&release),
                        log: Rc::clone(&log),
                    },
                    options,
                );
                runtime.ready().await.unwrap();
                fail.notify_one();
                closing.notified().await;
                assert_ne!(runtime.gate(), Gate::Open);
                assert!(runtime.producer().emit(Msg::Queued).is_err());
                let stop = runtime.stop();
                let mut stop = std::pin::pin!(stop);
                assert!(futures::poll!(stop.as_mut()).is_pending());
                assert_eq!(&*log.borrow(), &["source:start", "source:cleanup:start"]);
                release.notify_one();
                stop.await;
                assert_eq!(
                    &*log.borrow(),
                    &[
                        "source:start",
                        "source:cleanup:start",
                        "source:cleanup:done"
                    ]
                );
                let reports = runtime.reports();
                assert!(reports.iter().any(|report| report.phase == ErrorPhase::Sub
                    && matches!(
                        &*report.error,
                        RuntimeError::Handler("unmapped source failure")
                    )));
                assert_eq!(runtime.get_state().unwrap().0, 0);
                assert_eq!(runtime.gate(), Gate::Closed);
            }
        })
        .await;
}
struct EagerSource(Log);
impl Subscriptions<Sub, Msg> for EagerSource {
    type Error = &'static str;
    fn start(
        &self,
        _: Sub,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error> {
        self.0.borrow_mut().push("sub:start".into());
        Ok(Some(SubscriptionWork::new(|| async { Ok(()) })))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn eager_storeless_launch_starts_subscription_and_first_handler_prefix_before_returning() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let handler = Held::new(Rc::clone(&log));
            let options: Options<State, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            let runtime = launch(
                machine(true, true),
                (),
                handler.clone(),
                EagerSource(Rc::clone(&log)),
                options,
            );
            assert_eq!(&*log.borrow(), &["sub:start", "body:start"]);
            assert_eq!(runtime.get_state().unwrap().0, 0);
            let ready = runtime.ready();
            let mut ready = std::pin::pin!(ready);
            assert!(futures::poll!(ready.as_mut()).is_pending());
            handler.release.notify_one();
            ready.await.unwrap();
            runtime.idle().await.unwrap();
            runtime.stop().await;
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn eager_stored_launch_starts_load_but_keeps_initial_state_and_save_deferred_until_await() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved::new(Rc::clone(&log));
            let runtime = launch(
                machine(false, false),
                (),
                Held::new(Rc::clone(&log)),
                demlik_tea::runtime::NoSubscriptions::new(),
                options(Profile::Promise, store.clone()),
            );
            assert_eq!(&*log.borrow(), &["load:start", "load:done"]);
            assert!(runtime.get_state().is_none());
            assert_eq!(store.calls.get(), 0);
            runtime.ready().await.unwrap();
            assert_eq!(store.calls.get(), 1);
            runtime.stop().await;
        })
        .await;
}

struct Immediate(Log);
impl Interpreter<Cmd> for Immediate {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.borrow_mut().push(cmd.tag().into());
            Ok(if matches!(cmd, Cmd::Hold) {
                vec![Msg::Late]
            } else {
                vec![]
            })
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn an_already_ready_handler_still_yields_before_next_handler_commit_or_followup_fold() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log: Log = Rc::new(RefCell::new(vec![]));
            let committed = Rc::clone(&log);
            let mut options: Options<State, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            options.on_commit.push(Rc::new(move |msg: Option<&Msg>, _| {
                committed
                    .borrow_mut()
                    .push(format!("commit:{}", msg.map(Tagged::tag).unwrap_or("boot")))
            }));
            let runtime = launch(
                machine(true, false),
                (),
                Immediate(Rc::clone(&log)),
                demlik_tea::runtime::NoSubscriptions::new(),
                options,
            );
            assert_eq!(&*log.borrow(), &["hold"]);
            assert_eq!(runtime.get_state().unwrap().0, 0);
            runtime.ready().await.unwrap();
            runtime.idle().await.unwrap();
            assert_eq!(
                &*log.borrow(),
                &["hold", "after", "commit:boot", "commit:Late"]
            );
            runtime.stop().await;
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn storeless_boot_without_commands_defers_public_commit_callbacks_until_await() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log: Log = Rc::new(RefCell::new(vec![]));
            let committed = Rc::clone(&log);
            let mut options: Options<State, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            options.on_commit.push(Rc::new(move |_, _| {
                committed.borrow_mut().push("commit".into())
            }));
            let runtime = launch(
                machine(false, false),
                (),
                demlik_tea::runtime::NoInterpreter::new(),
                demlik_tea::runtime::NoSubscriptions::new(),
                options,
            );
            assert_eq!(runtime.get_state().unwrap().0, 0);
            assert!(log.borrow().is_empty());
            runtime.ready().await.unwrap();
            assert_eq!(&*log.borrow(), &["commit"]);
            runtime.stop().await;
        })
        .await;
}
