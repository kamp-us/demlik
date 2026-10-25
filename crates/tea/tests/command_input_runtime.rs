use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    command::{
        CommandContractError, CommandEdge, CommandFamily, DecodedInput, EngineStamp, Outcome,
        Settled,
    },
    idempotency::intake::{self, ProcessInput, ReplayInput},
    persistence::snapshot::{
        SnapshotWriteCmd, SnapshotWriteInput, SnapshotWriteSpec, snapshot_write_def,
    },
    runtime::{self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile},
    work_queue::QueueField,
};
use std::{cell::Cell, convert::Infallible, rc::Rc};
struct Payload {
    visits: Cell<u32>,
    _capability: Box<dyn Fn()>,
}
struct ResultValue {
    visits: Cell<u32>,
    _capability: Box<dyn Fn()>,
}
struct Model {
    acks: u32,
    payload: Rc<Payload>,
    result: Rc<ResultValue>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Msg {
    Intake(intake::Msg<Payload, ResultValue>),
    Snapshot(Settled<SnapshotWriteSpec<Payload>>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Intake(v) => v.tag(),
            Self::Snapshot(v) => v.tag(),
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &[
        "intake:process_ok",
        "intake:process_err",
        "intake:replay_ok",
        "intake:replay_err",
        "snapshot_write_ok",
        "snapshot_write_err",
    ];
}
enum Cmd {
    Intake(intake::Cmd<Payload, ResultValue>),
    Snapshot(SnapshotWriteCmd<Payload>),
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Intake(v) => v.tag(),
            Self::Snapshot(v) => v.tag(),
        }
    }
}
enum Completion {
    Intake(Option<Outcome<PlainData, intake::TransportFailure>>),
    Snapshot(Option<Outcome<PlainData, demlik_tea::persistence::snapshot::SnapshotFailure>>),
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Completion;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Intake(v) => <intake::Cmd<Payload, ResultValue> as CommandFamily>::engine_stamp(v),
            Msg::Snapshot(v) => v.engine_stamp(),
        }
    }
    fn settle(self, c: Completion, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(c, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        c: Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match (self, c) {
            (Cmd::Intake(cmd), Completion::Intake(c)) => Ok(cmd
                .settle_in(c, edge)?
                .into_iter()
                .map(Msg::Intake)
                .collect()),
            (Cmd::Snapshot(cmd), Completion::Snapshot(c)) => Ok(cmd
                .settle_in(c, edge)?
                .into_iter()
                .map(Msg::Snapshot)
                .collect()),
            (cmd, _) => Err(CommandContractError::mismatched(
                cmd.tag(),
                "wrong test completion",
            )),
        }
    }
}
struct Host;
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Completion, Infallible>> {
        Some(CommandWork::new(async move {
            Ok(match cmd {
                Cmd::Intake(intake::Cmd::Process(cmd)) => {
                    cmd.input()
                        .payload
                        .visits
                        .set(cmd.input().payload.visits.get() + 1);
                    Completion::Intake(Some(Outcome::ok(PlainData::Undefined)))
                }
                Cmd::Intake(intake::Cmd::Replay(cmd)) => {
                    let QueueField::Value(v) = &cmd.input().result else {
                        panic!("typed result")
                    };
                    v.visits.set(v.visits.get() + 1);
                    Completion::Intake(Some(Outcome::ok(PlainData::Undefined)))
                }
                Cmd::Snapshot(cmd) => {
                    cmd.input()
                        .payload
                        .visits
                        .set(cmd.input().payload.visits.get() + 1);
                    Completion::Snapshot(Some(Outcome::ok(PlainData::Undefined)))
                }
            })
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn caller_decoded_opaque_payloads_cross_all_three_real_command_families_in_both_profiles() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let payload = Rc::new(Payload {
                    visits: Cell::new(0),
                    _capability: Box::new(|| {}),
                });
                let result = Rc::new(ResultValue {
                    visits: Cell::new(0),
                    _capability: Box::new(|| {}),
                });
                let p = Rc::clone(&payload);
                let r = Rc::clone(&result);
                let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
                    init: Box::new(move |_, _| {
                        let process = intake::intake_process_def()
                            .decode_input(Rc::clone(&p), |payload| {
                                Ok::<_, Infallible>(DecodedInput::new(ProcessInput {
                                    key: "k".into(),
                                    item_id: "i".into(),
                                    payload,
                                }))
                            })
                            .unwrap();
                        let replay = intake::intake_replay_def()
                            .decode_input(Rc::clone(&r), |result| {
                                Ok::<_, Infallible>(DecodedInput::new(ReplayInput {
                                    key: "k".into(),
                                    result: QueueField::Value(result),
                                }))
                            })
                            .unwrap();
                        let write = snapshot_write_def()
                            .decode_input(Rc::clone(&p), |payload| {
                                Ok::<_, Infallible>(DecodedInput::new(SnapshotWriteInput::new(
                                    "snapshot", 1.0, 17.25, payload,
                                )))
                            })
                            .unwrap();
                        Step::new(
                            Model {
                                acks: 0,
                                payload: Rc::clone(&p),
                                result: Rc::clone(&r),
                            },
                            vec![
                                Cmd::Intake(intake::Cmd::Process(process)),
                                Cmd::Intake(intake::Cmd::Replay(replay)),
                                Cmd::Snapshot(write),
                            ],
                        )
                    }),
                    update: Update::reducer(|state: &Model, msg: &Msg| {
                        match msg {
                            Msg::Intake(intake::Msg::Process(m)) => {
                                assert!(Rc::ptr_eq(&m.cmd().input().payload, &state.payload));
                                assert_eq!(m.at(), Some(17.25.into()));
                            }
                            Msg::Intake(intake::Msg::Replay(m)) => {
                                let QueueField::Value(v) = &m.cmd().input().result else {
                                    panic!("typed result")
                                };
                                assert!(Rc::ptr_eq(v, &state.result));
                                assert_eq!(m.at(), Some(17.25.into()));
                            }
                            Msg::Snapshot(m) => {
                                assert!(Rc::ptr_eq(&m.cmd().input().payload, &state.payload));
                                assert_eq!(m.at(), Some(17.25.into()));
                            }
                        }
                        Step::new(
                            Model {
                                acks: state.acks + 1,
                                payload: Rc::clone(&state.payload),
                                result: Rc::clone(&state.result),
                            },
                            vec![],
                        )
                    }),
                    subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
                };
                let mut options: Options<Model, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.clock = Rc::new(|| 17.25);
                let runtime = runtime::launch(machine, (), Host, NoSubscriptions::new(), options);
                runtime.ready().await.unwrap();
                runtime.idle().await.unwrap();
                let model = runtime.get_state().unwrap();
                assert_eq!(model.acks, 3);
                assert_eq!(payload.visits.get(), 2);
                assert_eq!(result.visits.get(), 1);
                assert!(Rc::ptr_eq(&model.payload, &payload));
                runtime.stop().await;
            }
        })
        .await;
}
