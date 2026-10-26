use demlik_tea::{
    Machine, Step, Sub, Subscription, Tagged, Update,
    core::{Row, subscriptions},
    testing::{
        CheckError, ReplayOpts, bind_machine, expect_active_subs, expect_cmd_emitted,
        expect_cmd_sequence, expect_final_state, step,
    },
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};
struct Opaque<'a> {
    label: &'a str,
    _capability: Box<dyn Fn() + 'a>,
}
struct Model<'a> {
    n: u32,
    payload: Rc<Opaque<'a>>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "ready"
    }
}
struct Msg {
    kind: &'static str,
    by: u32,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        self.kind
    }
}
struct Cmd<'a> {
    kind: &'static str,
    payload: Rc<Opaque<'a>>,
}
struct Input<'a> {
    delta: u32,
    payload: Rc<Opaque<'a>>,
}
fn machine<'a>(
    log: &'a RefCell<Vec<String>>,
) -> Machine<'a, Model<'a>, Msg, Cmd<'a>, Sub, Input<'a>> {
    let mut row: Row<'a, Model<'a>, Msg, Cmd<'a>> = Row::new();
    row.insert(
        "add".into(),
        Box::new(|s, m| {
            log.borrow_mut().push(format!("cell:{}", s.n));
            Step::new(
                Model {
                    n: s.n + m.by,
                    payload: Rc::clone(&s.payload),
                },
                vec![Cmd {
                    kind: "added",
                    payload: Rc::clone(&s.payload),
                }],
            )
        }),
    );
    Machine {
        init: Box::new(|saved, input| {
            log.borrow_mut().push("init".into());
            let old = saved.unwrap_or(Model {
                n: 0,
                payload: Rc::clone(&input.payload),
            });
            Step::new(
                Model {
                    n: old.n + input.delta,
                    payload: old.payload,
                },
                vec![Cmd {
                    kind: "boot",
                    payload: Rc::clone(&input.payload),
                }],
            )
        }),
        update: Update::RawReducer(row),
        subscriptions: subscriptions(|s: &Model<'a>| {
            log.borrow_mut().push(format!("subs:{}", s.n));
            vec![
                Sub::new("a", serde_json::json!({"n":s.n})).unwrap(),
                Sub::new("b", serde_json::json!({"n":s.n})).unwrap(),
            ]
        }),
    }
}
fn opts() -> ReplayOpts<Model<'static>, [Msg; 2]> {
    ReplayOpts {
        loaded: None,
        msgs: [Msg { kind: "add", by: 1 }, Msg { kind: "add", by: 2 }],
    }
}
fn nofail<T>(result: Result<T, CheckError<Infallible>>) -> T {
    result.unwrap()
}
#[test]
fn borrowed_bound_step_does_not_boot_and_replay_boots_once_including_resume_commands() {
    let label = String::from("owned outside the machine");
    let payload = Rc::new(Opaque {
        label: &label,
        _capability: Box::new(|| {}),
    });
    let input = Input {
        delta: 10,
        payload: Rc::clone(&payload),
    };
    let log = RefCell::new(vec![]);
    let m = machine(&log);
    let h = bind_machine(&m, &input);
    let loaded = Model {
        n: 4,
        payload: Rc::clone(&payload),
    };
    let msg = Msg { kind: "add", by: 2 };
    let next = h.step(&loaded, &msg).unwrap();
    assert_eq!(next.state.n, 6);
    assert_eq!(next.commands[0].kind, "added");
    assert_eq!(&*log.borrow(), &["cell:4"]);
    log.borrow_mut().clear();
    let next = step(&m, &loaded, &msg, &input).unwrap();
    assert_eq!(next.state.n, 6);
    log.borrow_mut().clear();
    let result = h
        .replay(ReplayOpts {
            loaded: Some(loaded),
            msgs: [msg],
        })
        .unwrap();
    assert_eq!(result.state.n, 16);
    assert_eq!(
        result.commands.iter().map(|c| c.kind).collect::<Vec<_>>(),
        vec!["boot", "added"]
    );
    assert_eq!(&*log.borrow(), &["init", "cell:14", "subs:16"]);
    assert!(Rc::ptr_eq(&result.state.payload, &payload));
    assert_eq!(result.state.payload.label, label);
}
#[test]
fn four_named_operations_compare_only_after_complete_replay_with_ordered_sequences_and_subs() {
    let p = Rc::new(Opaque {
        label: "opaque",
        _capability: Box::new(|| {}),
    });
    let input = Input {
        delta: 0,
        payload: Rc::clone(&p),
    };
    let log = RefCell::new(vec![]);
    let m = machine(&log);
    let h = bind_machine(&m, &input);
    let expected = Model {
        n: 3,
        payload: Rc::clone(&p),
    };
    nofail(expect_final_state(&m, &input, opts(), &expected, |a, b| {
        assert_eq!(&*log.borrow(), &["init", "cell:0", "cell:1", "subs:3"]);
        Ok(a.n == b.n && Rc::ptr_eq(&a.payload, &b.payload))
    }));
    log.borrow_mut().clear();
    nofail(h.expect_final_state(opts(), &expected, |a, b| Ok(a.n == b.n)));
    let expected = Cmd {
        kind: "added",
        payload: Rc::clone(&p),
    };
    let visits = RefCell::new(vec![]);
    nofail(expect_cmd_emitted(&m, &input, opts(), &expected, |a, b| {
        visits.borrow_mut().push(a.kind);
        Ok(a.kind == b.kind && Rc::ptr_eq(&a.payload, &b.payload))
    }));
    assert_eq!(&*visits.borrow(), &["boot", "added"]);
    nofail(h.expect_cmd_emitted(opts(), &expected, |a, b| Ok(a.kind == b.kind)));
    let sequence = ["boot", "added", "added"].map(|kind| Cmd {
        kind,
        payload: Rc::clone(&p),
    });
    nofail(expect_cmd_sequence(
        &m,
        &input,
        opts(),
        &sequence,
        |a, b| Ok(a.kind == b.kind),
    ));
    nofail(h.expect_cmd_sequence(opts(), &sequence, |a, b| Ok(a.kind == b.kind)));
    let wrong = ["added", "boot", "added"].map(|kind| Cmd {
        kind,
        payload: Rc::clone(&p),
    });
    let mismatch =
        h.expect_cmd_sequence(opts(), &wrong, |a, b| Ok::<_, Infallible>(a.kind == b.kind));
    assert!(matches!(
        mismatch,
        Err(CheckError::CmdSequenceItem { index: 0 })
    ));
    let comparisons = Cell::new(0);
    assert!(matches!(
        h.expect_cmd_sequence(opts(), &[], |_, _| {
            comparisons.set(comparisons.get() + 1);
            Ok::<_, Infallible>(true)
        }),
        Err(CheckError::CmdSequenceLength {
            actual: 3,
            expected: 0
        })
    ));
    assert_eq!(comparisons.get(), 0);
    let subs = [
        Sub::new("a", serde_json::json!({"n":3})).unwrap(),
        Sub::new("b", serde_json::json!({"n":3})).unwrap(),
    ];
    nofail(expect_active_subs(&m, &input, opts(), &subs, |a, b| {
        Ok(a.id() == b.id() && a.kind() == b.kind() && a.deps() == b.deps())
    }));
    nofail(h.expect_active_subs(opts(), &subs, |a, b| {
        Ok(a.id() == b.id() && a.kind() == b.kind() && a.deps() == b.deps())
    }));
    let reversed = [subs[1].clone(), subs[0].clone()];
    assert!(matches!(
        h.expect_active_subs(opts(), &reversed, |a, b| Ok::<_, Infallible>(
            a.id() == b.id() && a.kind() == b.kind() && a.deps() == b.deps()
        )),
        Err(CheckError::ActiveSubsItem { index: 0 })
    ));
}
#[test]
fn replay_refusal_skips_the_comparator_and_preserves_all_existing_refusal_fields() {
    let p = Rc::new(Opaque {
        label: "opaque",
        _capability: Box::new(|| {}),
    });
    let input = Input {
        delta: 0,
        payload: Rc::clone(&p),
    };
    let log = RefCell::new(vec![]);
    let m = machine(&log);
    let h = bind_machine(&m, &input);
    let calls = Cell::new(0);
    let expected = Model { n: 0, payload: p };
    let error = h
        .expect_final_state(
            ReplayOpts {
                loaded: None,
                msgs: [Msg {
                    kind: "missing",
                    by: 0,
                }],
            },
            &expected,
            |_, _| {
                calls.set(calls.get() + 1);
                Ok::<_, Infallible>(true)
            },
        )
        .unwrap_err();
    let CheckError::Replay(error) = error else {
        panic!("original refusal")
    };
    assert_eq!(error.msg_type, "missing");
    assert_eq!(error.state_name, "ready");
    assert_eq!(error.accepted_types, vec!["add"]);
    assert_eq!(calls.get(), 0);
    assert_eq!(&*log.borrow(), &["init"]);
}
#[test]
fn comparison_failures_and_panics_retain_the_original_cause_without_formatting() {
    struct Cause {
        _capability: Box<dyn Fn()>,
    }
    let p = Rc::new(Opaque {
        label: "opaque",
        _capability: Box::new(|| {}),
    });
    let input = Input {
        delta: 0,
        payload: Rc::clone(&p),
    };
    let log = RefCell::new(vec![]);
    let m = machine(&log);
    let h = bind_machine(&m, &input);
    let cause = Rc::new(Cause {
        _capability: Box::new(|| {}),
    });
    let expected = Cmd {
        kind: "added",
        payload: p,
    };
    let result = h.expect_cmd_emitted(opts(), &expected, |_, _| Err(Rc::clone(&cause)));
    let Err(CheckError::Matcher(actual)) = result else {
        panic!("exact caller cause")
    };
    assert!(Rc::ptr_eq(&actual, &cause));
    struct PanicCause {
        code: u32,
    }
    let cause = Arc::new(PanicCause { code: 17 });
    let panic = Arc::clone(&cause);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.expect_cmd_emitted(opts(), &expected, |_, _| -> Result<bool, Infallible> {
            std::panic::panic_any(Arc::clone(&panic))
        })
    }));
    let error = result.err().unwrap();
    let actual = error.downcast_ref::<Arc<PanicCause>>().unwrap();
    assert!(Arc::ptr_eq(actual, &cause));
    assert_eq!(actual.code, 17);
}

