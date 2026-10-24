use std::cell::RefCell;
use std::rc::Rc;

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
    launch,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};

struct Model {
    n: u32,
    done: bool,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
messages! { #[derive(Debug)] enum Msg { Start, Added { by: u32 }, Finish } }
enum Cmd {
    Batch,
    Last,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Batch => "batch",
            Self::Last => "last",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, value: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(value)
    }
}
type Log = Rc<RefCell<Vec<String>>>;
#[derive(Clone)]
struct Saved {
    cell: Rc<RefCell<Option<(u32, bool)>>>,
    log: Log,
}
impl Store<Model> for Saved {
    type Raw = Option<(u32, bool)>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(*self.cell.borrow())
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        self.log.borrow_mut().push(format!("save:{}", state.n));
        *self.cell.borrow_mut() = Some((state.n, state.done));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        match raw {
            None => Migrated::Fresh,
            Some((n, done)) => Migrated::State(Model {
                n,
                done,
                local: Rc::new(()),
            }),
        }
    }
}
struct Effects(Log);
impl Interpreter<Cmd> for Effects {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        context: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.borrow_mut().push(command.tag().into());
            Ok(match command {
                Cmd::Batch => vec![Msg::Added { by: 2 }, Msg::Added { by: 4 }],
                Cmd::Last => {
                    context.dispatch(Msg::Added { by: 8 }).unwrap();
                    vec![Msg::Finish]
                }
            })
        }))
    }
}
fn machine() -> Machine<'static, Model, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(
                loaded.unwrap_or(Model {
                    n: 0,
                    done: false,
                    local: Rc::new(()),
                }),
                vec![],
            )
        }),
        update: Update::reducer(|state: &Model, msg: &Msg| {
            let (n, done, commands) = match msg {
                Msg::Start => (1, false, vec![Cmd::Batch, Cmd::Last]),
                Msg::Added { by } => (state.n + by, state.done, vec![]),
                Msg::Finish => (state.n, true, vec![]),
            };
            Step::new(
                Model {
                    n,
                    done,
                    local: Rc::clone(&state.local),
                },
                commands,
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn real_store_commits_before_serial_handlers_and_transitive_followups() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved {
                cell: Rc::new(RefCell::new(None)),
                log: Rc::clone(&log),
            };
            let mut options = Options::new(Profile::Promise);
            options.store = Some(Persistence::new(store.clone()));
            options.terminal = Some(Rc::new(|state: &Model| state.done));
            let commits = Rc::clone(&log);
            options
                .on_commit
                .push(Rc::new(move |msg: Option<&Msg>, state: &Model| {
                    commits.borrow_mut().push(format!(
                        "commit:{}:{}",
                        msg.map(Tagged::tag).unwrap_or("boot"),
                        state.n
                    ));
                }));
            let runtime = launch(
                machine(),
                (),
                Effects(Rc::clone(&log)),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            runtime.dispatch(Msg::Start).await.unwrap();
            assert_eq!(runtime.get_state().unwrap().n, 15);
            assert_eq!(store.load().await.unwrap(), Some((15, true)));
            assert_eq!(runtime.done().await.unwrap().n, 15);
            assert_eq!(
                &*log.borrow(),
                &[
                    "save:0",
                    "commit:boot:0",
                    "save:1",
                    "batch",
                    "last",
                    "commit:Start:1",
                    "save:3",
                    "commit:Added:3",
                    "save:7",
                    "commit:Added:7",
                    "save:15",
                    "commit:Added:15",
                    "save:15",
                    "commit:Finish:15",
                ]
            );
            fn send<T: Send>(_: T) {}
            send(runtime.producer());
            runtime.stop().await;
        })
        .await;
}

struct ScopedDefect(Log);
impl Interpreter<Cmd> for ScopedDefect {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(
            CommandWork::new(async { panic!("body defect") }).with_cleanup(|| async {
                tokio::task::yield_now().await;
                self.0.borrow_mut().push("released".into());
                Ok(())
            }),
        )
    }
}
#[tokio::test(flavor = "current_thread")]
async fn explicit_async_command_cleanup_runs_after_a_defect_before_dispatch_rejects() {
    tokio::task::LocalSet::new().run_until(async {
        let log=Rc::new(RefCell::new(vec![]));
        let mut options: Options<Model,Msg,std::convert::Infallible,&'static str>=Options::new(Profile::Effect);
        let commits=Rc::clone(&log);
        options.on_commit.push(Rc::new(move |msg,state|if msg.is_some() {commits.borrow_mut().push(format!("committed:{}",state.n));}));
        let runtime=launch(machine(),(),ScopedDefect(Rc::clone(&log)),NoSubscriptions::new(),options);
        runtime.ready().await.unwrap();
        let error=runtime.dispatch(Msg::Start).await.unwrap_err();
        assert!(matches!(&*error,demlik_tea::runtime::RuntimeError::Panic(cause) if cause.summary=="body defect"));
        assert_eq!(&*log.borrow(),&["released","committed:1"]);
        runtime.stop().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn storeless_counter_has_an_eager_local_launch_and_a_sendable_remote_producer() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let mut options: Options<Model, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            options.terminal = Some(Rc::new(|state: &Model| state.n >= 5));
            let runtime = launch(machine(), (), Effects(log), NoSubscriptions::new(), options);
            assert_eq!(runtime.get_state().unwrap().n, 0);
            runtime.ready().await.unwrap();
            let producer = runtime.producer();
            std::thread::spawn(move || producer.emit(Msg::Added { by: 5 }))
                .join()
                .unwrap()
                .unwrap();
            runtime.idle().await.unwrap();
            assert_eq!(runtime.result().unwrap().n, 5);
            assert_eq!(runtime.done().await.unwrap().n, 5);
            runtime.stop().await;
        })
        .await;
}

