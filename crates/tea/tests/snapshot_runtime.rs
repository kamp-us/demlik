use demlik_tea::command::{
    CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Outcome, Settled,
    Settlement,
};
use demlik_tea::core::Message;
use demlik_tea::persistence::snapshot::{
    self as snapshot, Snapshot, SnapshotConfig, SnapshotFailure, SnapshotLoadCmd, SnapshotLoadSpec,
    SnapshotState, SnapshotWriteCmd, SnapshotWriteSpec,
};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile,
};
use demlik_tea::storage::{MemoryStore, Store, memory_store};
use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update};
use serde_json::{Value, json};
use std::{cell::RefCell, convert::Infallible, rc::Rc};

struct Payload {
    position: u32,
    _local: Rc<()>,
}
enum Msg {
    Progress(f64),
    Write(Settled<SnapshotWriteSpec<Payload>>),
    Load(Settled<SnapshotLoadSpec<Payload>>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Progress(_) => "progress",
            Self::Write(msg) => msg.tag(),
            Self::Load(msg) => msg.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &[
        "progress",
        "snapshot_write_ok",
        "snapshot_write_err",
        "snapshot_load_ok",
        "snapshot_load_err",
    ];
}
enum Cmd {
    Write(SnapshotWriteCmd<Payload>),
    Load(SnapshotLoadCmd<Payload>),
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Write(cmd) => cmd.tag(),
            Self::Load(cmd) => cmd.tag(),
        }
    }
}
enum Completed {
    Write(Completion<SnapshotWriteSpec<Payload>>),
    Load(Completion<SnapshotLoadSpec<Payload>>),
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Completed;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Write(msg) => msg.engine_stamp(),
            Msg::Load(msg) => msg.engine_stamp(),
            _ => None,
        }
    }
    fn settle(self, outcome: Completed, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(outcome, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        outcome: Completed,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, outcome) {
            (Self::Write(cmd), Completed::Write(outcome)) => Ok(cmd
                .settle_in(outcome, edge)?
                .into_iter()
                .map(Msg::Write)
                .collect()),
            (Self::Load(cmd), Completed::Load(outcome)) => Ok(cmd
                .settle_in(outcome, edge)?
                .into_iter()
                .map(Msg::Load)
                .collect()),
            (cmd, _) => Err(CommandContractError::mismatched(
                cmd.tag(),
                "wrong snapshot completion",
            )),
        }
    }
}
struct Model {
    position: u32,
    snap: Rc<SnapshotState>,
    loaded: Option<Rc<Payload>>,
    errors: Vec<Value>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
fn machine(read_on_init: bool) -> Machine<'static, Model, Msg, Cmd, Sub> {
    let knob: Rc<Snapshot<Payload>> = Rc::new(snapshot::create_snapshot(SnapshotConfig {
        every: 2.0,
        key: Some("run/cp".into()),
    }));
    let init = Rc::clone(&knob);
    Machine {
        init: Box::new(move |_, _| {
            let state = Model {
                position: 0,
                snap: init.init(),
                loaded: None,
                errors: vec![],
            };
            let commands = if read_on_init {
                init.request_load(&state.snap)
                    .commands
                    .into_iter()
                    .map(Cmd::Load)
                    .collect()
            } else {
                vec![]
            };
            Step::new(state, commands)
        }),
        update: Update::reducer(move |state: &Model, msg| {
            let mut next = Model {
                position: state.position,
                snap: Rc::clone(&state.snap),
                loaded: state.loaded.clone(),
                errors: state.errors.clone(),
            };
            let commands = match msg {
                Msg::Progress(at) => {
                    next.position += 1;
                    let step = knob.record(
                        &state.snap,
                        Rc::new(Payload {
                            position: next.position,
                            _local: Rc::new(()),
                        }),
                        *at,
                    );
                    next.snap = step.state;
                    step.commands.into_iter().map(Cmd::Write).collect()
                }
                Msg::Write(msg) => {
                    match msg.outcome() {
                        Settlement::Ok(_) => next.snap = knob.confirm(&state.snap, msg).state,
                        Settlement::Err(error) => {
                            next.errors.push(serde_json::to_value(error).unwrap())
                        }
                    };
                    vec![]
                }
                Msg::Load(msg) => {
                    match msg.outcome() {
                        Settlement::Ok(payload) => {
                            next.loaded = payload.clone();
                            if let Some(payload) = payload {
                                next.position = payload.position;
                            }
                        }
                        Settlement::Err(error) => {
                            next.errors.push(serde_json::to_value(error).unwrap())
                        }
                    };
                    vec![]
                }
            };
            Step::new(next, commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
#[derive(Clone, Copy)]
enum Mode {
    Saved,
    DeclaredFailure,
    Malformed,
    Defect,
    ReadFailure,
}
struct Host {
    store: MemoryStore<Rc<Payload>>,
    mode: Mode,
}
impl Interpreter<Cmd> for Host {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Completed, Self::Error>> {
        Some(CommandWork::new(async move {
            match cmd {
                Cmd::Write(cmd) => {
                    assert_eq!(cmd.input().key.as_utf8(), Some("run/cp"));
                    match self.mode {
                        Mode::Defect => Err("unexpected put defect"),
                        Mode::DeclaredFailure => Ok(Completed::Write(Some(Outcome::err(
                            SnapshotFailure(PlainData::from(
                                &json!({"_tag":"snapshot_write_failed","code":"disk_full"}),
                            )),
                        )))),
                        _ => {
                            self.store
                                .save(&cmd.input().payload)
                                .await
                                .map_err(|_| "put failed")?;
                            Ok(Completed::Write(Some(Outcome::ok(
                                if matches!(self.mode, Mode::Malformed) {
                                    PlainData::Null
                                } else {
                                    PlainData::Undefined
                                },
                            ))))
                        }
                    }
                }
                Cmd::Load(cmd) => {
                    assert_eq!(cmd.input().key.as_utf8(), Some("run/cp"));
                    if matches!(self.mode, Mode::ReadFailure) {
                        return Ok(Completed::Load(Some(Outcome::err(SnapshotFailure(
                            PlainData::from(
                                &json!({"_tag":"snapshot_load_failed","code":"unavailable"}),
                            ),
                        )))));
                    }
                    Ok(Completed::Load(Some(Outcome::ok(
                        self.store.load().await.map_err(|_| "get failed")?,
                    ))))
                }
            }
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn real_snapshot_commands_write_acknowledge_and_recover_through_the_store_adapter() {
    tokio::task::LocalSet::new().run_until(async {
        for profile in [Profile::Promise, Profile::Effect] {
            for mode in [Mode::Saved, Mode::DeclaredFailure, Mode::Malformed, Mode::Defect] {
                let store = memory_store(None);
                let defects = Rc::new(RefCell::new(vec![])); let sink = Rc::clone(&defects);
                let mut options: Options<Model, Msg, Infallible, &'static str> = Options::new(profile);
                options.clock = Rc::new(|| 77.25);
                options.on_error = Some(Rc::new(move |error, phase| sink.borrow_mut().push((error.name(), phase))));
                let runtime = runtime::launch(machine(false), (), Host { store: store.clone(), mode }, NoSubscriptions::new(), options);
                runtime.ready().await.unwrap();
                runtime.dispatch(Msg::Progress(10.0)).await.unwrap();
                assert!(store.load().await.unwrap().is_none());
                runtime.dispatch(Msg::Progress(20.0)).await.unwrap();
                let state = runtime.get_state().unwrap();
                assert_eq!(state.position, 2);
                assert_eq!(state.snap.last_saved_seq, if matches!(mode, Mode::Saved) { Some(1.0) } else { None });
                assert_eq!(state.snap.last_saved_at, if matches!(mode, Mode::Saved) { Some(20.0) } else { None });
                match mode {
                    Mode::DeclaredFailure => assert_eq!(state.errors, vec![json!({"_tag":"snapshot_write_failed","code":"disk_full"})]),
                    Mode::Malformed => assert_eq!(state.errors, vec![json!({"_tag":"malformed_result","issues":[{"path":"","message":"expected no value"}]})]),
                    _ => assert!(state.errors.is_empty()),
                }
                assert_eq!(defects.borrow().len(), usize::from(matches!(mode, Mode::Defect)));
                runtime.stop().await;
                let saved = store.load().await.unwrap();
                let restored = runtime::launch(machine(true), (), Host { store, mode: Mode::Saved }, NoSubscriptions::new(), Options::<Model, Msg, Infallible, &'static str>::new(profile));
                restored.ready().await.unwrap(); restored.idle().await.unwrap();
                let state = restored.get_state().unwrap();
                assert_eq!(state.position, if saved.is_some() { 2 } else { 0 });
                assert_eq!(state.loaded.is_some(), saved.is_some());
                if let Some(saved) = saved { assert!(Rc::ptr_eq(state.loaded.as_ref().unwrap(), &saved)); }
                restored.stop().await;
            }
        }
    }).await;
}
#[tokio::test(flavor = "current_thread")]
async fn a_declared_read_failure_is_distinct_from_an_empty_checkpoint() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let runtime = runtime::launch(
                    machine(true),
                    (),
                    Host {
                        store: memory_store(None),
                        mode: Mode::ReadFailure,
                    },
                    NoSubscriptions::new(),
                    Options::<Model, Msg, Infallible, &'static str>::new(profile),
                );
                runtime.ready().await.unwrap();
                runtime.idle().await.unwrap();
                let state = runtime.get_state().unwrap();
                assert!(state.loaded.is_none());
                assert_eq!(state.position, 0);
                assert_eq!(
                    state.errors,
                    vec![json!({"_tag":"snapshot_load_failed","code":"unavailable"})]
                );
                runtime.stop().await;
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_monitored_pipeline_resumes_its_saved_stage_and_confirms_the_final_checkpoint() {
    use demlik_tea::flow::monitored_run::{
        MonitoredRun, MonitoredRunConfig, MonitoredRunState, RunPhase, StageResult,
    };
    use demlik_tea::runtime::Persistence;
    use demlik_tea::storage::MemoryStoreError;
    struct Stage {
        name: &'static str,
        _local: Rc<()>,
    }
    #[derive(Clone)]
    struct RunModel {
        run: Rc<MonitoredRunState<Stage>>,
    }
    impl Tagged for RunModel {
        fn tag(&self) -> &str {
            "model"
        }
    }
    fn run_machine() -> Machine<'static, RunModel, Msg, Cmd, Sub> {
        let run: Rc<MonitoredRun<Stage, Payload>> =
            Rc::new(MonitoredRun::new(MonitoredRunConfig {
                stages: vec![
                    Rc::new(Stage {
                        name: "first",
                        _local: Rc::new(()),
                    }),
                    Rc::new(Stage {
                        name: "last",
                        _local: Rc::new(()),
                    }),
                ],
                snapshot_every: Some(1.0),
                snapshot_key: Some("run/cp".into()),
                ..Default::default()
            }));
        let init = Rc::clone(&run);
        Machine {
            init: Box::new(move |loaded: Option<RunModel>, _| {
                let step = match loaded {
                    Some(model) => init.boot(&model.run, 1000.0),
                    None => init.start(&init.init(), "pipeline", 10.0),
                };
                Step::new(
                    RunModel { run: step.state },
                    step.commands.into_iter().map(Cmd::Write).collect(),
                )
            }),
            update: Update::reducer(move |state: &RunModel, msg| match msg {
                Msg::Progress(at) => {
                    let payload = Rc::new(Payload {
                        position: (state.run.progress_seq.number().unwrap_or(0.0) + 1.0) as u32,
                        _local: Rc::new(()),
                    });
                    let step = run.advance(&state.run, payload, StageResult::Ok, *at);
                    Step::new(
                        RunModel { run: step.state },
                        step.commands.into_iter().map(Cmd::Write).collect(),
                    )
                }
                Msg::Write(msg) => Step::new(
                    RunModel {
                        run: if matches!(msg.outcome(), Settlement::Ok(_)) {
                            run.confirm_snapshot(&state.run, msg)
                        } else {
                            Rc::clone(&state.run)
                        },
                    },
                    vec![],
                ),
                Msg::Load(_) => Step::new(
                    RunModel {
                        run: Rc::clone(&state.run),
                    },
                    vec![],
                ),
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        }
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let state_store = memory_store(None);
                let checkpoint_store = memory_store(None);
                let options = || {
                    let mut options: Options<RunModel, Msg, MemoryStoreError, &'static str> =
                        Options::new(profile);
                    options.store = Some(Persistence::new(state_store.clone()));
                    options.clock = Rc::new(|| 77.25);
                    options.terminal = Some(Rc::new(|state| {
                        matches!(state.run.phase, RunPhase::Done { .. })
                    }));
                    options
                };
                let first = runtime::launch(
                    run_machine(),
                    (),
                    Host {
                        store: checkpoint_store.clone(),
                        mode: Mode::Saved,
                    },
                    NoSubscriptions::new(),
                    options(),
                );
                first.ready().await.unwrap();
                first.dispatch(Msg::Progress(20.0)).await.unwrap();
                let first_state = first.get_state().unwrap();
                let last_stage = Rc::clone(&first_state.run.step_states.get(0).unwrap().input);
                assert_eq!(last_stage.name, "last");
                assert_eq!(first_state.run.snapshot.last_saved_seq, Some(1.0));
                assert_eq!(checkpoint_store.load().await.unwrap().unwrap().position, 1);
                first.stop().await;
                let restored = runtime::launch(
                    run_machine(),
                    (),
                    Host {
                        store: checkpoint_store.clone(),
                        mode: Mode::Saved,
                    },
                    NoSubscriptions::new(),
                    options(),
                );
                restored.ready().await.unwrap();
                let state = restored.get_state().unwrap();
                assert_eq!(state.run.started_at.number(), Some(10.0));
                assert_eq!(state.run.last_progress_at.number(), Some(1000.0));
                assert_eq!(state.run.progress_seq.number(), Some(2.0));
                assert_eq!(state.run.step_states.len(), 1);
                assert!(Rc::ptr_eq(
                    &state.run.step_states.get(0).unwrap().input,
                    &last_stage
                ));
                assert_eq!(state.run.snapshot.last_saved_seq, Some(1.0));
                restored.dispatch(Msg::Progress(1010.0)).await.unwrap();
                let state = restored.get_state().unwrap();
                assert!(matches!(state.run.phase, RunPhase::Done { .. }));
                assert!(state.run.step_states.is_empty());
                assert_eq!(state.run.snapshot.last_saved_seq, Some(2.0));
                assert_eq!(state.run.snapshot.last_saved_at, Some(1010.0));
                assert_eq!(checkpoint_store.load().await.unwrap().unwrap().position, 3);
                restored.stop().await;
                let saved = state_store.load().await.unwrap().unwrap();
                assert!(matches!(saved.run.phase, RunPhase::Done { .. }));
                assert_eq!(saved.run.snapshot.last_saved_seq, Some(2.0));
            }
        })
        .await;
}
