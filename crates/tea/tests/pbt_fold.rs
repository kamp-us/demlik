#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The fold retains original Arc handles without Send bounds; opaque local models and messages prove that contract."
)]

use demlik_tea::{Machine, Step, Sub, Tagged, Update, core::Message, pbt::fold_events};
use std::{cell::Cell, rc::Rc, sync::Arc};
struct Payload {
    value: u32,
    _capability: Box<dyn Fn()>,
}
struct Model {
    n: u32,
    done: bool,
    payload: Rc<Payload>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        if self.done { "done" } else { "active" }
    }
}
enum Msg {
    Add(Rc<Payload>),
    Noop,
    Done,
    AfterDone(Rc<Payload>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add(_) => "add",
            Self::Noop => "noop",
            Self::Done => "done",
            Self::AfterDone(_) => "after_done",
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["add", "noop", "done", "after_done"];
}
struct Cmd {
    _payload: Rc<Payload>,
}
#[test]
fn trace_retains_original_opaque_handles_and_steps_past_terminal_state() {
    let payload = Rc::new(Payload {
        value: 3,
        _capability: Box::new(|| {}),
    });
    let loaded = Arc::new(Model {
        n: 4,
        done: false,
        payload: Rc::clone(&payload),
    });
    let input = Cell::new(0);
    let subs = Cell::new(0);
    let token = Rc::clone(&payload);
    let machine: Machine<'_, Arc<Model>, Msg, Cmd, Sub, Cell<u32>> = Machine {
        init: Box::new(move |saved, input| {
            input.set(input.get() + 1);
            Step::new(
                saved.unwrap(),
                vec![Cmd {
                    _payload: Rc::clone(&token),
                }],
            )
        }),
        update: Update::reducer(|s: &Arc<Model>, m| match m {
            Msg::Noop => Step::new(Arc::clone(s), vec![]),
            Msg::Done => Step::new(
                Arc::new(Model {
                    n: s.n,
                    done: true,
                    payload: Rc::clone(&s.payload),
                }),
                vec![],
            ),
            Msg::Add(p) | Msg::AfterDone(p) => Step::new(
                Arc::new(Model {
                    n: s.n + p.value,
                    done: s.done,
                    payload: Rc::clone(p),
                }),
                vec![Cmd {
                    _payload: Rc::clone(p),
                }],
            ),
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            subs.set(subs.get() + 1);
            vec![]
        }),
    };
    let messages = [
        Arc::new(Msg::Add(Rc::clone(&payload))),
        Arc::new(Msg::Noop),
        Arc::new(Msg::Done),
        Arc::new(Msg::AfterDone(Rc::clone(&payload))),
    ];
    let result = fold_events(
        &machine,
        &input,
        Some(Arc::clone(&loaded)),
        messages.iter().cloned(),
    )
    .unwrap();
    assert_eq!(input.get(), 1);
    assert_eq!(subs.get(), 1);
    assert_eq!(result.states.len(), 5);
    assert_eq!(result.steps.len(), 4);
    assert_eq!(result.final_state.n, 10);
    assert!(result.final_state.done);
    assert!(Arc::ptr_eq(result.states[0].as_ref(), &loaded));
    for (i, step) in result.steps.iter().enumerate() {
        assert!(Arc::ptr_eq(&step.prev, &result.states[i]));
        assert!(Arc::ptr_eq(&step.next, &result.states[i + 1]));
        assert!(Arc::ptr_eq(&step.msg, &messages[i]));
    }
    assert!(Arc::ptr_eq(
        &result.final_state,
        result.states.last().unwrap()
    ));
    assert!(
        Arc::ptr_eq(result.steps[1].prev.as_ref(), result.steps[1].next.as_ref()),
        "caller-chosen shared model identity is retained"
    );
    assert!(
        !Arc::ptr_eq(&result.steps[1].prev, &result.steps[1].next),
        "trace bookkeeping Arc wrappers are independent of inner model identity"
    );
    assert_eq!(
        result
            .steps
            .iter()
            .map(|s| s.commands.len())
            .collect::<Vec<_>>(),
        vec![1, 0, 0, 1]
    );
    assert!(Rc::ptr_eq(&result.steps[0].commands[0]._payload, &payload));
}
#[test]
fn empty_fold_boots_once_transforms_loaded_state_and_excludes_resume_commands() {
    let init = Cell::new(0);
    let subs = Cell::new(0);
    let token = Rc::new(Payload {
        value: 3,
        _capability: Box::new(|| {}),
    });
    let p = Rc::clone(&token);
    let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|saved, _| {
            init.set(init.get() + 1);
            let old: Model = saved.unwrap();
            Step::new(
                Model {
                    n: old.n + 10,
                    ..old
                },
                vec![Cmd {
                    _payload: Rc::clone(&p),
                }],
            )
        }),
        update: Update::reducer(|_: &Model, _| panic!("no update")),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            subs.set(subs.get() + 1);
            vec![]
        }),
    };
    let trace = fold_events(
        &machine,
        &(),
        Some(Model {
            n: 4,
            done: false,
            payload: token,
        }),
        [],
    )
    .unwrap();
    assert_eq!(trace.final_state.n, 14);
    assert_eq!(trace.states.len(), 1);
    assert!(trace.steps.is_empty());
    assert!(Arc::ptr_eq(&trace.final_state, &trace.states[0]));
    assert_eq!(init.get(), 1);
    assert_eq!(subs.get(), 1);
}
#[test]
fn missing_cells_keep_the_existing_refusal_data() {
    let p = Rc::new(Payload {
        value: 1,
        _capability: Box::new(|| {}),
    });
    let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|saved, _| Step::new(saved.unwrap(), vec![])),
        update: Update::RawReducer(Default::default()),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let error = fold_events(
        &machine,
        &(),
        Some(Model {
            n: 0,
            done: false,
            payload: p,
        }),
        [Arc::new(Msg::Done)],
    )
    .err()
    .unwrap();
    assert_eq!(error.msg_type, "done");
    assert_eq!(error.state_name, "active");
    assert!(error.accepted_types.is_empty());
}