#[test]
fn real_poller_history_uses_borrowed_opaque_values_through_bound_step_replay_and_all_assertions() {
    use demlik_tea::{
        core::Message,
        flow::poller::{
            Poller, PollerConfig, PollerPhase, PollerRetry, PollerState, create_poller,
        },
        idempotency::{self, StoreOptions},
        resilience::deadline::{DeadlinesSub, deadline_sub},
        work_queue::QueueField,
    };
    struct Reading<'a> {
        status: &'a str,
        _capability: Box<dyn Fn() + 'a>,
    }
    struct Fetch<'a> {
        source: &'a str,
        _capability: Box<dyn Fn() + 'a>,
    }
    struct Fault;
    struct Model<'a> {
        poll: Rc<PollerState<Reading<'a>, Fault>>,
    }
    impl Tagged for Model<'_> {
        fn tag(&self) -> &str {
            "model"
        }
    }
    enum Msg<'a> {
        Begin,
        Deadline,
        Read { value: Rc<Reading<'a>>, at: f64 },
    }
    impl Tagged for Msg<'_> {
        fn tag(&self) -> &str {
            match self {
                Self::Begin => "begin",
                Self::Deadline => "deadline",
                Self::Read { .. } => "read",
            }
        }
    }
    impl Message for Msg<'_> {
        const TYPES: &'static [&'static str] = &["begin", "deadline", "read"];
    }
    let name = String::from("billing status");
    let ready_name = String::from("ready");
    let fetch = Rc::new(Fetch {
        source: &name,
        _capability: Box::new(|| {}),
    });
    let on_tick = Rc::clone(&fetch);
    let poll: Rc<dyn Poller<Reading<'_>, Fetch<'_>, Fault> + '_> =
        Rc::new(create_poller(PollerConfig::new(
            5.0,
            |_: &Model<'_>| panic!("predicate is evaluated by the authored update"),
            move || Rc::clone(&on_tick),
        )));
    let init = Rc::clone(&poll);
    let update = Rc::clone(&poll);
    let subs = Rc::clone(&poll);
    let log: RefCell<Vec<String>> = RefCell::new(vec![]);
    let init_log = &log;
    let update_log = &log;
    let subs_log = &log;
    let machine: Machine<'_, Model<'_>, Msg<'_>, Rc<Fetch<'_>>, DeadlinesSub, &str> = Machine {
        init: Box::new(move |loaded, _| {
            init_log.borrow_mut().push("init".into());
            Step::new(
                loaded.unwrap_or_else(|| Model { poll: init.init() }),
                vec![],
            )
        }),
        update: Update::reducer(move |s: &Model<'_>, m: &Msg<'_>| {
            update_log.borrow_mut().push(m.tag().into());
            let step = match m {
                Msg::Begin => update.start(&s.poll, 0.0),
                Msg::Deadline => update.tick(&s.poll),
                Msg::Read { value, at } => update
                    .tick_result(&s.poll, Rc::clone(value), *at, value.status == "ready")
                    .unwrap(),
            };
            Step::new(Model { poll: step.state }, step.commands)
        }),
        subscriptions: subscriptions(move |s: &Model<'_>| {
            subs_log.borrow_mut().push("subs".into());
            let deadlines = subs.subs(&s.poll);
            if deadlines.is_empty() {
                vec![]
            } else {
                vec![Sub::new("deadline", deadlines).unwrap()]
            }
        }),
    };
    let ctx = name.as_str();
    let h = bind_machine(&machine, &ctx);
    let pending = Rc::new(Reading {
        status: "pending",
        _capability: Box::new(|| {}),
    });
    let ready = Rc::new(Reading {
        status: &ready_name,
        _capability: Box::new(|| {}),
    });
    let history = || ReplayOpts {
        loaded: None,
        msgs: [
            Msg::Begin,
            Msg::Deadline,
            Msg::Read {
                value: Rc::clone(&pending),
                at: 5.0,
            },
            Msg::Deadline,
            Msg::Read {
                value: Rc::clone(&ready),
                at: 10.0,
            },
        ],
    };
    let result = h.replay(history()).unwrap();
    assert!(matches!(result.state.poll.phase, PollerPhase::Done));
    assert_eq!(result.state.poll.tick.number(), Some(2.0));
    assert!(result.subs.is_empty());
    assert_eq!(result.commands.len(), 2);
    assert!(result.commands.iter().all(|c| Rc::ptr_eq(c, &fetch)));
    assert!(Rc::ptr_eq(
        result.state.poll.last_result.value().unwrap(),
        &ready
    ));
    assert_eq!(result.commands[0].source, name);
    assert_eq!(
        &*log.borrow(),
        &[
            "init", "begin", "deadline", "read", "deadline", "read", "subs"
        ]
    );
    let armed = h
        .replay(ReplayOpts {
            loaded: None,
            msgs: [Msg::Begin],
        })
        .unwrap();
    log.borrow_mut().clear();
    let one = h.step(&armed.state, &Msg::Deadline).unwrap();
    assert_eq!(one.commands.len(), 1);
    assert!(Rc::ptr_eq(&one.commands[0], &fetch));
    assert_eq!(&*log.borrow(), &["deadline"]);
    let same_fetch = |a: &Rc<Fetch<'_>>, b: &Rc<Fetch<'_>>| Ok::<_, Infallible>(Rc::ptr_eq(a, b));
    nofail(h.expect_cmd_emitted(history(), &fetch, same_fetch));
    nofail(h.expect_cmd_sequence(
        history(),
        &[Rc::clone(&fetch), Rc::clone(&fetch)],
        same_fetch,
    ));
    let expected = Model {
        poll: Rc::new(PollerState {
            phase: PollerPhase::Done,
            tick: 2.0.into(),
            last_result: QueueField::Value(Rc::clone(&ready)),
            retry: Rc::new(PollerRetry::new()),
            dedupe: Rc::new(idempotency::init_store(StoreOptions::default())),
        }),
    };
    nofail(h.expect_final_state(history(), &expected, |a, b| {
        Ok::<_, Infallible>(
            a.poll.phase.as_str() == b.poll.phase.as_str()
                && a.poll.tick == b.poll.tick
                && Rc::ptr_eq(
                    a.poll.last_result.value().unwrap(),
                    b.poll.last_result.value().unwrap(),
                )
                && a.poll.retry.attempt == b.poll.retry.attempt
                && a.poll.retry.last_error.is_absent()
                && b.poll.retry.last_error.is_absent()
                && a.poll.retry.first_failure_at_ms.is_absent()
                && b.poll.retry.first_failure_at_ms.is_absent()
                && a.poll.dedupe.entries.own_entries().next().is_none()
                && b.poll.dedupe.entries.own_entries().next().is_none()
                && a.poll.dedupe.order.is_empty()
                && b.poll.dedupe.order.is_empty()
                && a.poll.dedupe.ttl_ms == b.poll.dedupe.ttl_ms
                && a.poll.dedupe.capacity == b.poll.dedupe.capacity,
        )
    }));
    let mid = || ReplayOpts {
        loaded: None,
        msgs: [
            Msg::Begin,
            Msg::Deadline,
            Msg::Read {
                value: Rc::clone(&pending),
                at: 5.0,
            },
        ],
    };
    let expected = [Sub::new("deadline", vec![deadline_sub("poller:tick:10", 10.0)]).unwrap()];
    nofail(h.expect_active_subs(mid(), &expected, |a, b| {
        Ok::<_, Infallible>(
            a.id() == b.id()
                && a.kind() == b.kind()
                && a.deps().len() == b.deps().len()
                && a.deps()
                    .iter()
                    .zip(b.deps())
                    .all(|(a, b)| a.id == b.id && a.at_ms == b.at_ms),
        )
    }));
    nofail(
        h.expect_active_subs(history(), &[], |_, _| -> Result<bool, Infallible> {
            panic!("empty desired arrays do not compare")
        }),
    );
}

#[test]
fn a_final_state_comparator_can_return_an_owned_non_clone_cause_once() {
    struct Cause {
        capability: Box<dyn Fn() -> u32>,
    }
    let p = Rc::new(Opaque {
        label: "opaque",
        _capability: Box::new(|| {}),
    });
    let input = Input {
        delta: 0,
        payload: Rc::clone(&p),
    };
    let log = RefCell::new(vec![]);
    let m = machine(&log);
    let h = bind_machine(&m, &input);
    let cause = Cause {
        capability: Box::new(|| 17),
    };
    let expected = Model { n: 3, payload: p };
    let result = h.expect_final_state(opts(), &expected, move |_, _| Err(cause));
    let Err(CheckError::Matcher(actual)) = result else {
        panic!("owned caller cause")
    };
    assert_eq!((actual.capability)(), 17);
}
