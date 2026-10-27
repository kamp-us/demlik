#![cfg(feature = "pbt")]
#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The public property seam retains original local handles without Send bounds."
)]
use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    pbt::{
        FailedCase, PredicateFailure, PropertyFailure, PropertyOptions, property_terminates,
        property_trace,
    },
};
use proptest::strategy::Just;
use std::{cell::RefCell, rc::Rc, sync::Arc};
struct Payload {
    n: u32,
    _opaque: Box<dyn Fn()>,
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
    Finish,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add(_) => "add",
            Self::Finish => "finish",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["add", "finish"];
}
impl std::fmt::Debug for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.tag())
    }
}
struct Cmd(Rc<Payload>);
struct Original<'a> {
    label: &'a str,
    cause: Rc<Payload>,
}
struct Context<'a> {
    label: &'a str,
    log: RefCell<Vec<String>>,
}
#[test]
fn terminal_predicate_observes_the_complete_case_once_and_preserves_opaque_error() {
    let label = String::from("invoice completion");
    let ctx = Context {
        label: &label,
        log: RefCell::new(vec![]),
    };
    let payload = Rc::new(Payload {
        n: 2,
        _opaque: Box::new(|| {}),
    });
    let second = Rc::new(Payload {
        n: 4,
        _opaque: Box::new(|| {}),
    });
    let cause = Rc::new(Payload {
        n: 17,
        _opaque: Box::new(|| {}),
    });
    let msgs = vec![
        Arc::new(Msg::Add(Rc::clone(&payload))),
        Arc::new(Msg::Finish),
        Arc::new(Msg::Add(Rc::clone(&second))),
    ];
    let machine: Machine<'_, Model, Msg, Cmd, Sub, Context<'_>> = Machine {
        init: Box::new(|_, ctx| {
            assert_eq!(ctx.label, label);
            ctx.log.borrow_mut().push("init".into());
            Step::new(
                Model {
                    n: 0,
                    done: false,
                    payload: Rc::clone(&payload),
                },
                vec![Cmd(Rc::clone(&payload))],
            )
        }),
        update: Update::reducer(|s: &Model, m: &Msg| {
            ctx.log.borrow_mut().push(format!("update:{}", m.tag()));
            match m {
                Msg::Add(p) => Step::new(
                    Model {
                        n: s.n + p.n,
                        done: s.done,
                        payload: Rc::clone(p),
                    },
                    vec![Cmd(Rc::clone(p))],
                ),
                Msg::Finish => Step::new(
                    Model {
                        n: s.n,
                        done: true,
                        payload: Rc::clone(&s.payload),
                    },
                    vec![],
                ),
            }
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            ctx.log.borrow_mut().push("subs".into());
            vec![]
        }),
    };
    let error = property_terminates(
        &machine,
        &ctx,
        &Just(msgs.clone()),
        || None,
        |final_state| {
            ctx.log
                .borrow_mut()
                .push(format!("terminal:{}", final_state.n));
            assert!(final_state.done);
            Err(Original {
                label: &label,
                cause: Rc::clone(&cause),
            })
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(42),
        },
    )
    .unwrap_err();
    assert_eq!(
        *ctx.log.borrow(),
        [
            "init",
            "subs",
            "update:add",
            "update:finish",
            "update:add",
            "terminal:6"
        ]
    );
    let PropertyFailure::Case { evaluated, .. } = error else {
        panic!("evaluated failure")
    };
    let FailedCase::Terminates {
        trace,
        failure: PredicateFailure::Error(error),
    } = evaluated.failure
    else {
        panic!("original terminal error")
    };
    assert_eq!(error.label, label);
    assert!(Rc::ptr_eq(&error.cause, &cause));
    assert_eq!(trace.final_state.n, 6);
    assert!(Rc::ptr_eq(&trace.final_state.payload, &second));
    assert_eq!(
        trace
            .steps
            .iter()
            .map(|s| s.commands.len())
            .collect::<Vec<_>>(),
        [1, 0, 1]
    );
    assert!(Rc::ptr_eq(&trace.steps[2].commands[0].0, &second));
    for (i, step) in trace.steps.iter().enumerate() {
        assert!(Arc::ptr_eq(&step.msg, &msgs[i]));
        assert!(Arc::ptr_eq(&evaluated.messages[i], &msgs[i]));
        assert!(Arc::ptr_eq(&step.prev, &trace.states[i]));
        assert!(Arc::ptr_eq(&step.next, &trace.states[i + 1]));
    }
}