#[test]
fn init_subscription_and_update_panics_keep_the_original_payload() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    struct Failure {
        note: &'static str,
    }
    for phase in ["init", "subs", "update"] {
        let cause = Arc::new(Failure { note: phase });
        let init = Arc::clone(&cause);
        let update = Arc::clone(&cause);
        let subs = Arc::clone(&cause);
        let p = Rc::new(Payload {
            value: 1,
            _capability: Box::new(|| {}),
        });
        let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
            init: Box::new(move |saved, _| {
                if phase == "init" {
                    std::panic::panic_any(Arc::clone(&init));
                }
                Step::new(saved.unwrap(), vec![])
            }),
            update: Update::reducer(move |_: &Model, _| {
                if phase == "update" {
                    std::panic::panic_any(Arc::clone(&update));
                }
                panic!("unreachable update")
            }),
            subscriptions: demlik_tea::core::subscriptions(move |_| {
                if phase == "subs" {
                    std::panic::panic_any(Arc::clone(&subs));
                }
                vec![]
            }),
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            fold_events(
                &machine,
                &(),
                Some(Model {
                    n: 0,
                    done: false,
                    payload: p,
                }),
                [Arc::new(Msg::Noop)],
            )
        }));
        let payload = outcome.err().unwrap();
        let actual = payload.downcast_ref::<Arc<Failure>>().unwrap();
        assert!(Arc::ptr_eq(actual, &cause));
        assert_eq!(actual.note, phase);
    }
}

