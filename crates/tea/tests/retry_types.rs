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