#[test]
fn both_final_checks_run_once_for_empty_loaded_cases_after_init_transform() {
    let label = String::from("restored invoice");
    let ctx = Context {
        label: &label,
        log: RefCell::new(vec![]),
    };
    let payload = Rc::new(Payload {
        n: 5,
        _opaque: Box::new(|| {}),
    });
    let machine: Machine<'_, Model, Msg, Cmd, Sub, Context<'_>> = Machine {
        init: Box::new(|saved, ctx| {
            ctx.log.borrow_mut().push("init".into());
            let saved: Model = saved.unwrap();
            Step::new(
                Model {
                    n: saved.n + 10,
                    ..saved
                },
                vec![Cmd(Rc::clone(&payload))],
            )
        }),
        update: Update::reducer(|_: &Model, _: &Msg| panic!("empty case has no update")),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            ctx.log.borrow_mut().push("subs".into());
            vec![]
        }),
    };
    let saved = || {
        Some(Model {
            n: 5,
            done: true,
            payload: Rc::clone(&payload),
        })
    };
    let error = property_terminates(
        &machine,
        &ctx,
        &Just(Vec::<Arc<Msg>>::new()),
        saved,
        |s| {
            ctx.log.borrow_mut().push(format!("terminal:{}", s.n));
            Ok::<_, Original<'_>>(false)
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(42),
        },
    )
    .unwrap_err();
    let PropertyFailure::Case { evaluated, .. } = error else {
        panic!("empty terminal must actually run")
    };
    let FailedCase::Terminates {
        trace,
        failure: PredicateFailure::False,
    } = evaluated.failure
    else {
        panic!("terminal false")
    };
    assert!(trace.steps.is_empty());
    assert_eq!(trace.states.len(), 1);
    assert_eq!(trace.final_state.n, 15);
    assert!(Arc::ptr_eq(&trace.final_state, &trace.states[0]));
    assert!(Rc::ptr_eq(&trace.final_state.payload, &payload));
    assert_eq!(*ctx.log.borrow(), ["init", "subs", "terminal:15"]);
    ctx.log.borrow_mut().clear();
    let error = property_trace(
        &machine,
        &ctx,
        &Just(Vec::<Arc<Msg>>::new()),
        saved,
        |steps, final_state| {
            assert!(steps.is_empty());
            ctx.log
                .borrow_mut()
                .push(format!("trace:{}", final_state.n));
            Err(Original {
                label: &label,
                cause: Rc::clone(&payload),
            })
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(42),
        },
    )
    .unwrap_err();
    let PropertyFailure::Case { evaluated, .. } = error else {
        panic!("empty trace must actually run")
    };
    let FailedCase::Trace {
        trace,
        failure: PredicateFailure::Error(error),
    } = evaluated.failure
    else {
        panic!("trace original error")
    };
    assert_eq!(*ctx.log.borrow(), ["init", "subs", "trace:15"]);
    assert!(trace.steps.is_empty());
    assert_eq!(trace.final_state.n, 15);
    assert!(Rc::ptr_eq(&trace.final_state.payload, &payload));
    assert!(Rc::ptr_eq(&error.cause, &payload));
    assert_eq!(error.label, label);
}

