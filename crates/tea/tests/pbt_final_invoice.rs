#![cfg(feature = "pbt")]
#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The consumer deliberately uses opaque local receipts and borrowed context."
)]
use demlik_tea::{
    Machine, Step, Tagged, Update,
    core::Message,
    flow::poller::{Poller, PollerConfig, PollerPhase, PollerState, create_poller},
    pbt::{PropertyOptions, SequenceOptions, msg_sequence, property_terminates, property_trace},
    resilience::deadline::{DeadlinesSub, deadlines_sub},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    work_queue::QueueField,
};
use proptest::strategy::Strategy;
use std::{cell::Cell, rc::Rc, sync::Arc};
struct Receipt {
    paid: bool,
    _capability: Box<dyn Fn()>,
}
struct Failure {
    _capability: Box<dyn Fn()>,
}
struct PollCmd<'a> {
    invoice: &'a str,
    _capability: Box<dyn Fn() + 'a>,
}
struct Model {
    poll: Rc<PollerState<Receipt, Failure>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "invoice"
    }
}
enum Event {
    Start,
    Tick,
    Result(Rc<Receipt>),
    Error(Rc<Failure>),
    Noop,
}
impl Tagged for Event {
    fn tag(&self) -> &str {
        match self {
            Self::Start => "start",
            Self::Tick => "tick",
            Self::Result(_) => "result",
            Self::Error(_) => "error",
            Self::Noop => "noop",
        }
    }
}
impl Message for Event {
    const TYPES: &'static [&'static str] = &["start", "tick", "result", "error", "noop"];
}
impl std::fmt::Debug for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.tag())
    }
}
struct Context<'a> {
    invoice: &'a str,
    inits: Cell<u32>,
}
#[test]
fn invoice_histories_preserve_opaque_receipts_and_terminal_provenance_across_restoration() {
    let invoice = String::from("invoice-42");
    let unpaid = Rc::new(Receipt {
        paid: false,
        _capability: Box::new(|| {}),
    });
    let paid = Rc::new(Receipt {
        paid: true,
        _capability: Box::new(|| {}),
    });
    let failure = Rc::new(Failure {
        _capability: Box::new(|| {}),
    });
    let command = Rc::new(PollCmd {
        invoice: &invoice,
        _capability: Box::new(|| {}),
    });
    let unused_until = Cell::new(0);
    let config = PollerConfig::new(
        10.0,
        |_: &Model| {
            unused_until.set(unused_until.get() + 1);
            false
        },
        || Rc::clone(&command),
    )
    .with_retry(RetryPolicy {
        curve: BackoffCurve {
            base_ms: 1.0,
            factor: 1.0,
            cap_ms: 1.0,
            jitter: Jitter::None,
        },
        budget: CountBound { max_attempts: 1.0 },
    });
    let poller = create_poller::<Model, Receipt, PollCmd<'_>, Failure, _>(config).with_rng(|| 0.5);
    let done = poller
        .tick_result(&poller.init(), Rc::clone(&paid), 0.0, true)
        .unwrap()
        .state;
    let gave_up = poller
        .tick_err(&poller.init(), Rc::clone(&failure), 0.0)
        .state;
    for seed in [None, Some(Rc::clone(&done)), Some(Rc::clone(&gave_up))] {
        let ctx = Context {
            invoice: &invoice,
            inits: Cell::new(0),
        };
        let machine: Machine<'_, Arc<Model>, Event, Rc<PollCmd<'_>>, DeadlinesSub, Context<'_>> =
            Machine {
                init: Box::new(|loaded, ctx| {
                    assert_eq!(ctx.invoice, command.invoice);
                    ctx.inits.set(ctx.inits.get() + 1);
                    Step::new(
                        loaded.unwrap_or_else(|| {
                            Arc::new(Model {
                                poll: poller.init(),
                            })
                        }),
                        vec![Rc::clone(&command)],
                    )
                }),
                update: Update::reducer(|s: &Arc<Model>, m: &Event| {
                    let step = match m {
                        Event::Start => poller.start(&s.poll, 0.0),
                        Event::Tick => poller.tick(&s.poll),
                        Event::Result(result) => poller
                            .tick_result(&s.poll, Rc::clone(result), 1.0, result.paid)
                            .unwrap(),
                        Event::Error(error) => poller.tick_err(&s.poll, Rc::clone(error), 1.0),
                        Event::Noop => Step::new(Rc::clone(&s.poll), vec![]),
                    };
                    Step::new(
                        if Rc::ptr_eq(&s.poll, &step.state) {
                            Arc::clone(s)
                        } else {
                            Arc::new(Model { poll: step.state })
                        },
                        step.commands,
                    )
                }),
                subscriptions: demlik_tea::core::subscriptions(|s: &Arc<Model>| {
                    deadlines_sub(|s: &Arc<Model>| poller.subs(&s.poll))(s)
                        .unwrap()
                        .into_iter()
                        .collect()
                }),
            };
        let history = msg_sequence(
            (0u8..6).prop_map(|op| {
                Arc::new(match op {
                    0 => Event::Start,
                    1 => Event::Tick,
                    2 => Event::Result(Rc::clone(&unpaid)),
                    3 => Event::Result(Rc::clone(&paid)),
                    4 => Event::Error(Rc::clone(&failure)),
                    _ => Event::Noop,
                })
            }),
            SequenceOptions {
                tail: (3..=12).into(),
                prefix: vec![],
            },
        );
        let completed = history.prop_map(|mut messages| {
            messages.push(Arc::new(Event::Result(Rc::clone(&paid))));
            messages
        });
        let loaded = || {
            seed.as_ref().map(|poll| {
                Arc::new(Model {
                    poll: Rc::clone(poll),
                })
            })
        };
        let terminal_calls = Cell::new(0);
        property_terminates(
            &machine,
            &ctx,
            &completed,
            loaded,
            |s| {
                terminal_calls.set(terminal_calls.get() + 1);
                assert!(matches!(s.poll.phase, PollerPhase::Done));
                let QueueField::Value(last) = &s.poll.last_result else {
                    panic!("paid completion")
                };
                assert!(Rc::ptr_eq(last, &paid));
                Ok::<_, std::convert::Infallible>(true)
            },
            PropertyOptions {
                num_runs: 64,
                seed: Some(42),
            },
        )
        .unwrap();
        assert_eq!(terminal_calls.get(), 64);
        let mixed = msg_sequence(
            (0u8..6).prop_map(|op| {
                Arc::new(match op {
                    0 => Event::Start,
                    1 => Event::Tick,
                    2 => Event::Result(Rc::clone(&unpaid)),
                    3 => Event::Result(Rc::clone(&paid)),
                    4 => Event::Error(Rc::clone(&failure)),
                    _ => Event::Noop,
                })
            }),
            SequenceOptions {
                tail: (0..=12).into(),
                prefix: vec![],
            },
        );
        let loaded_done = seed
            .as_ref()
            .is_some_and(|s| matches!(s.phase, PollerPhase::Done));
        let traces = Cell::new(0);
        let checked_steps = Cell::new(0);
        property_trace(
            &machine,
            &ctx,
            &mixed,
            loaded,
            |steps, final_state| {
                traces.set(traces.get() + 1);
                checked_steps.set(checked_steps.get() + steps.len());
                let restart = steps
                    .iter()
                    .rposition(|step| matches!(step.msg.as_ref(), Event::Start));
                if matches!(final_state.poll.phase, PollerPhase::Done) {
                    assert!(
                        (loaded_done && restart.is_none())
                            || steps
                                .iter()
                                .skip(restart.map_or(0, |i| i + 1))
                                .any(|step| matches!(step.msg.as_ref(),Event::Result(r) if r.paid))
                    );
                }
                for (i, step) in steps.iter().enumerate() {
                    if i > 0 {
                        assert!(Arc::ptr_eq(&steps[i - 1].next, &step.prev));
                    }
                    for cmd in &step.commands {
                        assert!(Rc::ptr_eq(cmd, &command));
                        assert_eq!(cmd.invoice, ctx.invoice);
                    }
                    if let QueueField::Value(result) = &step.next.poll.last_result {
                        assert!(Rc::ptr_eq(result, &paid) || Rc::ptr_eq(result, &unpaid));
                    }
                }
                if let Some(last) = steps.last() {
                    assert!(std::ptr::eq(last.next.as_ref(), final_state));
                }
                Ok::<_, std::convert::Infallible>(true)
            },
            PropertyOptions {
                num_runs: 64,
                seed: Some(42),
            },
        )
        .unwrap();
        assert_eq!(traces.get(), 64);
        assert_eq!(ctx.inits.get(), 128);
        assert!(checked_steps.get() > 64);
        assert_eq!(unused_until.get(), 0);
        println!(
            "PBT_INVOICE {{\"loaded\":\"{}\",\"completedCases\":64,\"traceCases\":64,\"mixedSteps\":{}}}",
            seed.as_ref().map_or("fresh", |s| s.phase.as_str()),
            checked_steps.get()
        );
    }
}
