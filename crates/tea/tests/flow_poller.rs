use demlik_tea::flow::poller::{Poller, PollerConfig, PollerKnob, PollerPhase, create_poller};
use std::{cell::Cell, rc::Rc};
struct Host<'a> {
    _name: &'a str,
}
struct Reading<'a> {
    status: &'a str,
    _local: Rc<()>,
}
struct Cmd {
    _local: Rc<()>,
}
struct Fault;
#[test]
fn only_a_deadline_tick_reads_the_source_and_only_until_held_controls_completion() {
    let name = String::from("source");
    let predicate_calls = Rc::new(Cell::new(0));
    let calls = Rc::clone(&predicate_calls);
    let commands = Rc::new(Cell::new(0));
    let produced = Rc::clone(&commands);
    let command = Rc::new(Cmd {
        _local: Rc::new(()),
    });
    let expected = Rc::clone(&command);
    let config = PollerConfig::new(
        5000.0,
        move |_: &Host<'_>| {
            calls.set(calls.get() + 1);
            true
        },
        move || {
            produced.set(produced.get() + 1);
            Rc::clone(&command)
        },
    );
    let poller: PollerKnob<'_, Host<'_>, Reading<'_>, Cmd, Fault> = create_poller(config);
    let initial = poller.init();
    assert!(initial.last_result.is_absent());
    assert!(poller.subs(&initial).is_empty());
    let armed = poller.start(&initial, 1000.0);
    assert!(armed.commands.is_empty());
    assert_eq!(commands.get(), 0);
    assert_eq!(poller.subs(&armed.state)[0].at_ms.number(), Some(6000.0));
    let fired = poller.tick(&armed.state);
    assert!(Rc::ptr_eq(&fired.state, &armed.state));
    assert!(Rc::ptr_eq(&fired.commands[0], &expected));
    assert_eq!(commands.get(), 1);
    let pending = Rc::new(Reading {
        status: &name,
        _local: Rc::new(()),
    });
    let next = poller
        .tick_result(&fired.state, Rc::clone(&pending), 6000.0, false)
        .unwrap();
    assert!(matches!(next.state.phase, PollerPhase::Polling { .. }));
    assert!(next.commands.is_empty());
    assert_eq!(commands.get(), 1);
    assert_eq!(next.state.last_result.value().unwrap().status, "source");
    assert!(Rc::ptr_eq(
        next.state.last_result.value().unwrap(),
        &pending
    ));
    let fired = poller.tick(&next.state);
    assert_eq!(commands.get(), 2);
    let done = poller
        .tick_result(&fired.state, Rc::clone(&pending), 11000.0, true)
        .unwrap();
    assert!(matches!(done.state.phase, PollerPhase::Done));
    assert!(poller.subs(&done.state).is_empty());
    assert!(poller.tick(&done.state).commands.is_empty());
    assert_eq!(predicate_calls.get(), 0);
    let restarted = poller.start(&done.state, 20000.0);
    assert!(matches!(restarted.state.phase, PollerPhase::Polling { .. }));
    assert_eq!(restarted.state.tick.number(), Some(2.0));
    assert_eq!(
        poller.subs(&restarted.state)[0].id.as_utf8(),
        Some("poller:tick:25000")
    );
}

