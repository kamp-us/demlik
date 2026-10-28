use demlik_tea::retry_backoff::*;

#[test]
fn branded_randomness_and_timed_state_work_through_the_public_api() {
    let mut rng = as_rng(|| 0.5, true).unwrap();
    let fresh = init_retry::<&str>();
    let timed = record_failure_at(&fresh, "offline", 100.0);
    let policy = RetryPolicy {
        curve: DEFAULT_RETRY_POLICY.curve,
        budget: DurationBound {
            max_elapsed_ms: 5000.0,
            max_attempts: None,
        },
    };
    assert!(should_retry_timed(&timed, &policy, 101.0));
    assert_eq!(next_delay_ms(&timed.retry, &policy.curve, &mut rng), 100.0);
}

// Contract: a heterogeneous budget preserves existing policy fields and limits.
// Regression: invent an enum wire tag, drop a duration/count limit, or cap infinity.
// Existing monomorphic tests never serialize or inspect the heterogeneous sum.
#[test]
fn heterogeneous_budgets_delegate_limits_and_keep_existing_flat_wire() {
    let curve = BackoffCurve {
        base_ms: 10.0,
        factor: 1.0,
        cap_ms: 100.0,
        jitter: Jitter::None,
    };
    let count = RetryPolicy {
        curve,
        budget: CountBound { max_attempts: 2.0 },
    };
    let duration = RetryPolicy {
        curve,
        budget: DurationBound {
            max_elapsed_ms: 30.0,
            max_attempts: Some(3.0),
        },
    };
    let unlimited = RetryPolicy {
        curve,
        budget: Unbounded,
    };
    let policies = [count.into_any(), duration.into_any(), unlimited.into_any()];
    for (policy, expected) in policies.iter().zip([
        r#"{"baseMs":10.0,"factor":1.0,"capMs":100.0,"jitter":"none","maxAttempts":2.0}"#,
        r#"{"baseMs":10.0,"factor":1.0,"capMs":100.0,"jitter":"none","maxElapsedMs":30.0,"maxAttempts":3.0}"#,
        r#"{"baseMs":10.0,"factor":1.0,"capMs":100.0,"jitter":"none","unbounded":true}"#,
    ]) {
        assert_eq!(serde_json::to_string(policy).unwrap(), expected);
    }
    assert_eq!(
        serde_json::to_string(&policies[0]).unwrap(),
        serde_json::to_string(&count).unwrap()
    );
    assert_eq!(
        serde_json::to_string(&policies[1]).unwrap(),
        serde_json::to_string(&duration).unwrap()
    );
    assert_eq!(
        serde_json::to_string(&policies[2]).unwrap(),
        serde_json::to_string(&unlimited).unwrap()
    );
    assert_eq!(policies[0].budget.max_attempts(), Some(2.0));
    assert_eq!(policies[0].budget.max_elapsed_ms(), None);
    assert_eq!(policies[1].budget.max_attempts(), Some(3.0));
    assert_eq!(policies[1].budget.max_elapsed_ms(), Some(30.0));
    assert_eq!(policies[2].budget.max_attempts(), None);
    assert_eq!(policies[2].budget.max_elapsed_ms(), None);
    let origin = record_failure_at(&init_retry::<()>(), (), 0.0);
    assert!(should_retry_timed(&origin, &policies[0], 100.0));
    assert!(!should_retry_timed(&origin, &policies[1], 30.0));
    assert!(should_retry_timed(&origin, &policies[2], f64::INFINITY));
}

// Contract: changing the configuration budget never changes the durable State type.
// Regression: require a budget tag/DTO or bypass the canonical retry transitions.
// This crosses public ResilientCall with one shared State alias, unlike trait-only tests.
#[test]
fn heterogeneous_policies_use_the_same_canonical_state_and_decoder() {
    use demlik_tea::resilience::resilient_call::{
        CallFailure, CallPhase, CallValue, Config, ResilientCall, SettleInput, State,
    };
    type Stored = State<String, (), String>;
    let curve = BackoffCurve {
        jitter: Jitter::None,
        ..DEFAULT_RETRY_POLICY.curve
    };
    let policies = [
        RetryPolicy {
            curve,
            budget: CountBound { max_attempts: 1.0 },
        }
        .into_any(),
        RetryPolicy {
            curve,
            budget: DurationBound {
                max_elapsed_ms: 0.0,
                max_attempts: None,
            },
        }
        .into_any(),
        RetryPolicy {
            curve,
            budget: Unbounded,
        }
        .into_any(),
    ];
    let baseline: ResilientCall<'_, String, (), String> = ResilientCall::new(Config::default());
    let seed: Stored = baseline.init();
    let seed_wire = serde_json::to_string(&seed).unwrap();
    let restored: Stored = serde_json::from_str(&seed_wire).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), seed_wire);
    for (index, policy) in policies.into_iter().enumerate() {
        let knob: ResilientCall<'_, String, (), String, RetryBudget> = ResilientCall::new(Config {
            retry: Some(policy),
            ..Default::default()
        });
        let initial: Stored = knob.init();
        assert_eq!(serde_json::to_string(&initial).unwrap(), seed_wire);
        let started = knob
            .attempt(
                &restored,
                "key",
                CallValue::value(String::from("original")),
                0.0,
            )
            .unwrap();
        let failed = knob
            .settle(
                &started.state,
                SettleInput::err("key", CallFailure::external(String::from("offline")), 1.0),
            )
            .unwrap();
        assert_eq!(
            matches!(
                failed.call.call("key"),
                Some(CallPhase::WaitingRetry { .. })
            ),
            index == 2
        );
        let encoded = serde_json::to_string(&failed.call).unwrap();
        assert!(!encoded.contains("RetryBudget"));
        let cold: Stored = serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&cold).unwrap(), encoded);
    }
}
