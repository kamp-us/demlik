use super::*;
use crate::{
    js_record::RecordValue,
    resilience::resilient_call::{CallFailure, CallPhase, CallValue, DeadlineConfig, SettleInput},
    retry_backoff::{BackoffCurve, DurationBound, Jitter, RetryPolicy, Unbounded},
};
use std::cell::Cell;

struct Cause<'a>(&'a str, Rc<Cell<u8>>);
struct Payload<'a>(&'a str);
struct ResultValue<'a>(&'a str);
struct Parser<'a>(std::marker::PhantomData<&'a str>);
impl<'a> Schema for Parser<'a> {
    type Raw = ResultValue<'a>;
    type Output = ResultValue<'a>;
    type Error = Cause<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
fn retry_at<I, R, E>(state: &rc::State<I, R, E>) -> f64 {
    let Some(CallPhase::WaitingRetry { retry_at_ms, .. }) = state.call("key") else {
        panic!("retry owed")
    };
    retry_at_ms.number_or_zero()
}
// Contract: configured siblings borrow the original RNG, consume only at
// failure verbs, and preserve their own retry/deadline config plus opaque E.
// Regression: default/copy the RNG, inherit the wrong curve, sample on subs,
// or wrap/rebuild the cause. Existing tests cover one knob at a time.
#[test]
fn configured_tool_and_old_compaction_share_the_brains_original_rng() {
    let text = String::from("borrowed");
    let borrowed = text.as_str();
    let draws = Cell::new(0);
    let marker = Rc::new(Cell::new(7));
    let cause = Rc::new(Cause(borrowed, Rc::clone(&marker)));
    let curve = BackoffCurve {
        base_ms: 10.0,
        factor: 1.0,
        cap_ms: 100.0,
        jitter: Jitter::Full,
    };
    let brain: LlmCall<'_, &str, Payload<'_>, Parser<'_>> = LlmCall::new(
        Config::new(|_: &&str| Rc::new(Parser(std::marker::PhantomData))).with_retry(RetryPolicy {
            curve,
            budget: CountBound { max_attempts: 5.0 },
        }),
        |cause: &Cause<'_>| Ok(cause.0.into()),
    )
    .with_rng(|| {
        let values = [0.125, 0.25, 0.5, 0.75];
        let index = draws.get();
        draws.set(index + 1);
        values[index]
    });
    let compact: rc::ResilientCall<
        '_,
        Payload<'_>,
        ResultValue<'_>,
        Cause<'_>,
        PolicyBudget<CountBound>,
    > = brain.retry_sibling();
    let tool: rc::ResilientCall<
        '_,
        Payload<'_>,
        ResultValue<'_>,
        Cause<'_>,
        crate::retry_backoff::RetryBudget,
    > = brain.retry_sibling_with(rc::Config {
        name: "chosen-tool".into(),
        retry: Some(
            RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 40.0,
                    ..curve
                },
                budget: DurationBound {
                    max_elapsed_ms: 100.0,
                    max_attempts: Some(4.0),
                },
            }
            .into_any(),
        ),
        deadline: Some(DeadlineConfig { ms: 73.0 }),
        ..Default::default()
    });
    let unbounded: rc::ResilientCall<
        '_,
        Payload<'_>,
        ResultValue<'_>,
        Cause<'_>,
        crate::retry_backoff::RetryBudget,
    > = brain.retry_sibling_with(rc::Config {
        retry: Some(
            RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 8.0,
                    ..curve
                },
                budget: Unbounded,
            }
            .into_any(),
        ),
        ..Default::default()
    });
    assert_eq!(tool.name(), "chosen-tool");
    assert_eq!(draws.get(), 0);
    let initial = tool.init();
    assert!(tool.deadlines(&initial).is_empty());
    assert!(tool.timer(&initial).is_none());
    let resumed = tool.resume(&initial, 100.0);
    assert!(resumed.snapshot().calls.own_entries().next().is_none());
    assert_eq!(draws.get(), 0);

    let request = Rc::new(Request::new("invoice", None, Payload(borrowed)));
    assert_eq!(request.payload.0, borrowed);
    let started = brain
        .attempt_keyed(&brain.init(), "key", request, 0.0)
        .unwrap();
    let brain_cause = Rc::new(LlmErr {
        key: "key".into(),
        purpose: "invoice",
        reason: "offline".into(),
        error: LlmCause::Value(Rc::clone(&cause)),
    });
    let failed = brain
        .rc
        .settle(
            &started.state,
            SettleInput::Err {
                key: "key".into(),
                error: Rc::new(CallFailure::External(brain_cause)),
                at: 1.0.into(),
            },
        )
        .unwrap();
    assert_eq!(retry_at(&failed.call), 2.25);
    let started = compact
        .attempt(
            &compact.init(),
            "key",
            CallValue::value(Payload(borrowed)),
            0.0,
        )
        .unwrap();
    let failed = compact
        .settle(
            &started.state,
            SettleInput::Err {
                key: "key".into(),
                error: Rc::new(CallFailure::External(Rc::clone(&cause))),
                at: 2.0.into(),
            },
        )
        .unwrap();
    assert_eq!(retry_at(&failed.call), 4.5);
    let original_input = Rc::new(Payload(borrowed));
    let started = tool
        .attempt(
            &tool.init(),
            "key",
            CallValue::shared(Rc::clone(&original_input)),
            0.0,
        )
        .unwrap();
    let Some(CallPhase::Running { budget, .. }) = started.state.call("key") else {
        panic!("running")
    };
    assert_eq!(budget.remaining_ms.number_or_zero(), 73.0);
    let failed = tool
        .settle(
            &started.state,
            SettleInput::Err {
                key: "key".into(),
                error: Rc::new(CallFailure::External(Rc::clone(&cause))),
                at: 3.0.into(),
            },
        )
        .unwrap();
    assert_eq!(retry_at(&failed.call), 23.0);
    let Some(CallPhase::WaitingRetry {
        input: CallValue::Shared(actual),
        ..
    }) = failed.call.call("key")
    else {
        panic!("original input")
    };
    assert!(Rc::ptr_eq(actual, &original_input));
    let (_, RecordValue::Entry(progress)) =
        failed.call.snapshot().retry.own_entries().next().unwrap()
    else {
        panic!("retry progress")
    };
    let Some(error) = &progress.last_error else {
        panic!("failure retained")
    };
    let CallFailure::External(actual) = error.as_ref() else {
        panic!("opaque cause")
    };
    assert!(Rc::ptr_eq(actual, &cause));
    assert!(Rc::ptr_eq(&actual.1, &marker));
    let started = unbounded
        .attempt(
            &unbounded.init(),
            "key",
            CallValue::value(Payload(borrowed)),
            0.0,
        )
        .unwrap();
    let failed = unbounded
        .settle(
            &started.state,
            SettleInput::Err {
                key: "key".into(),
                error: Rc::new(CallFailure::External(Rc::clone(&cause))),
                at: 4.0.into(),
            },
        )
        .unwrap();
    assert_eq!(retry_at(&failed.call), 10.0);
    assert_eq!(draws.get(), 4);
    assert!(tool.timer(&initial).is_none());
    assert_eq!(draws.get(), 4);
    let output = ResultValue(borrowed);
    assert_eq!(output.0, borrowed);
}