#[test]
fn the_published_poller_can_be_a_handwritten_trait_object() {
    use demlik_tea::{
        Step,
        flow::poller::{PollerNumber, PollerRetry, PollerState, PollerStep},
        idempotency,
        js_record::JsAccessError,
        resilience::deadline::Deadline,
        work_queue::QueueField,
    };
    struct Manual;
    fn stub_tick(state: &Rc<PollerState<u32, Fault>>) -> PollerStep<u32, u32, Fault> {
        Step::new(
            Rc::clone(state),
            if matches!(state.phase, PollerPhase::Polling { .. }) {
                vec![Rc::new(7)]
            } else {
                vec![]
            },
        )
    }
    impl Poller<u32, u32, Fault> for Manual {
        fn init(&self) -> Rc<PollerState<u32, Fault>> {
            Rc::new(PollerState {
                phase: PollerPhase::Polling {
                    next_at_ms: PollerNumber(None),
                },
                tick: 0.0.into(),
                last_result: QueueField::Absent,
                retry: Rc::new(PollerRetry::new()),
                dedupe: Rc::new(idempotency::init_store(Default::default())),
            })
        }
        fn start(
            &self,
            state: &Rc<PollerState<u32, Fault>>,
            _: f64,
        ) -> PollerStep<u32, u32, Fault> {
            Step::new(Rc::clone(state), vec![])
        }
        fn tick(&self, state: &Rc<PollerState<u32, Fault>>) -> PollerStep<u32, u32, Fault> {
            stub_tick(state)
        }
        fn tick_result(
            &self,
            state: &Rc<PollerState<u32, Fault>>,
            _: Rc<u32>,
            _: f64,
            _: bool,
        ) -> Result<PollerStep<u32, u32, Fault>, JsAccessError> {
            Ok(Step::new(Rc::clone(state), vec![]))
        }
        fn tick_err(
            &self,
            state: &Rc<PollerState<u32, Fault>>,
            _: Rc<Fault>,
            _: f64,
        ) -> PollerStep<u32, u32, Fault> {
            Step::new(Rc::clone(state), vec![])
        }
        fn subs(&self, _: &PollerState<u32, Fault>) -> Vec<Deadline> {
            vec![]
        }
    }
    let poller: Box<dyn Poller<u32, u32, Fault>> = Box::new(Manual);
    let state = poller.init();
    let fired = poller.tick(&state);
    assert_eq!(*fired.commands[0], 7);
    assert!(Rc::ptr_eq(&fired.state, &state));
}