#[derive(Clone)]
struct TerminalStore {
    inner: Saved,
    entered: Rc<tokio::sync::Notify>,
    release: Rc<tokio::sync::Notify>,
    first: Rc<std::cell::Cell<bool>>,
    fail: bool,
}
impl Store<Model> for TerminalStore {
    type Raw = Option<(u32, bool)>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.inner.load().await
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        if state.done {
            if !self.first.replace(true) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            if self.fail {
                return Err("terminal save refused");
            }
        }
        self.inner.save(state).await
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        self.inner.migrate(raw)
    }
}
fn terminal_machine() -> Machine<'static, Model, Msg, Cmd, Sub, ()> {
    let mut machine = machine();
    let update = machine.update;
    machine.update = Update::reducer(move |state: &Model, msg: &Msg| {
        let mut next = update.apply(state, msg).unwrap();
        if matches!(msg, Msg::Finish) {
            next.commands.push(Cmd::Batch);
        }
        next
    });
    machine
}
struct HeldEffects {
    entered: Rc<tokio::sync::Notify>,
    release: Rc<tokio::sync::Notify>,
}
impl Interpreter<Cmd> for HeldEffects {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(vec![])
        }))
    }
}
fn terminal_store(fail: bool) -> TerminalStore {
    TerminalStore {
        inner: Saved {
            cell: Rc::new(RefCell::new(None)),
            log: Rc::new(RefCell::new(vec![])),
        },
        entered: Rc::new(tokio::sync::Notify::new()),
        release: Rc::new(tokio::sync::Notify::new()),
        first: Rc::new(std::cell::Cell::new(false)),
        fail,
    }
}
#[tokio::test(flavor = "current_thread")]
async fn terminal_queries_distinguish_pending_save_saved_state_and_waiting_commit() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let store = terminal_store(false);
                let entered = Rc::new(tokio::sync::Notify::new());
                let release = Rc::new(tokio::sync::Notify::new());
                let calls = Rc::new(std::cell::Cell::new(0));
                let predicate_calls = Rc::clone(&calls);
                let mut options = Options::new(profile);
                options.store = Some(Persistence::new(store.clone()));
                options.terminal = Some(Rc::new(move |state: &Model| {
                    predicate_calls.set(predicate_calls.get() + 1);
                    state.done
                }));
                let runtime = launch(
                    terminal_machine(),
                    (),
                    HeldEffects {
                        entered: Rc::clone(&entered),
                        release: Rc::clone(&release),
                    },
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                assert_eq!(
                    calls.get(),
                    0,
                    "installing state must not invoke the terminal predicate"
                );
                let before = {
                    let runtime = runtime.clone();
                    tokio::task::spawn_local(async move { runtime.done().await })
                };
                tokio::task::yield_now().await;
                let before_install = calls.get();
                runtime.producer().emit(Msg::Finish).unwrap();
                store.entered.notified().await;
                assert!(runtime.get_state().unwrap().done);
                assert_eq!(store.load().await.unwrap(), Some((0, false)));
                assert_eq!(
                    calls.get(),
                    before_install,
                    "pending install is not a terminal query"
                );
                assert!(runtime.result().is_none());
                assert_eq!(
                    calls.get(),
                    before_install,
                    "pending result short-circuits its predicate"
                );
                let during = {
                    let runtime = runtime.clone();
                    tokio::task::spawn_local(async move { runtime.done().await })
                };
                tokio::task::yield_now().await;
                assert!(!before.is_finished());
                assert!(!during.is_finished());
                store.release.notify_one();
                entered.notified().await;
                assert!(
                    runtime.result().unwrap().done,
                    "saved result is visible while its command is held"
                );
                assert!(
                    runtime.done().await.unwrap().done,
                    "a new query can read the saved terminal state"
                );
                assert!(
                    !before.is_finished(),
                    "already waiting done resolves at commit callbacks"
                );
                release.notify_one();
                runtime.idle().await.unwrap();
                assert!(before.await.unwrap().unwrap().done);
                assert!(during.await.unwrap().unwrap().done);
                assert_eq!(store.load().await.unwrap(), Some((0, true)));
                runtime.stop().await;
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn failed_terminal_save_rejects_earlier_current_and_later_waiters_without_committing() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let store = terminal_store(true);
                let commits = Rc::new(std::cell::Cell::new(0));
                let count = Rc::clone(&commits);
                let mut options = Options::new(profile);
                options.store = Some(Persistence::new(store.clone()));
                options.terminal = Some(Rc::new(|state: &Model| state.done));
                options.on_commit.push(Rc::new(move |msg: Option<&Msg>, _| {
                    if msg.is_some() {
                        count.set(count.get() + 1);
                    }
                }));
                let runtime = launch(
                    terminal_machine(),
                    (),
                    demlik_tea::runtime::NoInterpreter::<&'static str>::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                let before = {
                    let runtime = runtime.clone();
                    tokio::task::spawn_local(async move { runtime.done().await })
                };
                tokio::task::yield_now().await;
                runtime.producer().emit(Msg::Finish).unwrap();
                store.entered.notified().await;
                let during = {
                    let runtime = runtime.clone();
                    tokio::task::spawn_local(async move { runtime.done().await })
                };
                tokio::task::yield_now().await;
                store.release.notify_one();
                runtime.idle().await.unwrap();
                assert!(runtime.result().is_none());
                for outcome in [
                    before.await.unwrap(),
                    during.await.unwrap(),
                    runtime.done().await,
                ] {
                    let error = outcome
                        .err()
                        .expect("terminal save failure must reject done");
                    assert!(matches!(
                        &*error,
                        demlik_tea::runtime::RuntimeError::Save("terminal save refused")
                    ));
                }
                assert_eq!(commits.get(), 0);
                assert_eq!(store.load().await.unwrap(), Some((0, false)));
                let reports = runtime.reports();
                assert_eq!(reports.len(), 1);
                assert_eq!(reports[0].phase, demlik_tea::runtime::ErrorPhase::FollowUp);
                runtime.stop().await;
            }
        })
        .await;
}

