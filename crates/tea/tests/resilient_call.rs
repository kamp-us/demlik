use demlik_tea::resilience::resilient_call::{
    CacheConfig, CallPhase, CallValue, Config, ResilientCall, SettleInput, SettleOutcome,
};
use std::{cell::Cell, rc::Rc};

struct ResultValue<'a> {
    text: &'a str,
    visits: &'a Cell<u32>,
}
#[test]
fn enabled_cache_serves_borrowed_nonserde_nonclone_results_without_an_effect() {
    let text = String::from("borrowed result");
    let visits = Cell::new(1);
    let value = Rc::new(ResultValue {
        text: &text,
        visits: &visits,
    });
    let knob: ResilientCall<'_, &str, ResultValue<'_>, ()> = ResilientCall::new(Config {
        cache: Some(CacheConfig { ttl_ms: 20.0 }),
        ..Config::default()
    });
    let initial = knob.init();
    let mut started = knob
        .attempt(&initial, "key", CallValue::value("first"), 10.0)
        .unwrap();
    assert_eq!(started.commands.len(), 1);
    let edge = demlik_tea::command::CommandEdge::new(|| 11.0);
    let message = demlik_tea::command::CommandFamily::settle_in(
        started.commands.pop().unwrap(),
        Some(demlik_tea::command::Outcome::ok(CallValue::shared(
            value.clone(),
        ))),
        &edge,
    )
    .unwrap()
    .pop()
    .unwrap();
    let settled = knob.settle_message(&started.state, message).unwrap();
    assert!(
        matches!(&settled.outcome,SettleOutcome::Done{value:CallValue::Shared(result)} if Rc::ptr_eq(result,&value))
    );
    let cached = knob
        .attempt(&settled.call, "key", CallValue::value("second"), 30.0)
        .unwrap();
    assert!(cached.commands.is_empty());
    let Some(CallPhase::Succeeded {
        result: CallValue::Shared(hit),
    }) = cached.state.call("key")
    else {
        panic!("cached success")
    };
    assert!(Rc::ptr_eq(hit, &value));
    visits.set(7);
    assert_eq!(hit.visits.get(), 7);
    assert_eq!(hit.text, "borrowed result");
    let expired = knob
        .attempt(&cached.state, "key", CallValue::value("third"), 31.0)
        .unwrap();
    assert_eq!(expired.commands.len(), 1);
    assert!(initial.call("key").is_none());
}

#[test]
fn failure_closes_the_charging_segment_and_records_one_shared_retry_streak() {
    use demlik_tea::resilience::circuit_breaker::CircuitState;
    use demlik_tea::resilience::resilient_call::{CallFailure, CircuitConfig, DeadlineConfig};
    use demlik_tea::retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy};
    let config = Config {
        retry: Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 10.0,
                factor: 2.0,
                cap_ms: 100.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 3.0 },
        }),
        deadline: Some(DeadlineConfig { ms: 50.0 }),
        circuit: Some(CircuitConfig {
            threshold: 2.0,
            cooldown_ms: 10.0,
            half_open_max_probes: 1.0,
        }),
        ..Config::default()
    };
    let knob: ResilientCall<'_, &str, &str, &str> = ResilientCall::new(config).with_rng(|| 0.5);
    let started = knob
        .attempt(&knob.init(), "key", CallValue::value("first"), 0.0)
        .unwrap();
    let failed = knob
        .settle(
            &started.state,
            SettleInput::err("key", CallFailure::external("offline"), 10.0),
        )
        .unwrap();
    assert!(matches!(failed.outcome, SettleOutcome::Retrying));
    assert!(failed.commands.is_empty());
    assert!(
        matches!(failed.call.call("key"),Some(CallPhase::WaitingRetry{retry_at_ms,budget,..}) if *retry_at_ms==30.0 && budget.remaining_ms==40.0 && budget.charging_since_ms==10.0)
    );
    assert!(
        matches!(failed.call.snapshot().circuit,CircuitState::Closed{failures} if failures==1.0)
    );
    assert!(
        matches!(started.state.call("key"),Some(CallPhase::Running{budget,..}) if budget.remaining_ms==50.0)
    );
}

#[test]
fn rate_limit_runs_before_an_eligible_half_open_probe() {
    use demlik_tea::resilience::{
        circuit_breaker::CircuitState,
        resilient_call::{CircuitConfig, RateLimitConfig, State},
    };
    use demlik_tea::retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy};
    let config = Config {
        retry: Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 10.0,
                factor: 2.0,
                cap_ms: 100.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 3.0 },
        }),
        circuit: Some(CircuitConfig {
            threshold: 1.0,
            cooldown_ms: 10.0,
            half_open_max_probes: 1.0,
        }),
        rate_limit: Some(RateLimitConfig {
            capacity: 0.0,
            refill_per_sec: 0.0,
        }),
        ..Config::default()
    };
    let knob: ResilientCall<'_, &str, &str, &str> = ResilientCall::new(config);
    let mut snapshot = knob.init().snapshot().clone();
    snapshot.circuit = CircuitState::Open {
        opened_at_ms: 0.0.into(),
    };
    let attempt = knob
        .attempt(
            &State::from_snapshot(snapshot),
            "key",
            CallValue::value("input"),
            100.0,
        )
        .unwrap();
    assert!(attempt.commands.is_empty());
    assert!(
        matches!(attempt.state.call("key"),Some(CallPhase::WaitingRetry{retry_at_ms,..}) if *retry_at_ms==120.0)
    );
    assert!(
        matches!(attempt.state.snapshot().circuit,CircuitState::Open{opened_at_ms} if opened_at_ms==0.0)
    );
}