#[test]
fn dedupe_refreshes_seen_keys_and_expires_at_the_half_open_edge() {
    let count = Rc::new(Cell::new(0));
    let calls = Rc::clone(&count);
    let mut config = PollerConfig::new(
        100.0,
        |_: &()| false,
        move || {
            calls.set(calls.get() + 1);
            Rc::new(7u32)
        },
    );
    config.dedupe_key = Some(Rc::new(|reading: &Reading<'_>| reading.status.into()));
    config.dedupe_ttl_ms = Some(10.0);
    let poller: PollerKnob<'_, (), Reading<'_>, u32, Fault> = create_poller(config);
    let inherited = Rc::new(Reading {
        status: "toString",
        _local: Rc::new(()),
    });
    let inherited = poller
        .tick_result(&poller.init(), inherited, 0.0, false)
        .unwrap();
    assert!(inherited.commands.is_empty());
    let value = Rc::new(Reading {
        status: "v",
        _local: Rc::new(()),
    });
    let first = poller
        .tick_result(&inherited.state, Rc::clone(&value), 0.0, false)
        .unwrap();
    assert_eq!(first.commands.len(), 1);
    let touched = poller
        .tick_result(&first.state, Rc::clone(&value), 9.0, false)
        .unwrap();
    assert!(touched.commands.is_empty());
    let still_live = poller
        .tick_result(&touched.state, Rc::clone(&value), 10.0, false)
        .unwrap();
    assert!(still_live.commands.is_empty());
    let expired = poller
        .tick_result(&still_live.state, Rc::clone(&value), 20.0, false)
        .unwrap();
    assert_eq!(expired.commands.len(), 1);
    assert_eq!(count.get(), 2);
    assert_eq!(
        expired.state.dedupe.order.last().unwrap().as_utf8(),
        Some("v")
    );
}

#[test]
fn a_duration_budget_keeps_its_origin_until_success_and_start_keeps_the_streak() {
    use demlik_tea::retry_backoff::{BackoffCurve, DurationBound, Jitter, RetryPolicy};
    let policy = RetryPolicy {
        curve: BackoffCurve {
            base_ms: 100.0,
            factor: 2.0,
            cap_ms: 10000.0,
            jitter: Jitter::None,
        },
        budget: DurationBound {
            max_elapsed_ms: 50.0,
            max_attempts: None,
        },
    };
    let config = PollerConfig::new(5000.0, |_: &()| false, || Rc::new(7u32)).with_retry(policy);
    let poller: PollerKnob<'_, (), u32, u32, Fault, DurationBound> = create_poller(config);
    let failed = poller.tick_err(&poller.init(), Rc::new(Fault), 0.0);
    assert_eq!(
        failed
            .state
            .retry
            .first_failure_at_ms
            .value()
            .unwrap()
            .number(),
        Some(0.0)
    );
    assert_eq!(poller.subs(&failed.state)[0].at_ms.number(), Some(200.0));
    let second = poller.tick_err(&failed.state, Rc::new(Fault), 49.0);
    assert!(matches!(second.state.phase, PollerPhase::Polling { .. }));
    let exhausted = poller.tick_err(&second.state, Rc::new(Fault), 50.0);
    assert!(matches!(exhausted.state.phase, PollerPhase::GaveUp));
    assert_eq!(exhausted.state.retry.attempt.number(), Some(3.0));
    let restarted = poller.start(&exhausted.state, 1000.0);
    assert!(Rc::ptr_eq(&restarted.state.retry, &exhausted.state.retry));
    let recovered = poller
        .tick_result(&restarted.state, Rc::new(9), 1050.0, false)
        .unwrap();
    assert_eq!(recovered.state.retry.attempt.number(), Some(0.0));
    assert!(recovered.state.retry.first_failure_at_ms.is_absent());
    let failed = poller.tick_err(&recovered.state, Rc::new(Fault), 1100.0);
    assert_eq!(
        failed
            .state
            .retry
            .first_failure_at_ms
            .value()
            .unwrap()
            .number(),
        Some(1100.0)
    );
}

#[test]
fn json_restored_null_counters_coerce_only_when_a_new_failure_is_recorded() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        flow::poller::{PollerNumber, PollerRetry, PollerState},
        idempotency,
        work_queue::QueueField,
    };
    let poller: PollerKnob<'_, (), PlainData, u32> =
        create_poller(PollerConfig::new(1000.0, |_: &()| false, || Rc::new(7))).with_rng(|| 0.5);
    let state = Rc::new(PollerState::<PlainData> {
        phase: PollerPhase::Polling {
            next_at_ms: f64::INFINITY.into(),
        },
        tick: f64::INFINITY.into(),
        last_result: QueueField::Undefined,
        retry: Rc::new(PollerRetry {
            attempt: f64::INFINITY.into(),
            last_error: QueueField::Value(Rc::new(PlainData::Undefined)),
            first_failure_at_ms: QueueField::Value(f64::NAN.into()),
        }),
        dedupe: Rc::new(idempotency::init_store(Default::default())),
    });
    let encoded = stringify_json(&plain_data(&state).unwrap()).unwrap();
    let restored = Rc::new(serde_json::from_str::<PollerState<PlainData>>(&encoded).unwrap());
    assert_eq!(restored.tick, PollerNumber(None));
    assert_eq!(restored.retry.attempt, PollerNumber(None));
    assert!(restored.last_result.is_absent());
    assert!(restored.retry.last_error.is_absent());
    assert!(poller.subs(&restored).is_empty());
    let failed = poller.tick_err(&restored, Rc::new(PlainData::Null), 100.0);
    assert_eq!(failed.state.tick.number(), Some(1.0));
    assert_eq!(failed.state.retry.attempt.number(), Some(1.0));
    assert_eq!(
        failed
            .state
            .retry
            .first_failure_at_ms
            .value()
            .unwrap()
            .number(),
        Some(100.0)
    );
    assert_eq!(poller.subs(&failed.state)[0].at_ms.number(), Some(200.0));
    assert!(failed.state.last_result.is_undefined());
    assert_eq!(restored.retry.attempt, PollerNumber(None));
}
