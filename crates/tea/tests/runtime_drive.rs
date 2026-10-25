use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, DriveCancellation, DriveError, DriveOptions, DriveSignal,
    DriveStart, Interpreter, Options, Profile, Runtime, SubscriptionWork, Subscriptions,
    drive_to_done, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};
messages! {enum Msg{Start,Advance,Fail,Cancel,Crash}}
#[derive(Debug)]
struct State {
    phase: &'static str,
    n: u32,
    local: Rc<()>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        self.phase
    }
}
enum Cmd {
    Next,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "next"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, value: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(value)
    }
}
struct Handler;
impl Interpreter<Cmd> for Handler {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async { Ok(vec![Msg::Advance]) }))
    }
}
struct Sources {
    live: bool,
    producer: Rc<RefCell<Option<demlik_tea::runtime::Producer<Msg>>>>,
    closed: Rc<Cell<bool>>,
}
impl Subscriptions<Sub, Msg> for Sources {
    type Error = Infallible;
    fn start(
        &self,
        _: Sub,
        producer: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Infallible>>, Infallible> {
        assert!(self.live);
        *self.producer.borrow_mut() = Some(producer);
        let closed = Rc::clone(&self.closed);
        Ok(Some(SubscriptionWork::new(move || async move {
            closed.set(true);
            Ok(())
        })))
    }
}
type Run = Runtime<State, Msg, Infallible, Infallible>;
type ProbedRun = (
    Run,
    Rc<RefCell<Option<demlik_tea::runtime::Producer<Msg>>>>,
    Rc<Cell<bool>>,
);
fn boot(profile: Profile, phase: &'static str, follow: bool, live: bool) -> ProbedRun {
    boot_with_store(profile, phase, follow, live, None)
}
fn boot_with_store(
    profile: Profile,
    phase: &'static str,
    follow: bool,
    live: bool,
    store: Option<demlik_tea::runtime::Persistence<State, Infallible>>,
) -> ProbedRun {
    let producer = Rc::new(RefCell::new(None));
    let closed = Rc::new(Cell::new(false));
    let machine = Machine {
        init: Box::new(move |loaded: Option<State>, _| {
            Step::new(
                loaded.unwrap_or_else(|| State {
                    phase,
                    n: 0,
                    local: Rc::new(()),
                }),
                vec![],
            )
        }),
        update: Update::reducer(move |s: &State, msg: &Msg| {
            let n = s.n + 1;
            let (phase, cmds) = match msg {
                Msg::Start => ("running", if follow { vec![Cmd::Next] } else { vec![] }),
                Msg::Advance => {
                    if n >= 3 {
                        ("done", vec![])
                    } else {
                        ("running", vec![Cmd::Next])
                    }
                }
                Msg::Fail => ("failed", vec![]),
                Msg::Cancel => ("cancelled", vec![]),
                Msg::Crash => panic!("cancel reducer failed"),
            };
            Step::new(
                State {
                    phase,
                    n,
                    local: Rc::clone(&s.local),
                },
                cmds,
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(move |s: &State| {
            if live && matches!(s.phase, "idle" | "running") {
                vec![Sub::new("live", serde_json::json!({})).unwrap()]
            } else {
                vec![]
            }
        }),
    };
    let mut options: Options<State, Msg, Infallible, Infallible> = Options::new(profile);
    options.store = store;
    (
        launch(
            machine,
            (),
            Handler,
            Sources {
                live,
                producer: Rc::clone(&producer),
                closed: Rc::clone(&closed),
            },
            options,
        ),
        producer,
        closed,
    )
}
fn terminal(s: &State) -> bool {
    matches!(s.phase, "done" | "cancelled")
}
#[tokio::test(flavor = "current_thread")]
async fn drive_follows_real_commands_preserves_terminal_boot_and_retains_failed_or_stalled_state() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let (runtime, _, _) = boot(profile, "idle", true, false);
                let state = drive_to_done(&runtime, Msg::Start, terminal, DriveOptions::default())
                    .await
                    .unwrap();
                assert_eq!((state.phase, state.n), ("done", 3));
                assert_eq!(runtime.gate(), demlik_tea::runtime::Gate::Closed);
                let (runtime, _, _) = boot(profile, "done", false, false);
                let starts = Rc::new(Cell::new(0));
                let counter = Rc::clone(&starts);
                let signal = DriveSignal::new();
                signal.abort();
                let options = DriveOptions {
                    failed: None,
                    cancellation: Some(DriveCancellation::new(signal, |_: &State| Msg::Cancel)),
                };
                let state = drive_to_done(
                    &runtime,
                    DriveStart::select(move |_: &State| {
                        counter.set(counter.get() + 1);
                        Msg::Start
                    }),
                    terminal,
                    options,
                )
                .await
                .unwrap();
                assert_eq!(state.phase, "done");
                assert_eq!(starts.get(), 0);
                let (runtime, _, _) = boot(profile, "idle", false, false);
                let error = drive_to_done(&runtime, Msg::Start, terminal, DriveOptions::default())
                    .await
                    .unwrap_err();
                assert!(matches!(error,DriveError::Stalled{state} if state.phase=="running"));
                assert_eq!(runtime.gate(), demlik_tea::runtime::Gate::Closed);
                let (runtime, _, _) = boot(profile, "idle", false, false);
                let options = DriveOptions {
                    failed: Some(Rc::new(|s: &State| s.phase == "failed")),
                    cancellation: None,
                };
                let error = drive_to_done(&runtime, Msg::Fail, terminal, options)
                    .await
                    .unwrap_err();
                assert!(matches!(error,DriveError::Failed{state} if state.phase=="failed"));
                assert_eq!(runtime.gate(), demlik_tea::runtime::Gate::Closed);
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn live_subscription_prevents_false_stall_and_cancellation_lands_a_terminal_model() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let (runtime, producer, closed) = boot(profile, "idle", false, true);
                let mut task = Box::pin(drive_to_done(
                    &runtime,
                    Msg::Start,
                    terminal,
                    DriveOptions::default(),
                ));
                assert!(futures::poll!(task.as_mut()).is_pending());
                for _ in 0..12 {
                    tokio::task::yield_now().await;
                }
                assert!(!closed.get());
                producer
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .emit(Msg::Advance)
                    .unwrap();
                let state = tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(state.phase, "done");
                assert!(closed.get());
                let (runtime, _, closed) = boot(profile, "idle", false, true);
                let signal = DriveSignal::new();
                let options = DriveOptions {
                    failed: None,
                    cancellation: Some(DriveCancellation::new(signal.clone(), |_: &State| {
                        Msg::Cancel
                    })),
                };
                let mut task = Box::pin(drive_to_done(&runtime, Msg::Start, terminal, options));
                assert!(futures::poll!(task.as_mut()).is_pending());
                for _ in 0..10 {
                    tokio::task::yield_now().await;
                }
                signal.abort();
                let state = tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(state.phase, "cancelled");
                assert!(closed.get());
                let (runtime, _, _) = boot(profile, "idle", false, false);
                let signal = DriveSignal::new();
                signal.abort();
                let options = DriveOptions {
                    failed: None,
                    cancellation: Some(DriveCancellation::new(signal, |_: &State| Msg::Cancel)),
                };
                let state = drive_to_done(
                    &runtime,
                    DriveStart::select(|_: &State| {
                        panic!("pre-aborted drive must not select start")
                    }),
                    terminal,
                    options,
                )
                .await
                .unwrap();
                assert_eq!((state.phase, state.n), ("cancelled", 1));
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn cancel_selector_or_fold_failure_rejects_instead_of_hanging_and_tears_down() {
    tokio::task::LocalSet::new().run_until(async{for selector_panics in [true,false]{let(runtime,_,closed)=boot(Profile::Promise,"idle",false,true);let signal=DriveSignal::new();let options=DriveOptions{failed:None,cancellation:Some(DriveCancellation::new(signal.clone(),move|_:&State|if selector_panics{panic!("cancel selector failed")}else{Msg::Crash}))};let mut task=Box::pin(drive_to_done(&runtime,Msg::Start,terminal,options));assert!(futures::poll!(task.as_mut()).is_pending());for _ in 0..12{tokio::task::yield_now().await;}signal.abort();let error=tokio::time::timeout(Duration::from_secs(1),task).await.unwrap().unwrap_err();if selector_panics{assert!(matches!(error,DriveError::Panic(cause) if cause.summary=="cancel selector failed"));}else{assert!(matches!(error,DriveError::Runtime(_)));}assert!(closed.get());}}).await;
}
#[tokio::test(flavor = "current_thread")]
async fn promise_drive_retains_work_after_waiter_drop_while_effect_construction_is_cold_and_drop_requests_teardown()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            let (runtime, producer, closed) = boot(Profile::Promise, "idle", false, true);
            let task = drive_to_done(&runtime, Msg::Start, terminal, DriveOptions::default());
            drop(task);
            for _ in 0..12 {
                tokio::task::yield_now().await;
            }
            assert!(!closed.get());
            assert_eq!(runtime.get_state().unwrap().phase, "running");
            producer
                .borrow()
                .as_ref()
                .unwrap()
                .emit(Msg::Advance)
                .unwrap();
            for _ in 0..32 {
                tokio::task::yield_now().await;
            }
            assert!(closed.get());
            assert_eq!(runtime.gate(), demlik_tea::runtime::Gate::Closed);
            let (runtime, _, closed) = boot(Profile::Effect, "idle", false, true);
            runtime.ready().await.unwrap();
            let selected = Rc::new(Cell::new(0));
            let counter = Rc::clone(&selected);
            let task = drive_to_done(
                &runtime,
                DriveStart::select(move |_: &State| {
                    counter.set(counter.get() + 1);
                    Msg::Start
                }),
                terminal,
                DriveOptions::default(),
            );
            assert_eq!(selected.get(), 0);
            drop(task);
            assert!(!closed.get());
            let mut task = Box::pin(drive_to_done(
                &runtime,
                Msg::Start,
                terminal,
                DriveOptions::default(),
            ));
            assert!(futures::poll!(task.as_mut()).is_pending());
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            drop(task);
            for _ in 0..24 {
                tokio::task::yield_now().await;
            }
            runtime.stop().await;
            assert!(closed.get());
        })
        .await;
}

type SavedModel = Option<(&'static str, u32)>;
struct Saved(Rc<RefCell<SavedModel>>);
impl demlik_tea::storage::Store<State> for Saved {
    type Raw = SavedModel;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Infallible> {
        Ok(*self.0.borrow())
    }
    async fn save(&self, state: &State) -> Result<(), Infallible> {
        *self.0.borrow_mut() = Some((state.phase, state.n));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> demlik_tea::storage::Migrated<State> {
        match raw {
            None => demlik_tea::storage::Migrated::Fresh,
            Some((phase, n)) => demlik_tea::storage::Migrated::State(State {
                phase,
                n,
                local: Rc::new(()),
            }),
        }
    }
}
#[tokio::test(flavor = "current_thread")]
async fn cancel_model_is_saved_and_reloaded_without_selecting_start() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let data = Rc::new(RefCell::new(None));
                let store = demlik_tea::runtime::Persistence::new(Saved(Rc::clone(&data)));
                let (runtime, _, _) =
                    boot_with_store(profile, "idle", false, false, Some(store.clone()));
                let signal = DriveSignal::new();
                signal.abort();
                let options = DriveOptions {
                    failed: None,
                    cancellation: Some(DriveCancellation::new(signal, |_: &State| Msg::Cancel)),
                };
                let state = drive_to_done(&runtime, Msg::Start, terminal, options)
                    .await
                    .unwrap();
                assert_eq!((state.phase, state.n), ("cancelled", 1));
                assert_eq!(*data.borrow(), Some(("cancelled", 1)));
                let (restored, _, _) = boot_with_store(profile, "idle", true, false, Some(store));
                let state = drive_to_done(
                    &restored,
                    DriveStart::select(|_: &State| {
                        panic!("a stored terminal cancellation has nothing to start")
                    }),
                    terminal,
                    DriveOptions::default(),
                )
                .await
                .unwrap();
                assert_eq!((state.phase, state.n), ("cancelled", 1));
                assert_eq!(*data.borrow(), Some(("cancelled", 1)));
            }
        })
        .await;
}
