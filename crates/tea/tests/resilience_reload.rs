use demlik_tea::resilience::{cache, circuit_breaker as circuit, deadline, rate_limit};

#[test]
fn nullable_stored_numbers_coerce_only_when_a_domain_operation_uses_them() {
    let bucket: rate_limit::TokenBucket = serde_json::from_str(
        r#"{"tokens":null,"capacity":null,"refillPerSec":null,"lastRefillMs":null}"#,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(bucket).unwrap(),
        serde_json::json!({
            "tokens":null,"capacity":null,"refillPerSec":null,"lastRefillMs":null
        })
    );
    let (next, allowed) = rate_limit::try_consume(&bucket, 1000.0, 1.0);
    assert!(!allowed);
    assert_eq!(
        serde_json::to_value(next).unwrap(),
        serde_json::json!({
            "tokens":0.0,"capacity":null,"refillPerSec":null,"lastRefillMs":1000.0
        })
    );

    let closed: circuit::CircuitState =
        serde_json::from_str(r#"{"phase":"closed","failures":null}"#).unwrap();
    assert_eq!(
        serde_json::to_value(closed).unwrap(),
        serde_json::json!({"phase":"closed","failures":null})
    );
    let closed = circuit::on_success(&closed, &circuit::DEFAULT_CIRCUIT_POLICY);
    assert_eq!(
        serde_json::to_value(closed).unwrap(),
        serde_json::json!({"phase":"closed","failures":0.0})
    );
    let open: circuit::CircuitState =
        serde_json::from_str(r#"{"phase":"open","openedAtMs":null}"#).unwrap();
    let (next, allowed) = circuit::can_pass(&open, &circuit::DEFAULT_CIRCUIT_POLICY, 30_000.0);
    assert!(allowed);
    assert_eq!(
        serde_json::to_value(next).unwrap(),
        serde_json::json!({"phase":"half_open","probes":1.0})
    );

    let cache: cache::TtlCache<&str> =
        serde_json::from_str(r#"{"entries":{"key":{"value":"stored","expiresAtMs":null}}}"#)
            .unwrap();
    assert!(cache::get(&cache, "key", -1.0).unwrap().is_some());
    assert!(cache::get(&cache, "key", 0.0).unwrap().is_none());
}

#[test]
fn a_restored_null_deadline_keeps_null_in_the_delivered_message() {
    let deadline: deadline::Deadline =
        serde_json::from_str(r#"{"id":"key","type":"deadline","atMs":null}"#).unwrap();
    let deps: demlik_tea::TimerDeps<deadline::DeadlineExceeded> =
        deadline::next_timer(&[deadline], -10.0).unwrap();
    assert_eq!(deps.ms, 10.0);
    assert_eq!(
        serde_json::to_value(deps.msg).unwrap(),
        serde_json::json!({
            "type":"deadline_exceeded","id":"key","atMs":null
        })
    );
}
