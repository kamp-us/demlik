use demlik_tea::{
    Machine, Step, Sub, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    persistence::recorder::{RecorderOptions, recorder},
    runtime::{
        self, CommandContext, CommandWork, DriveCancellation, DriveError, DriveOptions,
        DriveSignal, DriveStart, EffectScope, ErrorPhase, Gate, Interpreter, NoEvent, Options,
        Persistence, Profile, Runtime, RuntimeError, ScopeExit, SubscriptionWork, Subscriptions,
        Supervision, drive_to_done,
    },
    storage::{Migrated, Store},
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;

struct Opaque(Cell<u32>);
struct ReducerFailure {
    original: Rc<Opaque>,
}
struct Model {
    n: u32,
    original: Rc<Opaque>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
demlik_tea::messages! { enum Msg { Add, Fail, Cancel } }
struct Cmd;
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "effect"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}
struct Host(Rc<Cell<usize>>);
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async move {
            self.0.set(self.0.get() + 1);
            Ok(vec![])
        }))
    }
}
struct Saved(Rc<RefCell<Vec<u32>>>);
impl Store<Model> for Saved {
    type Raw = ();
    type Error = Infallible;
    async fn load(&self) -> Result<(), Infallible> {
        Ok(())
    }
    async fn save(&self, state: &Model) -> Result<(), Infallible> {
        self.0.borrow_mut().push(state.n);
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<Model> {
        Migrated::Fresh
    }
}
struct Disposer {
    entered: Notify,
    release: Notify,
    closed: Cell<bool>,
    held: bool,
}
struct Sources(Rc<Disposer>);
impl Subscriptions<Sub<()>, Msg> for Sources {
    type Error = Infallible;
    fn start(
        &self,
        _: Sub<()>,
        _: runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Infallible>>, Infallible> {
        let owner = Rc::clone(&self.0);
        Ok(Some(SubscriptionWork::new(move || async move {
            owner.entered.notify_one();
            if owner.held {
                owner.release.notified().await;
            }
            owner.closed.set(true);
            Ok(())
        })))
    }
}
type Run = Runtime<Model, Msg, Infallible, Infallible, NoEvent, ReducerFailure>;
#[derive(Clone, Copy)]
enum Policy {
    Stop,
    Escalate,
    Restart,
}
struct Fixture {
    run: Run,
    cause: Rc<Opaque>,
    disposer: Rc<Disposer>,
    saved: Rc<RefCell<Vec<u32>>>,
    effects: Rc<Cell<usize>>,
}
fn reducing(state: &Model, message: &Msg) -> Result<Step<Model, Cmd>, ReducerFailure> {
    match message {
        Msg::Add => Ok(Step::new(
            Model {
                n: state.n + 1,
                original: Rc::clone(&state.original),
            },
            vec![Cmd],
        )),
        Msg::Fail | Msg::Cancel => Err(ReducerFailure {
            original: Rc::clone(&state.original),
        }),
    }
}
fn boot(profile: Profile, live_sub: bool, held: bool, policy: Policy) -> Fixture {
    let cause = Rc::new(Opaque(Cell::new(73)));
    let initial = Rc::clone(&cause);
    let disposer = Rc::new(Disposer {
        entered: Notify::new(),
        release: Notify::new(),
        closed: Cell::new(false),
        held,
    });
    let saved = Rc::new(RefCell::new(vec![]));
    let effects = Rc::new(Cell::new(0));
    let machine = Machine {
        init: Box::new(move |_, _| {
            Step::new(
                Model {
                    n: 0,
                    original: Rc::clone(&initial),
                },
                vec![],
            )
        }),
        update: TryUpdate::try_reducer(reducing),
        subscriptions: demlik_tea::core::subscriptions(move |_: &Model| {
            if live_sub {
                vec![Sub::new("source", ()).unwrap()]
            } else {
                vec![]
            }
        }),
    };
    let mut options: Options<Model, Msg, Infallible, Infallible, NoEvent, ReducerFailure> =
        Options::new(profile);
    options.store = Some(Persistence::new(Saved(Rc::clone(&saved))));
    options.on_error = Some(Rc::new(|_, _| {}));
    options.dispose_timeout = Duration::from_secs(3);
    options.supervision = match policy {
        Policy::Stop => Supervision::Stop,
        Policy::Escalate => Supervision::Escalate,
        Policy::Restart => Supervision::Restart(Rc::new(|s, m, e| {
            assert!(matches!(m, Msg::Fail | Msg::Cancel));
            let RuntimeError::Reduce(f) = e else {
                panic!("restart changed error category")
            };
            assert!(Rc::ptr_eq(&f.original, &s.original));
            Model {
                n: 42,
                original: Rc::clone(&s.original),
            }
        })),
    };
    let run = runtime::try_launch(
        machine,
        (),
        Host(Rc::clone(&effects)),
        Sources(Rc::clone(&disposer)),
        options,
    );
    Fixture {
        run,
        cause,
        disposer,
        saved,
        effects,
    }
}
fn original(error: &RuntimeError<Infallible, Infallible, ReducerFailure>, cause: &Rc<Opaque>) {
    let RuntimeError::Reduce(failure) = error else {
        panic!("typed failure was erased")
    };
    assert!(Rc::ptr_eq(&failure.original, cause));
    assert_eq!(failure.original.0.get(), 73);
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_failure_waits_for_disposer_before_settling_the_drive_both_profiles() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let f = boot(profile, true, true, Policy::Stop);
                assert!(f.run.ready().await.is_ok());
                let signal = DriveSignal::new();
                signal.abort();
                let mut drive = Box::pin(drive_to_done(
                    &f.run,
                    DriveStart::select(|_: &Model| {
                        panic!("pre-aborted start must stay unselected")
                    }),
                    |_| false,
                    DriveOptions {
                        failed: None,
                        cancellation: Some(DriveCancellation::new(signal, |_| Msg::Cancel)),
                    },
                ));
                assert!(futures::poll!(drive.as_mut()).is_pending());
                tokio::time::timeout(Duration::from_secs(1), f.disposer.entered.notified())
                    .await
                    .unwrap();
                assert!(!f.disposer.closed.get());
                assert!(
                    futures::poll!(drive.as_mut()).is_pending(),
                    "drive receipt escaped before cleanup"
                );
                assert_eq!(&*f.saved.borrow(), &[0]);
                assert_eq!(f.effects.get(), 0);
                let reports = f.run.reports();
                assert_eq!(reports.len(), 1);
                original(&reports[0].error, &f.cause);
                f.disposer.release.notify_one();
                let error = match drive.await {
                    Err(DriveError::Runtime(error)) => error,
                    _ => panic!("cancel failure must reject with its runtime cause"),
                };
                original(&error, &f.cause);
                assert!(Rc::ptr_eq(&error, &reports[0].error));
                assert!(f.disposer.closed.get());
                assert_eq!(f.run.gate(), Gate::Closed);
                assert_eq!(&*f.saved.borrow(), &[0, 0]);
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_dispatch_waiters_preserves_only_work_admitted_by_the_profile() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for polled in [false, true] {
                    let f = boot(profile, false, false, Policy::Escalate);
                    assert!(f.run.ready().await.is_ok());
                    let before = f.run.get_state().unwrap();
                    let mut receipt = Box::pin(f.run.dispatch_once(Msg::Fail));
                    if polled {
                        assert!(futures::poll!(receipt.as_mut()).is_pending())
                    }
                    drop(receipt);
                    assert!(f.run.idle().await.is_ok());
                    let admitted = profile == Profile::Promise || polled;
                    let reports = f.run.reports();
                    assert_eq!(
                        reports.len(),
                        usize::from(admitted),
                        "profile admission must own work after its waiter drops"
                    );
                    if admitted {
                        original(&reports[0].error, &f.cause)
                    }
                    assert!(Arc::ptr_eq(&before, &f.run.get_state().unwrap()));
                    assert_eq!(&*f.saved.borrow(), &[0]);
                    assert_eq!(f.effects.get(), 0);
                    assert!(f.run.dispatch(Msg::Add).await.is_ok());
                    assert_eq!(f.run.get_state().unwrap().n, 1);
                    assert_eq!(f.effects.get(), 1);
                    f.run.stop().await;
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn effect_scope_returns_the_original_typed_program_failure_after_awaited_cleanup() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let f = boot(Profile::Effect, true, true, Policy::Escalate);
            assert!(f.run.ready().await.is_ok());
            let scope = EffectScope::new();
            scope.attach(&f.run).await.unwrap();
            let run = f.run.clone();
            let mut task = Box::pin(scope.spawn(async move { run.dispatch(Msg::Fail).await }));
            tokio::time::timeout(Duration::from_secs(1), f.disposer.entered.notified())
                .await
                .unwrap();
            assert!(scope.is_closing());
            assert!(!scope.is_closed());
            assert!(!f.disposer.closed.get());
            assert!(
                futures::poll!(task.as_mut()).is_pending(),
                "scope receipt escaped before cleanup"
            );
            // A declared program Result is ScopeExit::Failure, not a fabricated Sub failure.
            assert!(scope.failure().is_none());
            f.disposer.release.notify_one();
            let error = match task.await {
                ScopeExit::Failure(error) => error,
                _ => panic!("scope erased its program failure"),
            };
            original(&error, &f.cause);
            assert!(Rc::ptr_eq(&error, &f.run.reports()[0].error));
            assert!(scope.is_closed());
            assert!(f.disposer.closed.get());
            assert_eq!(&*f.saved.borrow(), &[0, 0]);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn scope_failure_downcast_keeps_the_actual_runtime_allocation_with_a_typed_reducer_family() {
    struct FailedSource {
        release: Rc<Notify>,
        cause: Rc<str>,
    }
    impl Subscriptions<Sub<()>, Msg> for FailedSource {
        type Error = Rc<str>;
        fn start(
            &self,
            _: Sub<()>,
            _: runtime::Producer<Msg>,
        ) -> Result<Option<SubscriptionWork<Rc<str>>>, Rc<str>> {
            let release = Rc::clone(&self.release);
            let cause = Rc::clone(&self.cause);
            Ok(Some(
                SubscriptionWork::new(|| async { Ok(()) }).with_source(async move {
                    release.notified().await;
                    Err(cause)
                }),
            ))
        }
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            let cause = Rc::<str>::from("source-owner");
            let release = Rc::new(Notify::new());
            let initial = Rc::new(Opaque(Cell::new(73)));
            let machine: Machine<'static, Model, Msg, Cmd, Sub<()>, (), ReducerFailure> = Machine {
                init: Box::new(move |_, _| {
                    Step::new(
                        Model {
                            n: 0,
                            original: Rc::clone(&initial),
                        },
                        vec![],
                    )
                }),
                update: TryUpdate::try_reducer(reducing),
                subscriptions: demlik_tea::core::subscriptions(|_| {
                    vec![Sub::new("source", ()).unwrap()]
                }),
            };
            let mut options: Options<Model, Msg, Infallible, Rc<str>, NoEvent, ReducerFailure> =
                Options::new(Profile::Effect);
            options.on_error = Some(Rc::new(|_, _| {}));
            let run = runtime::try_run(
                machine,
                (),
                runtime::NoInterpreter::<Rc<str>>::new(),
                FailedSource {
                    release: Rc::clone(&release),
                    cause: Rc::clone(&cause),
                },
                options,
            )
            .await;
            assert!(run.ready().await.is_ok());
            let scope = EffectScope::new();
            scope.attach(&run).await.unwrap();
            let task = scope.spawn(futures::future::pending::<Result<(), Infallible>>());
            release.notify_one();
            let failure = match task.await {
                ScopeExit::RuntimeFailure(failure) => failure,
                _ => panic!("source failure must retain the actual typed runtime allocation"),
            };
            let typed = failure
                .downcast_ref::<RuntimeError<Infallible, Rc<str>, ReducerFailure>>()
                .expect("scope must retain the actual runtime error type");
            let RuntimeError::Handler(retained) = typed else {
                panic!("source cause changed category")
            };
            assert!(Rc::ptr_eq(retained, &cause));
            let reports = run.reports();
            let reported = reports
                .iter()
                .find(|report| report.phase == ErrorPhase::Sub)
                .unwrap();
            assert!(std::ptr::eq(typed, reported.error.as_ref()));
            assert!(scope.is_closed());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn producer_failures_report_reduce_before_follow_up_with_the_same_error_owner() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for policy in [Policy::Stop, Policy::Escalate, Policy::Restart] {
                    let f = boot(profile, false, false, policy);
                    assert!(f.run.ready().await.is_ok());
                    assert!(f.run.producer().emit(Msg::Fail).is_ok());
                    assert!(f.run.idle().await.is_ok());
                    let reports = f.run.reports();
                    assert_eq!(reports[0].phase, ErrorPhase::Reduce);
                    original(&reports[0].error, &f.cause);
                    if matches!(policy, Policy::Restart) {
                        assert_eq!(reports.len(), 1);
                        assert_eq!(f.run.get_state().unwrap().n, 42);
                        assert_eq!(&*f.saved.borrow(), &[0, 42])
                    } else {
                        assert_eq!(reports.len(), 2);
                        assert_eq!(reports[1].phase, ErrorPhase::FollowUp);
                        assert!(Rc::ptr_eq(&reports[0].error, &reports[1].error));
                        assert_eq!(&*f.saved.borrow(), &[0])
                    }
                    assert_eq!(f.effects.get(), 0);
                    let later = f.run.dispatch(Msg::Add).await;
                    assert_eq!(later.is_ok(), !matches!(policy, Policy::Stop));
                    f.run.stop().await;
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn retained_recording_replays_typed_updates_without_init_subscriptions_or_effects() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let f = boot(profile, false, false, Policy::Escalate);
                let record = recorder(
                    &f.run,
                    RecorderOptions {
                        capture_steps: true,
                        sample_rate: None,
                    },
                );
                assert!(f.run.ready().await.is_ok());
                assert!(f.run.dispatch(Msg::Add).await.is_ok());
                assert!(f.run.dispatch(Msg::Add).await.is_ok());
                let rejected = match f.run.dispatch(Msg::Fail).await {
                    Err(error) => error,
                    Ok(()) => panic!("failure swallowed"),
                };
                original(&rejected, &f.cause);
                assert!(f.run.dispatch(Msg::Add).await.is_ok());
                let trace = record.dump().unwrap();
                assert_eq!(trace.msgs.len(), 3);
                assert_eq!(trace.steps.as_ref().unwrap().len(), 3);
                assert_eq!(trace.final_state.n, 3);
                assert!(Arc::ptr_eq(&trace.final_state, &f.run.get_state().unwrap()));
                let init = Rc::new(Cell::new(0));
                let subs = Rc::new(Cell::new(0));
                let reductions = Rc::new(Cell::new(0));
                let init_calls = Rc::clone(&init);
                let sub_calls = Rc::clone(&subs);
                let update_calls = Rc::clone(&reductions);
                let pure: Machine<'_, Model, Msg, Cmd, Sub<()>, (), ReducerFailure> = Machine {
                    init: Box::new(move |_, _| {
                        init_calls.set(init_calls.get() + 1);
                        panic!("record replay initialized")
                    }),
                    update: TryUpdate::try_reducer(move |s, m| {
                        update_calls.set(update_calls.get() + 1);
                        reducing(s, m)
                    }),
                    subscriptions: demlik_tea::core::subscriptions(move |_| {
                        sub_calls.set(sub_calls.get() + 1);
                        panic!("record replay selected subscriptions")
                    }),
                };
                let seed = trace.loaded.as_ref().unwrap();
                let replayed = match demlik_tea::try_fold_updates_shared(
                    &pure.update,
                    Arc::clone(seed),
                    trace.msgs.iter().map(Arc::clone),
                ) {
                    Ok(step) => step,
                    Err(_) => panic!("record replay refused"),
                };
                assert_eq!(replayed.state.n, 3);
                assert_eq!(replayed.commands.len(), 3);
                assert!(Rc::ptr_eq(&replayed.state.original, &f.cause));
                let empty = match demlik_tea::try_fold_msgs_shared(&pure, Arc::clone(seed), []) {
                    Ok(state) => state,
                    Err(_) => panic!("empty record fold refused"),
                };
                assert!(Arc::ptr_eq(seed, &empty));
                assert_eq!(reductions.get(), 3);
                assert_eq!((init.get(), subs.get(), f.effects.get()), (0, 0, 3));
                record.stop();
                assert!(f.run.dispatch(Msg::Add).await.is_ok());
                assert!(Arc::ptr_eq(
                    &trace.final_state,
                    &record.dump().unwrap().final_state
                ));
                assert_eq!(record.dump().unwrap().msgs.len(), 3);
                f.run.stop().await;
            }
        })
        .await;
}
