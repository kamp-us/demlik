use demlik_tea::idempotency::intake::{Cmd, Config, Intake, IntakeValue};
use std::rc::Rc;

struct Payload<'a> {
    key: &'a str,
    local: Rc<()>,
}
struct ResultValue(Box<dyn Fn() -> u32>);

#[test]
fn slow_pending_work_never_expires_and_a_completed_result_replays_by_identity() {
    let key = String::from("payment");
    let intake = Intake::new(Config::new(|p: &Payload<'_>| Ok(p.key.into())).with_ttl(10.0));
    let payload = Rc::new(Payload {
        key: &key,
        local: Rc::new(()),
    });
    let first = intake
        .receive(&intake.init(), payload.clone(), 0.0, "q1")
        .unwrap();
    let Cmd::Process(command) = &first.commands[0] else {
        panic!("new work")
    };
    assert!(Rc::ptr_eq(&command.input().payload, &payload));
    assert_eq!(Rc::strong_count(&payload.local), 1);
    let duplicate = intake
        .receive(&first.state, payload.clone(), f64::INFINITY, "q2")
        .unwrap();
    assert!(Rc::ptr_eq(&duplicate.state, &first.state));
    assert!(duplicate.commands.is_empty());
    let result = Rc::new(ResultValue(Box::new(|| 42)));
    let completed = intake
        .complete(
            &first.state,
            "payment",
            IntakeValue::Value(result.clone()),
            50.0,
        )
        .unwrap();
    assert!(completed.state.queue.ptr_eq(&first.state.queue));
    let replay = intake
        .receive(&completed.state, payload.clone(), 59.0, "q3")
        .unwrap();
    assert!(Rc::ptr_eq(&replay.state, &completed.state));
    let Cmd::Replay(command) = &replay.commands[0] else {
        panic!("cached replay")
    };
    let IntakeValue::Value(cached) = &command.input().result else {
        panic!("cached value")
    };
    assert!(Rc::ptr_eq(cached, &result));
    assert_eq!((cached.0)(), 42);
    let renewed = intake
        .receive(&completed.state, payload, 60.0, "q4")
        .unwrap();
    assert!(matches!(renewed.commands[0], Cmd::Process(_)));
    assert_eq!(renewed.state.queue.len(), 2);
}

#[test]
fn complete_then_crash_is_skipped_by_both_boot_and_claim_beyond_replay_ttl() {
    let intake =
        Intake::<_, u32>::new(Config::new(|p: &String| Ok(p.as_str().into())).with_ttl(1.0));
    let accepted = intake
        .receive(&intake.init(), Rc::new("a".into()), 0.0, "q")
        .unwrap();
    let running = intake.claim_next(&accepted.state, 1.0).unwrap().unwrap();
    let done = intake
        .complete(&running.state, "a", IntakeValue::Value(Rc::new(7)), 2.0)
        .unwrap();
    let boot = intake.boot(&done.state).unwrap();
    assert!(Rc::ptr_eq(&boot.state, &done.state));
    assert!(intake.claim_next(&boot.state, 999.0).unwrap().is_none());
}

#[test]
fn injected_done_entry_replays_opaque_result_and_nested_missing_value_throws() {
    let intake = Intake::new(Config::new(|p: &String| Ok(p.as_str().into())));
    let result = Rc::new(ResultValue(Box::new(|| 9)));
    let completed = intake
        .complete(
            &intake.init(),
            "__proto__",
            IntakeValue::Value(result.clone()),
            0.0,
        )
        .unwrap();
    assert_eq!(completed.state.seen.entries.own_entries().count(), 0);
    let replay = intake
        .receive(&completed.state, Rc::new("__proto__".into()), 1.0, "q")
        .unwrap();
    let Cmd::Replay(command) = &replay.commands[0] else {
        panic!("prototype replay")
    };
    assert!(
        matches!(&command.input().result,IntakeValue::Value(value) if Rc::ptr_eq(value,&result))
    );
    let error = match intake.receive(&completed.state, Rc::new("value".into()), 1.0, "q") {
        Err(error) => error,
        Ok(_) => panic!("nested missing value must fail"),
    };
    let demlik_tea::idempotency::intake::IntakeError::Access(error) = error else {
        panic!("property access failure")
    };
    assert_eq!(
        error.message,
        "Cannot read properties of undefined (reading 'phase')"
    );
}

#[test]
fn reconcile_reads_only_phase_and_expired_receive_needs_no_result_decoder() {
    use demlik_tea::{PlainData, idempotency::intake::State, js_record::JsRecord};
    let intake = Intake::<_, ResultValue>::new(
        Config::new(|p: &String| Ok(p.as_str().into())).with_ttl(1.0),
    );
    let accepted = intake
        .receive(&intake.init(), Rc::new("a".into()), 0.0, "q")
        .unwrap();
    let running = intake.claim_next(&accepted.state, 1.0).unwrap().unwrap();
    let seen = demlik_tea::idempotency::IdempotencyStore {
        entries: JsRecord::from_data([("a".into(), PlainData::from(&serde_json::json!({"value":{"phase":"done","result":{"unparsed":true}},"atMs":0})))].into_iter().collect()),
        ..running.state.seen.as_ref().clone()
    };
    let state = Rc::new(State {
        seen: Rc::new(seen),
        queue: running.state.queue.clone(),
    });
    let boot = intake.boot(&state).unwrap();
    assert!(Rc::ptr_eq(&boot.state, &state));
    assert!(intake.claim_next(&boot.state, 999.0).unwrap().is_none());
    let fresh = intake
        .receive(&state, Rc::new("a".into()), 1.0, "q2")
        .unwrap();
    assert!(matches!(fresh.commands[0], Cmd::Process(_)));
}

#[test]
fn every_key_callback_failure_retains_the_original_opaque_cause() {
    use demlik_tea::idempotency::intake::IntakeError;
    use std::cell::{Cell, RefCell};
    struct Cause(Box<dyn Fn() -> u32>);
    let cause = Rc::new(Cause(Box::new(|| 7)));
    let rejected = cause.clone();
    let fail = Rc::new(Cell::new(false));
    let configured = fail.clone();
    let observed_queue = Rc::new(RefCell::new(None::<demlik_tea::work_queue::Queue<String>>));
    let callback_queue = observed_queue.clone();
    let intake = Intake::<_, u32, _>::new(Config::with_key_error(move |payload: &String| {
        if let Some(queue) = callback_queue.borrow().as_ref() {
            drop(queue.items_mut());
        }
        if configured.get() {
            Err(rejected.clone())
        } else {
            Ok(payload.as_str().into())
        }
    }));
    let accepted = match intake.receive(&intake.init(), Rc::new("a".into()), 0.0, "q") {
        Ok(value) => value,
        Err(_) => panic!("accepted"),
    };
    let running = match intake.claim_next(&accepted.state, 1.0) {
        Ok(Some(value)) => value,
        _ => panic!("claimed"),
    };
    *observed_queue.borrow_mut() = Some(running.state.queue.clone());
    fail.set(true);
    let receive = intake
        .receive(&accepted.state, Rc::new("b".into()), 2.0, "q2")
        .err();
    let boot = intake.boot(&running.state).err();
    *observed_queue.borrow_mut() = Some(accepted.state.queue.clone());
    let claim = intake.claim_next(&accepted.state, 2.0).err();
    let errors = [receive, boot, claim];
    for error in errors {
        let Some(IntakeError::Key(actual)) = error else {
            panic!("same key failure channel")
        };
        assert!(Rc::ptr_eq(&actual, &cause));
        assert_eq!((actual.0)(), 7);
    }
}