struct TracedSubscriptions(Log);
impl demlik_tea::runtime::Subscriptions<Sub, Msg> for TracedSubscriptions {
    type Error = &'static str;
    fn start(
        &self,
        sub: Sub,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<demlik_tea::runtime::SubscriptionWork<Self::Error>>, Self::Error> {
        let label = format!("{}:{}", sub.kind(), sub.deps()["n"].as_u64().unwrap());
        self.0.borrow_mut().push(format!("start:{label}"));
        let log = Rc::clone(&self.0);
        Ok(Some(demlik_tea::runtime::SubscriptionWork::new(
            move || async move {
                log.borrow_mut().push(format!("dispose:{label}"));
                Ok(())
            },
        )))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn failed_deps_keep_their_running_type_while_siblings_reconcile_and_cleanup_starts_first() {
    use demlik_tea::core::{SubEntry, SubscriptionEntries};
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut machine = machine();
            machine.subscriptions = Box::new(SubscriptionEntries::new(vec![
                SubEntry::new("fragile", |state: &Model| {
                    if state.n == 1 {
                        panic!("deps failed");
                    }
                    Some(serde_json::json!({"n":state.n}))
                }),
                SubEntry::new("steady", |state: &Model| {
                    Some(serde_json::json!({"n":state.n}))
                }),
                SubEntry::new("removed", |state: &Model| {
                    (state.n == 0).then(|| serde_json::json!({"n":0}))
                }),
            ]));
            let log = Rc::new(RefCell::new(vec![]));
            let options: Options<Model, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            let runtime = launch(
                machine,
                (),
                Effects(Rc::clone(&log)),
                TracedSubscriptions(Rc::clone(&log)),
                options,
            );
            runtime.ready().await.unwrap();
            assert!(runtime.dispatch_once(Msg::Added { by: 1 }).await.is_err());
            assert_eq!(runtime.get_state().unwrap().n, 1);
            assert_eq!(runtime.gate(), demlik_tea::runtime::Gate::Open);
            assert_eq!(
                &*log.borrow(),
                &[
                    "start:fragile:0",
                    "start:steady:0",
                    "start:removed:0",
                    "dispose:steady:0",
                    "dispose:removed:0",
                    "start:steady:1",
                ]
            );
            runtime.stop().await;
            assert_eq!(
                log.borrow()
                    .iter()
                    .filter(|line| line.as_str() == "dispose:fragile:0")
                    .count(),
                1
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn callback_failures_are_data_and_live_unsubscription_preserves_fanout_order() {
    tokio::task::LocalSet::new()
        .run_until(async {
            type Unsubscribe = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;
            let log = Rc::new(RefCell::new(vec![]));
            let options: Options<Model, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            let runtime = launch(
                machine(),
                (),
                Effects(Rc::clone(&log)),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            let own: Unsubscribe = Rc::new(RefCell::new(None));
            let sibling: Unsubscribe = Rc::new(RefCell::new(None));
            let own_in = Rc::clone(&own);
            let sibling_in = Rc::clone(&sibling);
            let first_log = Rc::clone(&log);
            let nested_runtime = runtime.clone();
            *own.borrow_mut() = Some(runtime.subscribe(move || {
                first_log.borrow_mut().push("first".into());
                own_in.borrow_mut().take().unwrap()();
                sibling_in.borrow_mut().take().unwrap()();
                let added = Rc::clone(&first_log);
                let _unsubscribe = nested_runtime
                    .subscribe(move || added.borrow_mut().push("added-during-fanout".into()));
            }));
            let skipped_log = Rc::clone(&log);
            *sibling.borrow_mut() =
                Some(runtime.subscribe(move || {
                    skipped_log.borrow_mut().push("deleted-before-turn".into())
                }));
            let _bad = runtime.subscribe(|| panic!("listener defect"));
            let last_log = Rc::clone(&log);
            let _last = runtime.subscribe(move || last_log.borrow_mut().push("survivor".into()));
            let _bad_observer = runtime.observe(|_, _| panic!("observer defect"));
            let observer_log = Rc::clone(&log);
            let _observer = runtime.observe(move |_, state| {
                observer_log
                    .borrow_mut()
                    .push(format!("observe:{}", state.n))
            });
            let _late_boot = runtime.on_boot(|_| panic!("boot defect"));
            runtime.dispatch(Msg::Added { by: 1 }).await.unwrap();
            assert_eq!(
                &*log.borrow(),
                &["first", "survivor", "added-during-fanout", "observe:1"]
            );
            log.borrow_mut().clear();
            runtime.dispatch(Msg::Added { by: 1 }).await.unwrap();
            assert_eq!(
                &*log.borrow(),
                &["survivor", "added-during-fanout", "observe:2"]
            );
            assert_eq!(
                runtime
                    .reports()
                    .iter()
                    .map(|report| report.phase)
                    .collect::<Vec<_>>(),
                vec![
                    demlik_tea::runtime::ErrorPhase::Boot,
                    demlik_tea::runtime::ErrorPhase::Listener,
                    demlik_tea::runtime::ErrorPhase::Observer,
                    demlik_tea::runtime::ErrorPhase::Listener,
                    demlik_tea::runtime::ErrorPhase::Observer,
                ]
            );
            runtime.stop().await;
        })
        .await;
}