// The public generic constructor has a distinct boundary from DefinedAgent's
// optional policy forwarding: neither bound may disappear behind the budget view.
#[test]
fn generic_constructor_preserves_count_duration_secondary_count_and_unbounded_budgets() {
    fn exercise<B: Budget>(budget: B, expected: &[bool]) {
        let selected = Cell::new(0);
        let llm: LlmCall<'_, &str, Payload<'_>, Parser<'_>, B> = LlmCall::new(
            Config::new(|_: &&str| {
                selected.set(selected.get() + 1);
                Rc::new(Parser(std::marker::PhantomData))
            })
            .with_retry(RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 5.0,
                    factor: 1.0,
                    cap_ms: 5.0,
                    jitter: Jitter::None,
                },
                budget,
            }),
            |cause: &Cause<'_>| Ok(cause.0.into()),
        );
        assert_eq!(selected.get(), 0);
        let request = Rc::new(Request::new("invoice", None, Payload("input")));
        let cause = Rc::new(Cause("offline", Rc::new(Cell::new(7))));
        let mut step = llm.attempt(&llm.init(), Rc::clone(&request), 0.0).unwrap();
        for (index, retries) in expected.iter().enumerate() {
            let command = step
                .commands
                .pop()
                .expect("original or retried provider command");
            assert!(
                matches!(&command.input().input,CallValue::Shared(input) if Rc::ptr_eq(input,&request))
            );
            let crate::command::Outcome::Err { error } =
                llm.rejected(CallValue::Shared(Rc::clone(&cause)))
            else {
                panic!("real provider rejection")
            };
            let at = [0.0, 11.0, 22.0][index];
            let message = llm.run().err(command, error, Some(at));
            step = llm.fail(&step.state, &message).unwrap();
            assert_eq!(llm.timer(&step.state).is_some(), *retries);
            if *retries {
                let timer = llm.timer(&step.state).unwrap();
                step = llm.on_timer(&step.state, &timer.msg).unwrap();
            }
        }
        assert_eq!(
            selected.get(),
            0,
            "failure never selects or substitutes a schema"
        );
    }
    exercise(CountBound { max_attempts: 3.0 }, &[true, true, false]);
    exercise(
        DurationBound {
            max_elapsed_ms: 10.0,
            max_attempts: None,
        },
        &[true, false],
    );
    exercise(
        DurationBound {
            max_elapsed_ms: 10.0,
            max_attempts: Some(4.0),
        },
        &[true, false],
    );
    exercise(
        DurationBound {
            max_elapsed_ms: 100.0,
            max_attempts: Some(2.0),
        },
        &[true, false],
    );
    exercise(Unbounded, &[true, true, true]);
}