#[test]
fn resume_excludes_downtime_and_a_spent_retry_budget_emits_no_more_work() {
    use demlik_tea::resilience::{
        deadline::deadline_exceeded,
        resilient_call::{CallFailure, DeadlineConfig},
    };
    use demlik_tea::retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy};
    let config = Config {
        name: "fetch".into(),
        retry: Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 10.0,
                factor: 2.0,
                cap_ms: 100.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 3.0 },
        }),
        deadline: Some(DeadlineConfig { ms: 50.0 }),
        ..Config::default()
    };
    let knob: ResilientCall<'_, &str, &str, &str> = ResilientCall::new(config);
    let started = knob
        .attempt(&knob.init(), "key", CallValue::value("first"), 0.0)
        .unwrap();
    let failed = knob
        .settle(
            &started.state,
            SettleInput::err("key", CallFailure::external("offline"), 10.0),
        )
        .unwrap();
    let resumed = knob.resume(&failed.call, 1000.0);
    assert!(
        matches!(resumed.call("key"),Some(CallPhase::WaitingRetry{budget,..}) if budget.remaining_ms==40.0&&budget.charging_since_ms==1000.0)
    );
    let deadlines = knob.deadlines(&resumed);
    assert_eq!(
        deadlines
            .iter()
            .map(|deadline| deadline.at_ms)
            .collect::<Vec<_>>(),
        [30.0, 1040.0]
    );
    let timer = knob.timer(&resumed).unwrap();
    assert_eq!(timer.ms, 0.0);
    assert_eq!(timer.msg.kind, "fetch_deadline");
    let retried = knob
        .on_timer(
            &resumed,
            &deadline_exceeded("fetch:retry:key", 1000.0, Some("fetch")),
        )
        .unwrap();
    assert_eq!(retried.commands.len(), 1);
    let failed = knob
        .settle(
            &retried.state,
            SettleInput::err("key", CallFailure::external("still offline"), 1010.0),
        )
        .unwrap();
    let spent = knob
        .on_timer(
            &failed.call,
            &deadline_exceeded("fetch:retry:key", 1050.0, Some("fetch")),
        )
        .unwrap();
    assert!(spent.commands.is_empty());
    assert!(
        matches!(spent.state.call("key"),Some(CallPhase::Failed{error}) if matches!(error.as_ref(),CallFailure::DeadlineExceeded{id,at_ms} if id.as_utf8()==Some("fetch:deadline:key")&&*at_ms==1050.0))
    );
    assert!(knob.deadlines(&spent.state).is_empty());
    let stale = knob
        .on_timer(&spent.state, &deadline_exceeded("unrelated", 1050.0, None))
        .unwrap();
    assert!(stale.state.same(&spent.state));
}

#[test]
fn equal_deadlines_follow_record_key_order_and_keep_utf16_keys() {
    use demlik_tea::{data::JsText, resilience::resilient_call::DeadlineConfig};
    let knob: ResilientCall<'_, (), (), ()> = ResilientCall::new(Config {
        deadline: Some(DeadlineConfig { ms: 100.0 }),
        ..Config::default()
    });
    let mut state = knob.init();
    for key in ["10", "2", "a"] {
        state = knob
            .attempt(&state, key, CallValue::value(()), 0.0)
            .unwrap()
            .state;
    }
    let deadlines = knob.deadlines(&state);
    assert_eq!(
        deadlines
            .iter()
            .map(|deadline| deadline.id.as_utf8().unwrap())
            .collect::<Vec<_>>(),
        [
            "resilient:deadline:2",
            "resilient:deadline:10",
            "resilient:deadline:a"
        ]
    );
    assert_eq!(
        knob.timer(&state).unwrap().msg.id.as_utf8(),
        Some("resilient:deadline:2")
    );
    let key = JsText::from_units(vec![0xd800]);
    state = knob
        .attempt(&state, key, CallValue::value(()), 0.0)
        .unwrap()
        .state;
    assert_eq!(
        knob.deadlines(&state).last().unwrap().id.as_units().last(),
        Some(&0xd800)
    );
}