#[test]
fn opaque_intake_history_retains_payload_results_and_done_before_crash_guards() {
    use demlik_tea::idempotency::intake::{
        self, Config, Intake, IntakeValue, State as IntakeState,
    };
    struct Receipt {
        _capability: Box<dyn Fn()>,
    }
    struct IntakeModel(Rc<IntakeState<Payload, Receipt>>);
    impl Tagged for IntakeModel {
        fn tag(&self) -> &str {
            "intake"
        }
    }
    enum Event {
        Receive {
            payload: Rc<Payload>,
            id: &'static str,
        },
        Claim,
        Complete(Rc<Receipt>),
        Boot,
    }
    impl Tagged for Event {
        fn tag(&self) -> &str {
            match self {
                Self::Receive { .. } => "receive",
                Self::Claim => "claim",
                Self::Complete(_) => "complete",
                Self::Boot => "boot",
            }
        }
    }
    impl Message for Event {
        const TYPES: &'static [&'static str] = &["receive", "claim", "complete", "boot"];
    }
    let a = Rc::new(Payload {
        value: 1,
        _capability: Box::new(|| {}),
    });
    let b = Rc::new(Payload {
        value: 2,
        _capability: Box::new(|| {}),
    });
    let result = Rc::new(Receipt {
        _capability: Box::new(|| {}),
    });
    let intake = Rc::new(Intake::<Payload, Receipt>::new(Config::new(
        |p: &Payload| Ok(format!("key{}", p.value).into()),
    )));
    let boot = Rc::clone(&intake);
    let machine: Machine<'_, IntakeModel, Event, intake::Cmd<Payload, Receipt>, Sub> = Machine {
        init: Box::new(move |loaded, _| {
            Step::new(loaded.unwrap_or_else(|| IntakeModel(boot.init())), vec![])
        }),
        update: Update::reducer(move |s: &IntakeModel, m| {
            let t = match m {
                Event::Receive { payload, id } => {
                    intake.receive(&s.0, Rc::clone(payload), 0.0, *id).unwrap()
                }
                Event::Claim => Step::new(
                    intake
                        .claim_next(&s.0, 0.0)
                        .unwrap()
                        .map_or_else(|| Rc::clone(&s.0), |c| c.state),
                    vec![],
                ),
                Event::Complete(r) => intake
                    .complete(&s.0, "key1", IntakeValue::Value(Rc::clone(r)), 1.0)
                    .unwrap(),
                Event::Boot => intake.boot(&s.0).unwrap(),
            };
            Step::new(IntakeModel(t.state), t.commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let msgs = [
        Event::Receive {
            payload: Rc::clone(&a),
            id: "q1",
        },
        Event::Claim,
        Event::Complete(Rc::clone(&result)),
        Event::Boot,
        Event::Receive {
            payload: Rc::clone(&a),
            id: "q2",
        },
        Event::Receive {
            payload: Rc::clone(&b),
            id: "q3",
        },
        Event::Claim,
        Event::Receive {
            payload: Rc::clone(&b),
            id: "q4",
        },
    ]
    .map(Arc::new);
    let trace = fold_events(&machine, &(), None, msgs.iter().cloned()).unwrap();
    assert_eq!(trace.states.len(), 9);
    assert_eq!(
        trace
            .steps
            .iter()
            .map(|s| s.commands.len())
            .collect::<Vec<_>>(),
        vec![1, 0, 0, 0, 1, 1, 0, 0]
    );
    assert!(Rc::ptr_eq(&trace.steps[3].prev.0, &trace.steps[3].next.0));
    let intake::Cmd::Process(process) = &trace.steps[0].commands[0] else {
        panic!("process")
    };
    assert!(Rc::ptr_eq(&process.input().payload, &a));
    let intake::Cmd::Replay(replay) = &trace.steps[4].commands[0] else {
        panic!("replay")
    };
    let IntakeValue::Value(cached) = &replay.input().result else {
        panic!("cached")
    };
    assert!(Rc::ptr_eq(cached, &result));
    assert!(Rc::ptr_eq(&trace.steps[7].prev.0, &trace.steps[7].next.0));
}
