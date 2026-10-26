use demlik_tea::{
    Machine, Step, Sub, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    core::{Identity, Row},
    persistence::recorder::{RecorderOptions, recorder},
    runtime::{
        self, CommandContext, CommandWork, DriveError, DriveOptions, EffectScope, ErrorPhase,
        Interpreter, NoEvent, NoSubscriptions, Options, Persistence, Profile, RuntimeError,
        drive_to_done,
    },
    storage::{Migrated, Store},
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};
struct Cause(Cell<u32>);
struct Failure {
    original: Rc<Cause>,
}
struct Model {
    count: u32,
    original: Rc<Cause>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Msg {
    Accepted,
    Rejected,
    Panicked,
    Missing,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Panicked => "panicked",
            Self::Missing => "missing",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["accepted", "rejected", "panicked", "missing"];
}
struct Command;
impl Tagged for Command {
    fn tag(&self) -> &str {
        "performed"
    }
}
impl CommandFamily for Command {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}
struct Host(Rc<Cell<usize>>);
impl Interpreter<Command> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Command,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async move {
            self.0.set(self.0.get() + 1);
            Ok(vec![])
        }))
    }
}
struct Saved {
    calls: Rc<Cell<usize>>,
    values: Rc<RefCell<Vec<u32>>>,
}
impl Store<Model> for Saved {
    type Raw = ();
    type Error = Infallible;
    async fn load(&self) -> Result<(), Infallible> {
        Ok(())
    }
    async fn save(&self, state: &Model) -> Result<(), Infallible> {
        self.calls.set(self.calls.get() + 1);
        self.values.borrow_mut().push(state.count);
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<Model> {
        Migrated::Fresh
    }
}
fn accepted(state: &Model, _: &Msg) -> Step<Model, Command> {
    Step::new(
        Model {
            count: state.count + 1,
            original: Rc::clone(&state.original),
        },
        vec![Command],
    )
}
fn machine(
    original: Rc<Cause>,
    raw: bool,
) -> Machine<'static, Model, Msg, Command, Sub<()>, (), Failure> {
    let update = if raw {
        let cells: Row<'static, Model, Msg, Command> = Row::from([(
            "accepted".into(),
            Box::new(accepted) as demlik_tea::core::Cell<'static, Model, Msg, Command>,
        )]);
        TryUpdate::RawReducer(cells)
    } else {
        TryUpdate::try_reducer(|state: &Model, msg: &Msg| match msg {
            Msg::Accepted => Ok(accepted(state, msg)),
            Msg::Rejected | Msg::Missing => Err(Failure {
                original: Rc::clone(&state.original),
            }),
            Msg::Panicked => panic!("native reducer panic"),
        })
    };
    Machine {
        init: Box::new(move |_, _| {
            Step::new(
                Model {
                    count: 0,
                    original: Rc::clone(&original),
                },
                vec![],
            )
        }),
        update,
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_declared_owned_failure_is_reported_once_before_save_effects_and_observation_both_profiles()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let original = Rc::new(Cause(Cell::new(73)));
                let saves = Rc::new(Cell::new(0));
                let values = Rc::new(RefCell::new(vec![]));
                let effects = Rc::new(Cell::new(0));
                let sink_saves = Rc::clone(&saves);
                let sink_effects = Rc::clone(&effects);
                let sink_cause = Rc::clone(&original);
                let seen = Rc::new(Cell::new(0));
                let sink_seen = Rc::clone(&seen);
                let mut options: Options<Model, Msg, Infallible, Infallible, NoEvent, Failure> =
                    Options::new(profile);
                options.store = Some(Persistence::new(Saved {
                    calls: Rc::clone(&saves),
                    values: Rc::clone(&values),
                }));
                options.on_error = Some(Rc::new(move |error, phase| {
                    assert_eq!(phase, ErrorPhase::Reduce);
                    assert_eq!(sink_saves.get(), 2);
                    assert_eq!(sink_effects.get(), 1);
                    let RuntimeError::Reduce(failure) = error else {
                        panic!("declared failure changed category")
                    };
                    assert!(Rc::ptr_eq(&failure.original, &sink_cause));
                    sink_seen.set(sink_seen.get() + 1);
                }));
                let authored = machine(Rc::clone(&original), false).with_identity(Identity::new(
                    |_| demlik_tea::PlainData::Undefined,
                    |_| demlik_tea::PlainData::Undefined,
                ));
                let live = match profile {
                    Profile::Promise => runtime::try_launch(
                        authored,
                        (),
                        Host(Rc::clone(&effects)),
                        NoSubscriptions::new(),
                        options,
                    ),
                    Profile::Effect => {
                        runtime::try_run(
                            authored,
                            (),
                            Host(Rc::clone(&effects)),
                            NoSubscriptions::new(),
                            options,
                        )
                        .await
                    }
                };
                let record = recorder(&live, RecorderOptions::default());
                let scope = EffectScope::new();
                if profile == Profile::Effect {
                    scope.attach(&live).await.unwrap();
                }
                if live.ready().await.is_err() {
                    panic!("boot failed")
                }
                if live.dispatch(Msg::Accepted).await.is_err() {
                    panic!("valid transition failed")
                }
                let before = live.get_state().unwrap();
                assert_eq!(before.count, 1);
                assert_eq!(saves.get(), 2);
                assert_eq!(effects.get(), 1);
                let rejected = match live.dispatch_once(Msg::Rejected).await {
                    Err(error) => error,
                    Ok(()) => panic!("failure was swallowed"),
                };
                assert_eq!(rejected.name(), "ReduceError");
                let RuntimeError::Reduce(failure) = rejected.as_ref() else {
                    panic!("wrong declared category")
                };
                assert!(Rc::ptr_eq(&failure.original, &original));
                assert_eq!(failure.original.0.get(), 73);
                let reports = live.reports();
                assert_eq!(reports.len(), 1);
                assert_eq!(reports[0].phase, ErrorPhase::Reduce);
                assert!(Rc::ptr_eq(&rejected, &reports[0].error));
                assert_eq!(seen.get(), 1);
                assert!(Arc::ptr_eq(&before, &live.get_state().unwrap()));
                assert_eq!(&*values.borrow(), &[0, 1]);
                assert_eq!(effects.get(), 1);
                let trace = record.dump().unwrap();
                assert_eq!(trace.msgs.len(), 1);
                assert!(Arc::ptr_eq(&trace.final_state, &before));
                record.stop();
                live.stop().await;
                if profile == Profile::Effect {
                    scope.close().await;
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn no_cell_native_panic_and_drive_failures_keep_their_distinct_public_categories() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for raw in [true, false] {
                    let cause = Rc::new(Cause(Cell::new(1)));
                    let mut options: Options<Model, Msg, Infallible, Infallible, NoEvent, Failure> =
                        Options::new(profile);
                    options.on_error = Some(Rc::new(|_, _| {}));
                    let live = runtime::try_launch(
                        machine(cause, raw),
                        (),
                        Host(Rc::new(Cell::new(0))),
                        NoSubscriptions::new(),
                        options,
                    );
                    if live.ready().await.is_err() {
                        panic!("boot")
                    }
                    let error = match live
                        .dispatch_once(if raw { Msg::Missing } else { Msg::Panicked })
                        .await
                    {
                        Err(error) => error,
                        Ok(()) => panic!("failure expected"),
                    };
                    if raw {
                        assert!(matches!(error.as_ref(), RuntimeError::NoCell(_)));
                        assert_eq!(error.name(), "NoCellError");
                        assert!(live.reports().is_empty());
                        assert_eq!(live.gate(), runtime::Gate::Open);
                    } else {
                        let RuntimeError::Panic(cause) = error.as_ref() else {
                            panic!("panic became declared error")
                        };
                        assert_eq!(cause.summary, "native reducer panic");
                        assert_eq!(live.reports()[0].phase, ErrorPhase::Reduce);
                    }
                    live.stop().await;
                }
                let cause = Rc::new(Cause(Cell::new(9)));
                let mut options: Options<Model, Msg, Infallible, Infallible, NoEvent, Failure> =
                    Options::new(profile);
                options.on_error = Some(Rc::new(|_, _| {}));
                let live = runtime::try_launch(
                    machine(Rc::clone(&cause), false),
                    (),
                    Host(Rc::new(Cell::new(0))),
                    NoSubscriptions::new(),
                    options,
                );
                let error =
                    match drive_to_done(&live, Msg::Rejected, |_| false, DriveOptions::default())
                        .await
                    {
                        Err(DriveError::Runtime(error)) => error,
                        _ => panic!("driver must retain runtime failure"),
                    };
                let RuntimeError::Reduce(failure) = error.as_ref() else {
                    panic!("driver erased cause")
                };
                assert!(Rc::ptr_eq(&failure.original, &cause));
                assert!(Rc::ptr_eq(&error, &live.reports()[0].error));
            }
        })
        .await;
}