#[test]
fn stored_models_keep_utf16_payloads_and_resume_after_json_reload() {
    use demlik_tea::{
        PlainData,
        data::{JsText, decode_json},
        resilience::resilient_call::{DeadlineConfig, State},
    };
    let knob: ResilientCall<'_, PlainData, PlainData, PlainData> = ResilientCall::new(Config {
        deadline: Some(DeadlineConfig { ms: 50.0 }),
        ..Config::default()
    });
    let key = JsText::from_units(vec![0xd800]);
    let input = decode_json(r#"{"\udfff":"\ud800","overflow":1e400}"#).unwrap();
    let started = knob
        .attempt(&knob.init(), key.clone(), CallValue::value(input), 10.0)
        .unwrap();
    let wire = serde_json::to_string(&started.state).unwrap();
    let restored: State<PlainData, PlainData, PlainData> = serde_json::from_str(&wire).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), wire);
    let resumed = knob.resume(&restored, 1000.0);
    assert_eq!(knob.deadlines(&resumed)[0].at_ms, 1050.0);
    let Some(CallPhase::Running {
        input: CallValue::Shared(input),
        ..
    }) = resumed.call(key)
    else {
        panic!("running restored input")
    };
    let PlainData::Object(fields) = input.as_ref() else {
        panic!("restored input record")
    };
    assert!(
        matches!(fields.get(&JsText::from_units(vec![0xdfff])),Some(PlainData::String(value)) if value.as_units()==[0xd800])
    );
    assert!(matches!(fields.get("overflow"), Some(PlainData::Null)));
}

#[test]
fn undefined_results_and_failures_survive_their_absent_json_fields() {
    use demlik_tea::{
        PlainData,
        resilience::resilient_call::{CallFailure, State},
    };
    let knob: ResilientCall<'_, PlainData, PlainData, PlainData> =
        ResilientCall::new(Config::default());
    let success = knob
        .settle(
            &knob.init(),
            SettleInput::ok("key", CallValue::Undefined, 1.0),
        )
        .unwrap();
    let wire = serde_json::to_value(&success).unwrap();
    assert_eq!(wire["outcome"], serde_json::json!({"kind":"done"}));
    assert_eq!(
        wire["call"]["calls"]["key"],
        serde_json::json!({"phase":"succeeded"})
    );
    let failure = knob
        .settle(
            &knob.init(),
            SettleInput::err("key", CallFailure::Undefined, 2.0),
        )
        .unwrap();
    let wire = serde_json::to_value(&failure).unwrap();
    assert_eq!(wire["outcome"], serde_json::json!({"kind":"failed"}));
    let text = serde_json::to_string(&failure.call).unwrap();
    let restored: State<PlainData, PlainData, PlainData> = serde_json::from_str(&text).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), text);
}

#[test]
fn restored_external_failures_keep_fields_beyond_internal_error_shapes() {
    use demlik_tea::{PlainData, resilience::resilient_call::CallFailure};
    for wire in [
        r#"{"_tag":"deadline_exceeded","id":"handler","atMs":null,"cause":{"\ud800":"\udfff"}}"#,
        r#"{"_tag":"malformed_result","issues":[{"path":"payload","message":"invalid"}],"cause":{"body":[0,255]}}"#,
        r#"{"_tag":"malformed_result","issues":[{"path":"payload","message":"invalid","cause":"retain"}]}"#,
    ] {
        let restored: CallFailure<PlainData> = serde_json::from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&restored).unwrap(), wire);
    }
}

#[test]
fn a_projection_decode_failure_retains_its_exact_raw_value_and_cause() {
    use demlik_tea::{
        PlainData,
        js_record::{JsAccessError, JsRead, RecordCodec},
    };
    let raw = demlik_tea::data::decode_json(r#"{"\ud800":1e400}"#).unwrap();
    let hash = demlik_tea::structural_hash(&raw);
    let codec: RecordCodec<'_, CallValue<ResultValue<'_>>> = RecordCodec::new(
        |_| panic!("a projected read must not encode an existing typed value"),
        |_| {
            Err(JsAccessError {
                name: "ResultDecodeError",
                message: "expected a typed service result".into(),
            })
        },
    );
    let error = match codec.read(JsRead::Projected(raw)) {
        Ok(_) => panic!("caller codec refused this projected value"),
        Err(error) => error,
    };
    assert_eq!(demlik_tea::structural_hash(&error.value), hash);
    assert!(matches!(error.value, PlainData::Object(_)));
    assert_eq!(error.cause.name, "ResultDecodeError");
    assert_eq!(error.cause.message, "expected a typed service result");
}

#[test]
fn a_public_phase_serializes_an_undefined_input_as_an_absent_field() {
    use demlik_tea::resilience::resilient_call::CallBudget;
    let phase: CallPhase<(), (), ()> = CallPhase::Running {
        input: CallValue::Undefined,
        budget: CallBudget {
            remaining_ms: 0.0.into(),
            charging_since_ms: 1.0.into(),
        },
    };
    assert_eq!(
        serde_json::to_value(phase).unwrap(),
        serde_json::json!({
            "phase":"running", "budget":{"remainingMs":0.0,"chargingSinceMs":1.0}
        })
    );
}
