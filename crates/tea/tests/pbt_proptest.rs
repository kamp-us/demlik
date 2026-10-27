#![cfg(feature = "pbt")]
#![allow(
    clippy::arc_with_non_send_sync,
    reason = "Opaque local payloads deliberately prove no Send bound."
)]
use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    pbt::{FailedCase, InvariantFailure, PropertyFailure, PropertyOptions, property_invariant},
};
use proptest::strategy::Just;
use std::{cell::RefCell, rc::Rc, sync::Arc};
struct Model(u32);
impl Tagged for Model {
    fn tag(&self) -> &str {
        "active"
    }
}
struct Payload {
    n: u32,
    _capability: Box<dyn Fn()>,
}
struct Msg(Rc<Payload>);
impl std::fmt::Debug for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Add").field(&self.0.n).finish()
    }
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "add"
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["add"];
}
struct Cmd(Rc<Payload>);
struct OriginalError<'a> {
    note: &'a str,
    cause: Rc<Payload>,
}
#[test]
fn property_folds_the_complete_case_before_predicates_and_retains_original_opaque_failure() {
    let log = RefCell::new(vec![]);
    let label = String::from("original borrowed cause");
    let cause = Rc::new(Payload {
        n: 17,
        _capability: Box::new(|| {}),
    });
    let msgs = (1..=3)
        .map(|n| {
            Arc::new(Msg(Rc::new(Payload {
                n,
                _capability: Box::new(|| {}),
            })))
        })
        .collect::<Vec<_>>();
    let machine: Machine<'_, Model, Msg, Cmd, Sub, RefCell<Vec<String>>> = Machine {
        init: Box::new(|_, log| {
            log.borrow_mut().push("init".into());
            Step::new(Model(0), vec![])
        }),
        update: Update::reducer(|s: &Model, m: &Msg| {
            log.borrow_mut().push(format!("update:{}", m.0.n));
            Step::new(Model(s.0 + m.0.n), vec![Cmd(Rc::clone(&m.0))])
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let failure = property_invariant(
        &machine,
        &log,
        &Just(msgs.clone()),
        || None,
        |step| {
            log.borrow_mut().push(format!("check:{}", step.msg.0.n));
            Err(OriginalError {
                note: &label,
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
        *log.borrow(),
        ["init", "update:1", "update:2", "update:3", "check:1"]
    );
    let PropertyFailure::Case { evaluated, .. } = failure else {
        panic!("expected evaluated failure")
    };
    let FailedCase::Invariant {
        trace,
        step,
        failure: InvariantFailure::Error(error),
    } = evaluated.failure
    else {
        panic!("original invariant error")
    };
    assert_eq!(step, 0);
    assert_eq!(trace.final_state.0, 6);
    assert_eq!(trace.steps.len(), 3);
    assert_eq!(error.note, label);
    assert!(Rc::ptr_eq(&error.cause, &cause));
    for (i, step) in trace.steps.iter().enumerate() {
        assert!(Arc::ptr_eq(&step.msg, &msgs[i]));
        assert!(Arc::ptr_eq(&evaluated.messages[i], &msgs[i]));
        assert!(Rc::ptr_eq(&step.commands[0].0, &msgs[i].0));
        assert!(Arc::ptr_eq(&step.prev, &trace.states[i]));
        assert!(Arc::ptr_eq(&step.next, &trace.states[i + 1]));
    }
}

#[test]
fn native_sequence_tail_bounds_prefix_identity_and_explicit_run_counts() {
    use demlik_tea::pbt::{SequenceOptions, msg_sequence};
    use proptest::strategy::Strategy;
    use std::cell::Cell;
    let prefix = Arc::new(Msg(Rc::new(Payload {
        n: 11,
        _capability: Box::new(|| {}),
    })));
    let sequence = msg_sequence(
        (0u32..=20).prop_map(|n| {
            Arc::new(Msg(Rc::new(Payload {
                n,
                _capability: Box::new(|| {}),
            })))
        }),
        SequenceOptions {
            tail: (2..=2).into(),
            prefix: vec![Arc::clone(&prefix)],
        },
    );
    for (options, expected) in [
        (PropertyOptions::default(), 200),
        (
            PropertyOptions {
                num_runs: 0,
                seed: Some(42),
            },
            0,
        ),
        (
            PropertyOptions {
                num_runs: 3,
                seed: Some(42),
            },
            3,
        ),
    ] {
        let runs = Cell::new(0);
        let checked = Cell::new(0);
        let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
            init: Box::new(|_, _| {
                runs.set(runs.get() + 1);
                Step::new(Model(0), vec![])
            }),
            update: Update::reducer(|s: &Model, m: &Msg| {
                Step::new(Model(s.0 + m.0.n), vec![Cmd(Rc::clone(&m.0))])
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        };
        property_invariant(
            &machine,
            &(),
            &sequence,
            || None,
            |step| {
                let at = checked.get() % 3;
                checked.set(checked.get() + 1);
                if at == 0 {
                    assert!(Arc::ptr_eq(&step.msg, &prefix));
                }
                Ok::<_, std::convert::Infallible>(true)
            },
            options,
        )
        .unwrap();
        assert_eq!(runs.get(), expected);
        assert_eq!(checked.get(), expected * 3);
    }
}

#[test]
fn all_native_failure_boundaries_retain_original_causes_and_refusals_skip_predicates() {
    use proptest::strategy::Strategy;
    use std::{cell::Cell, panic::panic_any};
    for phase in [
        "loaded",
        "init",
        "subs",
        "update",
        "invariant",
        "generator",
        "refused",
        "rejected",
    ] {
        let cause = Arc::new(format!("original {phase}"));
        let checks = Cell::new(0);
        let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
            init: Box::new(|_, _| {
                if phase == "init" {
                    panic_any(Arc::clone(&cause));
                }
                Step::new(Model(0), vec![])
            }),
            update: if phase == "refused" {
                Update::raw_reducer(Default::default())
            } else {
                Update::reducer(|s: &Model, _: &Msg| {
                    if phase == "update" {
                        panic_any(Arc::clone(&cause));
                    }
                    Step::new(Model(s.0), vec![])
                })
            },
            subscriptions: demlik_tea::core::subscriptions(|_| {
                if phase == "subs" {
                    panic_any(Arc::clone(&cause));
                }
                vec![]
            }),
        };
        let sequence = (0u32..=0)
            .prop_map(|_| {
                if phase == "generator" {
                    panic_any(Arc::clone(&cause));
                }
                vec![Arc::new(Msg(Rc::new(Payload {
                    n: 1,
                    _capability: Box::new(|| {}),
                })))]
            })
            .prop_filter("deliberate generator refusal", |_| phase != "rejected");
        let error = property_invariant(
            &machine,
            &(),
            &sequence,
            || {
                if phase == "loaded" {
                    panic_any(Arc::clone(&cause));
                }
                None
            },
            |_| {
                checks.set(checks.get() + 1);
                if phase == "invariant" {
                    panic_any(Arc::clone(&cause));
                }
                Ok::<_, std::convert::Infallible>(true)
            },
            PropertyOptions {
                num_runs: 1,
                seed: Some(42),
            },
        )
        .unwrap_err();
        let panic = match (phase, error) {
            ("generator", PropertyFailure::BackendPanic { cause, .. }) => Some(cause),
            (
                "rejected",
                PropertyFailure::Aborted {
                    reason,
                    last_evaluated: None,
                },
            ) => {
                assert!(reason.contains("reject"));
                None
            }
            ("refused", PropertyFailure::Case { evaluated, .. }) => {
                let FailedCase::FoldRefused(refused) = evaluated.failure else {
                    panic!("expected NoCell")
                };
                assert_eq!(refused.msg_type, "add");
                assert_eq!(refused.state_name, "active");
                assert_eq!(evaluated.messages.len(), 1);
                None
            }
            ("loaded", PropertyFailure::Case { evaluated, .. }) => {
                let FailedCase::LoadedPanic(cause) = evaluated.failure else {
                    panic!("expected loaded panic")
                };
                Some(cause)
            }
            ("init" | "subs" | "update", PropertyFailure::Case { evaluated, .. }) => {
                let FailedCase::FoldPanic(cause) = evaluated.failure else {
                    panic!("expected fold panic")
                };
                Some(cause)
            }
            ("invariant", PropertyFailure::Case { evaluated, .. }) => {
                let FailedCase::Invariant {
                    trace,
                    step: 0,
                    failure: InvariantFailure::Panic(cause),
                } = evaluated.failure
                else {
                    panic!("expected invariant panic")
                };
                assert_eq!(trace.steps.len(), 1);
                Some(cause)
            }
            (_, other) => panic!("unexpected {phase} {other:?}"),
        };
        if let Some(panic) = panic {
            panic.with_payload(|actual| {
                assert!(Arc::ptr_eq(
                    actual.downcast_ref::<Arc<String>>().unwrap(),
                    &cause
                ))
            });
        }
        if phase != "invariant" {
            assert_eq!(checks.get(), 0, "{phase} must not reach invariant");
        }
    }
}

#[test]
fn standard_native_shrinking_keeps_the_evaluated_handles_and_replays_its_minimum() {
    use demlik_tea::pbt::{SequenceOptions, msg_sequence};
    use proptest::strategy::Strategy;
    use std::cell::Cell;
    struct Generated {
        n: u32,
        visited: Cell<bool>,
    }
    impl Tagged for Generated {
        fn tag(&self) -> &str {
            "add"
        }
    }
    impl demlik_tea::core::Message for Generated {
        const TYPES: &'static [&'static str] = &["add"];
    }
    impl std::fmt::Debug for Generated {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            self.n.fmt(f)
        }
    }
    let run = || {
        let prefix = Arc::new(Generated {
            n: 3,
            visited: Cell::new(false),
        });
        let sequence = msg_sequence(
            (0u32..=20).prop_map(|n| {
                Arc::new(Generated {
                    n,
                    visited: Cell::new(false),
                })
            }),
            SequenceOptions {
                tail: (0..=5).into(),
                prefix: vec![Arc::clone(&prefix)],
            },
        );
        let machine: Machine<'_, Model, Generated, (), Sub> = Machine {
            init: Box::new(|_, _| Step::new(Model(0), vec![])),
            update: Update::reducer(|s: &Model, m: &Generated| Step::new(Model(s.0 + m.n), vec![])),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        };
        let calls = Cell::new(0);
        let invariant = |step: &demlik_tea::pbt::FoldStep<Model, Generated, ()>| {
            calls.set(calls.get() + 1);
            step.msg.visited.set(true);
            Ok::<_, std::convert::Infallible>(step.next.0 < 7)
        };
        let error = property_invariant(
            &machine,
            &(),
            &sequence,
            || None,
            invariant,
            PropertyOptions {
                num_runs: 32,
                seed: Some(42),
            },
        )
        .unwrap_err();
        let PropertyFailure::Case { evaluated, .. } = error else {
            panic!("expected minimum")
        };
        let FailedCase::Invariant {
            trace,
            step,
            failure: InvariantFailure::False,
        } = evaluated.failure
        else {
            panic!("expected false")
        };
        let logical = evaluated.messages.iter().map(|m| m.n).collect::<Vec<_>>();
        assert_eq!(logical, [3, 4]);
        assert_eq!(step, 1);
        assert_eq!(trace.final_state.0, 7);
        assert!(calls.get() > 2);
        assert!(Arc::ptr_eq(&evaluated.messages[0], &prefix));
        assert!(
            evaluated.messages.iter().all(|m| m.visited.get()),
            "backend-recreated handles would not have been evaluated"
        );
        for (i, s) in trace.steps.iter().enumerate() {
            assert!(Arc::ptr_eq(&s.msg, &evaluated.messages[i]));
        }
        let before = calls.get();
        let again = property_invariant(
            &machine,
            &(),
            &Just(evaluated.messages),
            || None,
            invariant,
            PropertyOptions {
                num_runs: 1,
                seed: Some(99),
            },
        )
        .unwrap_err();
        assert_eq!(
            calls.get(),
            before + 2,
            "explicit replay calls the same predicate once for each of the two minimum steps"
        );
        let PropertyFailure::Case { evaluated, .. } = again else {
            panic!("expected replay failure")
        };
        assert_eq!(
            evaluated.messages.iter().map(|m| m.n).collect::<Vec<_>>(),
            logical
        );
        (logical, calls.get())
    };
    assert_eq!(
        run(),
        run(),
        "same pinned native seed/config reproduces native minimum and evaluation count"
    );
}

#[test]
fn generated_opaque_intake_histories_respect_pending_keys_and_restored_snapshot_identity() {
    use demlik_tea::{
        idempotency::intake::{self, Config, Entry, Intake, IntakeValue, State},
        js_record::RecordValue,
        pbt::{SequenceOptions, msg_sequence},
    };
    use proptest::strategy::Strategy;
    use std::cell::Cell;
    struct Receipt {
        _opaque: Box<dyn Fn()>,
    }
    struct IntakeModel(Rc<State<Payload, Receipt>>);
    impl Tagged for IntakeModel {
        fn tag(&self) -> &str {
            "intake"
        }
    }
    struct Receive {
        payload: Rc<Payload>,
    }
    impl Tagged for Receive {
        fn tag(&self) -> &str {
            "receive"
        }
    }
    impl demlik_tea::core::Message for Receive {
        const TYPES: &'static [&'static str] = &["receive"];
    }
    impl std::fmt::Debug for Receive {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_tuple("Receive").field(&self.payload.n).finish()
        }
    }
    struct Context<'a> {
        name: &'a str,
        runs: Cell<u32>,
    }
    let name = String::from("opaque webhook processor");
    let slots = (0..4)
        .map(|n| {
            Rc::new(Payload {
                n,
                _capability: Box::new(|| {}),
            })
        })
        .collect::<Vec<_>>();
    let intake = Intake::<Payload, Receipt>::new(
        Config::new(|p: &Payload| Ok(format!("key{}", p.n).into())).with_ttl(1.0),
    );
    let saved = intake
        .receive(&intake.init(), Rc::clone(&slots[0]), 0.0, "before-crash")
        .unwrap()
        .state;
    let saved = intake
        .receive(&saved, Rc::clone(&slots[3]), 0.0, "completed-before-crash")
        .unwrap()
        .state;
    let receipt = Rc::new(Receipt {
        _opaque: Box::new(|| {}),
    });
    let saved = intake
        .complete(
            &saved,
            "key3",
            IntakeValue::Value(Rc::clone(&receipt)),
            1_000_000.0,
        )
        .unwrap()
        .state;
    for restored in [false, true] {
        let context = Context {
            name: &name,
            runs: Cell::new(0),
        };
        let original = Arc::new(Receive {
            payload: Rc::clone(&slots[0]),
        });
        let generated = msg_sequence(
            (0usize..4).prop_map(|slot| {
                Arc::new(Receive {
                    payload: Rc::clone(&slots[slot]),
                })
            }),
            SequenceOptions {
                tail: (3..=12).into(),
                prefix: vec![Arc::clone(&original)],
            },
        );
        let machine: Machine<
            '_,
            IntakeModel,
            Receive,
            intake::Cmd<Payload, Receipt>,
            Sub,
            Context<'_>,
        > = Machine {
            init: Box::new(|loaded, context| {
                assert_eq!(context.name, name);
                context.runs.set(context.runs.get() + 1);
                let state = loaded.map_or_else(
                    || intake.init(),
                    |m: IntakeModel| {
                        assert!(Rc::ptr_eq(&m.0, &saved));
                        m.0
                    },
                );
                let boot = intake.boot(&state).unwrap();
                Step::new(IntakeModel(boot.state), boot.commands)
            }),
            update: Update::reducer(|s: &IntakeModel, m: &Receive| {
                let transition = intake
                    .receive(
                        &s.0,
                        Rc::clone(&m.payload),
                        1_000_000.0,
                        format!("delivery{}", m.payload.n),
                    )
                    .unwrap();
                Step::new(IntakeModel(transition.state), transition.commands)
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        };
        let checks = Cell::new(0);
        let duplicate_checks = Cell::new(0);
        let replay_checks = Cell::new(0);
        property_invariant(
            &machine,
            &context,
            &generated,
            || restored.then(|| IntakeModel(Rc::clone(&saved))),
            |step| {
                checks.set(checks.get() + 1);
                let key = format!("key{}", step.msg.payload.n);
                let previous = step
                    .prev
                    .0
                    .seen
                    .entries
                    .own_entries()
                    .find(|(name, _)| name.as_utf8() == Some(key.as_str()));
                match previous {
                    Some((_, RecordValue::Entry(row))) => match row.value.as_ref() {
                        Entry::Pending => {
                            duplicate_checks.set(duplicate_checks.get() + 1);
                            assert!(step.commands.is_empty());
                            assert!(Rc::ptr_eq(&step.prev.0, &step.next.0));
                        }
                        Entry::Done { .. } => {
                            replay_checks.set(replay_checks.get() + 1);
                            assert_eq!(step.commands.len(), 1);
                            let intake::Cmd::Replay(command) = &step.commands[0] else {
                                panic!("cached key must replay")
                            };
                            let IntakeValue::Value(actual) = &command.input().result else {
                                panic!("original receipt")
                            };
                            assert!(Rc::ptr_eq(actual, &receipt));
                        }
                    },
                    None => {
                        assert_eq!(step.commands.len(), 1);
                        let intake::Cmd::Process(command) = &step.commands[0] else {
                            panic!("new key must process")
                        };
                        assert!(Rc::ptr_eq(&command.input().payload, &step.msg.payload));
                    }
                    Some(_) => panic!("ordinary typed own entries only"),
                }
                Ok::<_, std::convert::Infallible>(true)
            },
            PropertyOptions {
                num_runs: 64,
                seed: Some(42),
            },
        )
        .unwrap();
        assert_eq!(context.runs.get(), 64);
        assert!(checks.get() >= 64 * 4);
        assert!(duplicate_checks.get() > 64);
        assert_eq!(replay_checks.get() > 0, restored);
        println!(
            "PBT_INTAKE {{\"restored\":{restored},\"runs\":{},\"checks\":{},\"pendingDuplicates\":{},\"opaqueReplays\":{}}}",
            context.runs.get(),
            checks.get(),
            duplicate_checks.get(),
            replay_checks.get()
        );
    }
}

#[test]
fn default_native_tail_samples_include_both_inclusive_endpoints() {
    use demlik_tea::pbt::{SequenceOptions, msg_sequence};
    use proptest::test_runner::{Config, RngSeed, TestRunner};
    use std::collections::BTreeSet;
    let message = Arc::new(Msg(Rc::new(Payload {
        n: 1,
        _capability: Box::new(|| {}),
    })));
    let sequence = msg_sequence(Just(message), SequenceOptions::default());
    let lengths = RefCell::new(BTreeSet::new());
    let mut runner = TestRunner::new(Config {
        cases: 256,
        rng_seed: RngSeed::Fixed(42),
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&sequence, |messages| {
            assert!(messages.len() <= 30);
            lengths.borrow_mut().insert(messages.len());
            Ok(())
        })
        .unwrap();
    assert!(lengths.borrow().contains(&0));
    assert!(lengths.borrow().contains(&30));
}

#[test]
fn later_backend_panic_keeps_the_original_evaluated_failure_without_claiming_a_minimum() {
    use proptest::strategy::Strategy;
    use std::cell::Cell;
    let current_calls = Cell::new(0);
    let checks = Cell::new(0);
    let panic = Arc::new(String::from("late backend panic"));
    let label = String::from("original typed failure before backend panic");
    let cause = Rc::new(Payload {
        n: 17,
        _capability: Box::new(|| {}),
    });
    // This intentionally stateful map probes a panic boundary, not a valid
    // deterministic shrink/minimum contract.
    let strategy = (1u32..=20).prop_map(|n| {
        current_calls.set(current_calls.get() + 1);
        if current_calls.get() == 2 {
            std::panic::panic_any(Arc::clone(&panic));
        }
        vec![Arc::new(Msg(Rc::new(Payload {
            n,
            _capability: Box::new(|| {}),
        })))]
    });
    let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|_, _| Step::new(Model(0), vec![])),
        update: Update::reducer(|s: &Model, m: &Msg| {
            Step::new(Model(s.0 + m.0.n), vec![Cmd(Rc::clone(&m.0))])
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let failure = property_invariant(
        &machine,
        &(),
        &strategy,
        || None,
        |_| {
            checks.set(checks.get() + 1);
            Err(OriginalError {
                note: &label,
                cause: Rc::clone(&cause),
            })
        },
        PropertyOptions {
            num_runs: 8,
            seed: Some(42),
        },
    )
    .unwrap_err();
    let PropertyFailure::BackendPanic {
        cause: actual,
        last_evaluated: Some(evaluated),
    } = failure
    else {
        panic!("backend panic with retained original case")
    };
    assert_eq!(checks.get(), 1);
    assert_eq!(current_calls.get(), 2);
    actual.with_payload(|p| {
        assert!(Arc::ptr_eq(
            p.downcast_ref::<Arc<String>>().unwrap(),
            &panic
        ))
    });
    let FailedCase::Invariant {
        trace,
        step: 0,
        failure: InvariantFailure::Error(error),
    } = evaluated.failure
    else {
        panic!("original typed failure")
    };
    assert!(Rc::ptr_eq(&error.cause, &cause));
    assert_eq!(error.note, label);
    assert!(Arc::ptr_eq(&trace.steps[0].msg, &evaluated.messages[0]));
}