#[test]
fn trace_predicate_sees_all_original_steps_and_the_actual_final_state_once() {
    let label = String::from("full invoice history");
    let ctx = Context {
        label: &label,
        log: RefCell::new(vec![]),
    };
    let p = Rc::new(Payload {
        n: 2,
        _opaque: Box::new(|| {}),
    });
    let msgs = vec![
        Arc::new(Msg::Add(Rc::clone(&p))),
        Arc::new(Msg::Finish),
        Arc::new(Msg::Add(Rc::clone(&p))),
    ];
    let machine: Machine<'_, Model, Msg, Cmd, Sub, Context<'_>> = Machine {
        init: Box::new(|_, ctx| {
            ctx.log.borrow_mut().push("init".into());
            Step::new(
                Model {
                    n: 0,
                    done: false,
                    payload: Rc::clone(&p),
                },
                vec![Cmd(Rc::clone(&p))],
            )
        }),
        update: Update::reducer(|s: &Model, m: &Msg| {
            ctx.log.borrow_mut().push(format!("update:{}", m.tag()));
            Step::new(
                Model {
                    n: s.n + if matches!(m, Msg::Add(_)) { 2 } else { 0 },
                    done: s.done || matches!(m, Msg::Finish),
                    payload: Rc::clone(&p),
                },
                if matches!(m, Msg::Add(_)) {
                    vec![Cmd(Rc::clone(&p))]
                } else {
                    vec![]
                },
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let error = property_trace(
        &machine,
        &ctx,
        &Just(msgs.clone()),
        || None,
        |steps, final_state| {
            ctx.log.borrow_mut().push("trace".into());
            assert_eq!(steps.len(), 3);
            assert_eq!(final_state.n, 4);
            assert!(final_state.done);
            for (i, s) in steps.iter().enumerate() {
                assert!(Arc::ptr_eq(&s.msg, &msgs[i]));
                if i > 0 {
                    assert!(Arc::ptr_eq(&steps[i - 1].next, &s.prev));
                }
            }
            assert!(std::ptr::eq(
                steps.last().unwrap().next.as_ref(),
                final_state
            ));
            assert_eq!(
                steps.iter().map(|s| s.commands.len()).collect::<Vec<_>>(),
                [1, 0, 1]
            );
            Ok::<_, Original<'_>>(false)
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(42),
        },
    )
    .unwrap_err();
    assert_eq!(
        *ctx.log.borrow(),
        ["init", "update:add", "update:finish", "update:add", "trace"]
    );
    let PropertyFailure::Case { evaluated, .. } = error else {
        panic!("trace false")
    };
    let FailedCase::Trace {
        trace,
        failure: PredicateFailure::False,
    } = evaluated.failure
    else {
        panic!("trace false data")
    };
    assert_eq!(trace.steps.len(), 3);
    assert!(Arc::ptr_eq(&trace.final_state, &trace.steps[2].next));
}

#[test]
fn final_checks_keep_failure_phases_and_skip_callbacks_after_boot_or_cell_refusal() {
    use std::{cell::Cell, panic::panic_any};
    for check in ["terminates", "trace"] {
        for phase in ["loaded", "init", "subs", "update", "predicate", "refusal"] {
            let p = Rc::new(Payload {
                n: 1,
                _opaque: Box::new(|| {}),
            });
            let cause = Arc::new(format!("{check}:{phase}"));
            let called = Cell::new(0);
            let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
                init: Box::new(|_, _| {
                    if phase == "init" {
                        panic_any(Arc::clone(&cause));
                    }
                    Step::new(
                        Model {
                            n: 0,
                            done: false,
                            payload: Rc::clone(&p),
                        },
                        vec![],
                    )
                }),
                update: if phase == "refusal" {
                    Update::raw_reducer(Default::default())
                } else {
                    Update::reducer(|s: &Model, _: &Msg| {
                        if phase == "update" {
                            panic_any(Arc::clone(&cause));
                        }
                        Step::new(
                            Model {
                                n: s.n,
                                done: s.done,
                                payload: Rc::clone(&s.payload),
                            },
                            vec![],
                        )
                    })
                },
                subscriptions: demlik_tea::core::subscriptions(|_| {
                    if phase == "subs" {
                        panic_any(Arc::clone(&cause));
                    }
                    vec![]
                }),
            };
            let loaded = || {
                if phase == "loaded" {
                    panic_any(Arc::clone(&cause));
                }
                None
            };
            let predicate = |_: &Model| {
                called.set(called.get() + 1);
                if phase == "predicate" {
                    panic_any(Arc::clone(&cause));
                }
                Ok::<_, Original<'_>>(true)
            };
            let strategy = Just(vec![Arc::new(Msg::Add(Rc::clone(&p)))]);
            let opts = PropertyOptions {
                num_runs: 1,
                seed: Some(42),
            };
            let error = if check == "terminates" {
                property_terminates(&machine, &(), &strategy, loaded, predicate, opts)
            } else {
                property_trace(&machine, &(), &strategy, loaded, |_, s| predicate(s), opts)
            }
            .unwrap_err();
            let PropertyFailure::Case { evaluated, .. } = error else {
                panic!("evaluated phase")
            };
            let panic = match evaluated.failure {
                FailedCase::LoadedPanic(cause) => {
                    assert_eq!(phase, "loaded");
                    cause
                }
                FailedCase::FoldPanic(cause) => {
                    assert!(["init", "subs", "update"].contains(&phase));
                    cause
                }
                FailedCase::FoldRefused(error) => {
                    assert_eq!(phase, "refusal");
                    assert_eq!(error.msg_type, "add");
                    assert_eq!(called.get(), 0);
                    continue;
                }
                FailedCase::Terminates {
                    trace,
                    failure: PredicateFailure::Panic(cause),
                } => {
                    assert_eq!(check, "terminates");
                    assert_eq!(trace.steps.len(), 1);
                    cause
                }
                FailedCase::Trace {
                    trace,
                    failure: PredicateFailure::Panic(cause),
                } => {
                    assert_eq!(check, "trace");
                    assert_eq!(trace.steps.len(), 1);
                    cause
                }
                _ => panic!("wrong phase"),
            };
            panic.with_payload(|actual| {
                assert!(Arc::ptr_eq(
                    actual.downcast_ref::<Arc<String>>().unwrap(),
                    &cause
                ))
            });
            assert_eq!(called.get(), u32::from(phase == "predicate"));
        }
    }
}

#[test]
fn both_final_callbacks_observe_default_explicit_and_zero_counts_even_without_messages() {
    use std::cell::Cell;
    for check in ["terminates", "trace"] {
        for (options, expected) in [
            (PropertyOptions::default(), 200),
            (
                PropertyOptions {
                    num_runs: 3,
                    seed: Some(42),
                },
                3,
            ),
            (
                PropertyOptions {
                    num_runs: 0,
                    seed: Some(42),
                },
                0,
            ),
        ] {
            let p = Rc::new(Payload {
                n: 0,
                _opaque: Box::new(|| {}),
            });
            let initialized = Cell::new(0);
            let loaded = Cell::new(0);
            let projected = Cell::new(0);
            let checked = Cell::new(0);
            let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
                init: Box::new(|_, _| {
                    initialized.set(initialized.get() + 1);
                    Step::new(
                        Model {
                            n: 0,
                            done: false,
                            payload: Rc::clone(&p),
                        },
                        vec![],
                    )
                }),
                update: Update::reducer(|_: &Model, _: &Msg| panic!("empty")),
                subscriptions: demlik_tea::core::subscriptions(|_| {
                    projected.set(projected.get() + 1);
                    vec![]
                }),
            };
            let snapshot = || {
                loaded.set(loaded.get() + 1);
                None
            };
            let predicate = |_: &Model| {
                checked.set(checked.get() + 1);
                Ok::<_, Original<'_>>(true)
            };
            if check == "terminates" {
                property_terminates(&machine, &(), &Just(vec![]), snapshot, predicate, options)
            } else {
                property_trace(
                    &machine,
                    &(),
                    &Just(vec![]),
                    snapshot,
                    |steps, s| {
                        assert!(steps.is_empty());
                        predicate(s)
                    },
                    options,
                )
            }
            .unwrap();
            assert_eq!(initialized.get(), expected);
            assert_eq!(loaded.get(), expected);
            assert_eq!(projected.get(), expected);
            assert_eq!(checked.get(), expected);
        }
    }
}

#[test]
fn final_modes_shrink_and_replay_original_evaluations_with_borrowed_typed_causes() {
    use proptest::strategy::Strategy;
    use std::cell::Cell;
    struct Item {
        n: u32,
        checked: Cell<bool>,
    }
    struct Event(Rc<Item>);
    impl Tagged for Event {
        fn tag(&self) -> &str {
            "add"
        }
    }
    impl demlik_tea::core::Message for Event {
        const TYPES: &'static [&'static str] = &["add"];
    }
    impl std::fmt::Debug for Event {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            self.0.n.fmt(f)
        }
    }
    struct State {
        n: u32,
        last: Option<Rc<Item>>,
    }
    impl Tagged for State {
        fn tag(&self) -> &str {
            "active"
        }
    }
    for check in ["terminates", "trace"] {
        let run = || {
            let label = String::from("original shrunk failure");
            let cause = Rc::new(Payload {
                n: 17,
                _opaque: Box::new(|| {}),
            });
            let calls = Cell::new(0);
            let strategy = demlik_tea::pbt::msg_sequence(
                (0u32..=20).prop_map(|n| {
                    Arc::new(Event(Rc::new(Item {
                        n,
                        checked: Cell::new(false),
                    })))
                }),
                demlik_tea::pbt::SequenceOptions {
                    tail: (0..=5).into(),
                    prefix: vec![],
                },
            );
            let machine: Machine<'_, State, Event, (), Sub> = Machine {
                init: Box::new(|_, _| Step::new(State { n: 0, last: None }, vec![])),
                update: Update::reducer(|s: &State, m: &Event| {
                    Step::new(
                        State {
                            n: s.n + m.0.n,
                            last: Some(Rc::clone(&m.0)),
                        },
                        vec![],
                    )
                }),
                subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
            };
            let predicate = |s: &State| {
                calls.set(calls.get() + 1);
                if let Some(last) = &s.last {
                    last.checked.set(true);
                }
                if s.n >= 7 {
                    Err(Original {
                        label: &label,
                        cause: Rc::clone(&cause),
                    })
                } else {
                    Ok(true)
                }
            };
            let options = PropertyOptions {
                num_runs: 32,
                seed: Some(42),
            };
            let error = if check == "terminates" {
                property_terminates(&machine, &(), &strategy, || None, predicate, options)
            } else {
                property_trace(
                    &machine,
                    &(),
                    &strategy,
                    || None,
                    |steps, s| {
                        if let Some(last) = steps.last() {
                            last.msg.0.checked.set(true);
                        }
                        predicate(s)
                    },
                    options,
                )
            }
            .unwrap_err();
            let PropertyFailure::Case { evaluated, .. } = error else {
                panic!("shrunk failure")
            };
            let (trace, error) = match evaluated.failure {
                FailedCase::Terminates {
                    trace,
                    failure: PredicateFailure::Error(e),
                } if check == "terminates" => (trace, e),
                FailedCase::Trace {
                    trace,
                    failure: PredicateFailure::Error(e),
                } if check == "trace" => (trace, e),
                _ => panic!("operation-specific failure"),
            };
            assert_eq!(error.label, label);
            assert!(Rc::ptr_eq(&error.cause, &cause));
            let values = evaluated.messages.iter().map(|m| m.0.n).collect::<Vec<_>>();
            assert_eq!(values, [7]);
            assert_eq!(trace.final_state.n, 7);
            assert_eq!(trace.steps.len(), 1);
            assert!(Arc::ptr_eq(&evaluated.messages[0], &trace.steps[0].msg));
            assert!(
                evaluated.messages[0].0.checked.get(),
                "returned messages must have been actually evaluated"
            );
            let before = calls.get();
            let replay = if check == "terminates" {
                property_terminates(
                    &machine,
                    &(),
                    &Just(evaluated.messages),
                    || None,
                    predicate,
                    PropertyOptions {
                        num_runs: 1,
                        seed: Some(99),
                    },
                )
            } else {
                property_trace(
                    &machine,
                    &(),
                    &Just(evaluated.messages),
                    || None,
                    |_, s| predicate(s),
                    PropertyOptions {
                        num_runs: 1,
                        seed: Some(99),
                    },
                )
            };
            assert!(matches!(replay, Err(PropertyFailure::Case { .. })));
            assert_eq!(
                calls.get(),
                before + 1,
                "only the explicit one-case replay invokes the callback again"
            );
            (values, before)
        };
        assert_eq!(
            run(),
            run(),
            "same pinned native seed reproduces native evaluated minimum/call count"
        );
    }
}
