use demlik_tea::flow::saga::{Saga, SagaConfig, SagaPhase, SagaStep, create_saga};
use demlik_tea::work_queue::QueueItemStatus;
use std::rc::Rc;
struct Forward<'a> {
    label: &'a str,
    _local: Rc<()>,
}
struct Undo<'a> {
    label: &'a str,
    _local: Rc<()>,
}
struct Fault(&'static str);
#[test]
fn a_failed_inverse_preserves_both_failures_and_the_uncompensated_log() {
    let reserve = String::from("reserve");
    let charge = String::from("charge");
    let step = |label, undo| {
        SagaStep::new(
            Rc::new(Forward {
                label,
                _local: Rc::new(()),
            }),
            Rc::new(Undo {
                label: undo,
                _local: Rc::new(()),
            }),
        )
    };
    let saga: Saga<Forward<'_>, Undo<'_>, Fault> = create_saga(SagaConfig {
        steps: vec![
            step(&reserve, "release"),
            step(&charge, "refund"),
            step("ship", "unship"),
        ],
    });
    let initial = saga.init();
    let started = saga.start(&initial);
    assert_eq!(started.commands[0].label, "reserve");
    assert!(initial.items.is_empty());
    let charged = saga.step_ok(&started.state);
    assert_eq!(charged.commands[0].label, "charge");
    let shipped = saga.step_ok(&charged.state);
    assert_eq!(shipped.commands[0].label, "ship");
    let forward = Rc::new(Fault("shipment unavailable"));
    let pivot = saga.step_err(&shipped.state, Rc::clone(&forward));
    assert_eq!(pivot.state.phase, SagaPhase::Compensating);
    assert_eq!(pivot.commands[0].label, "refund");
    assert_eq!(
        pivot
            .state
            .done
            .iter()
            .map(|id| id.number())
            .collect::<Vec<_>>(),
        vec![Some(0.0), Some(1.0)]
    );
    assert_eq!(
        pivot.state.items.get(2).unwrap().status,
        QueueItemStatus::Failed
    );
    let inverse = Rc::new(Fault("refund unavailable"));
    let halted = saga.undo_err(&pivot.state, Rc::clone(&inverse));
    assert_eq!(halted.state.phase, SagaPhase::CompensationFailed);
    assert!(halted.commands.is_empty());
    assert!(Rc::ptr_eq(halted.state.error.value().unwrap(), &forward));
    assert!(Rc::ptr_eq(
        halted.state.compensation_error.value().unwrap(),
        &inverse
    ));
    assert_eq!(
        halted.state.error.value().unwrap().0,
        "shipment unavailable"
    );
    assert_eq!(halted.state.done.len(), 2);
    assert_eq!(
        halted.state.items.get(0).unwrap().status,
        QueueItemStatus::Done
    );
    assert_eq!(
        halted.state.items.get(1).unwrap().status,
        QueueItemStatus::Failed
    );
    let late = saga.undo_ok(&halted.state);
    assert!(Rc::ptr_eq(&late.state, &halted.state));
    assert!(late.commands.is_empty());
    assert_eq!(
        pivot.state.items.get(1).unwrap().status,
        QueueItemStatus::Done
    );
}

#[test]
fn forward_commit_full_reverse_and_empty_transactions_have_distinct_terminal_states() {
    use demlik_tea::flow::saga::{is_aborted, is_committed, is_compensation_failed, is_settled};
    let saga: Saga<u8, u8, Fault> = create_saga(SagaConfig {
        steps: vec![
            SagaStep::new(Rc::new(10), Rc::new(11)),
            SagaStep::new(Rc::new(20), Rc::new(21)),
            SagaStep::new(Rc::new(30), Rc::new(31)),
        ],
    });
    let first = saga.start(&saga.init());
    let second = saga.step_ok(&first.state);
    let third = saga.step_ok(&second.state);
    let committed = saga.step_ok(&third.state);
    assert!(is_committed(&committed.state));
    assert!(is_settled(&committed.state));
    assert!(!is_aborted(&committed.state));
    assert!(!is_compensation_failed(&committed.state));
    assert!(committed.commands.is_empty());
    assert_eq!(committed.state.position.number(), Some(2.0));
    let rolling = saga.step_err(&third.state, Rc::new(Fault("ship")));
    assert_eq!(*rolling.commands[0], 21);
    let last = saga.undo_ok(&rolling.state);
    assert_eq!(*last.commands[0], 11);
    let aborted = saga.undo_ok(&last.state);
    assert!(is_aborted(&aborted.state));
    assert!(is_settled(&aborted.state));
    assert!(aborted.state.done.is_empty());
    assert_eq!(
        aborted
            .state
            .items
            .iter()
            .map(|item| item.status)
            .collect::<Vec<_>>(),
        vec![
            QueueItemStatus::Cancelled,
            QueueItemStatus::Cancelled,
            QueueItemStatus::Failed
        ]
    );
    assert!(Rc::ptr_eq(
        &saga.start(&aborted.state).state,
        &aborted.state
    ));
    assert!(Rc::ptr_eq(
        &saga.step_ok(&committed.state).state,
        &committed.state
    ));
    let empty: Saga<u8, u8, Fault> = create_saga(SagaConfig::default());
    let empty = empty.start(&empty.init());
    assert!(is_committed(&empty.state));
    assert!(empty.commands.is_empty());
    assert!(empty.state.items.is_empty());
}

#[test]
fn json_restore_preserves_spread_fields_and_keeps_a_dropped_error_absent_during_undo_failure() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        flow::saga::SagaState,
    };
    let saga: Saga<u8, u8> = create_saga(SagaConfig {
        steps: vec![
            SagaStep::new(Rc::new(10), Rc::new(11)),
            SagaStep::new(Rc::new(20), Rc::new(21)),
        ],
    });
    let encoded = r#"{"position":1,"done":[0],"compensating":false,"phase":"running","compensationError":null,"items":[],"trailing":"keep"}"#;
    let restored = Rc::new(serde_json::from_str::<SagaState>(encoded).unwrap());
    let pivot = saga.step_err(&restored, Rc::new(PlainData::Undefined));
    let PlainData::Object(record) = plain_data(&pivot.state).unwrap() else {
        panic!("saga state")
    };
    assert!(matches!(record.get("error"), Some(PlainData::Undefined)));
    let encoded = stringify_json(&plain_data(&pivot.state).unwrap()).unwrap();
    assert_eq!(
        encoded,
        r#"{"position":0,"done":[0],"compensating":true,"phase":"compensating","compensationError":null,"items":[],"trailing":"keep"}"#
    );
    let restored = Rc::new(serde_json::from_str::<SagaState>(&encoded).unwrap());
    assert!(restored.error.is_absent());
    let halted = saga.undo_err(&restored, Rc::new(PlainData::Null));
    let PlainData::Object(record) = plain_data(&halted.state).unwrap() else {
        panic!("saga state")
    };
    assert!(!record.contains_key("error"));
    assert!(matches!(
        record.get("compensationError"),
        Some(PlainData::Null)
    ));
    assert!(
        matches!(record.get("trailing"),Some(PlainData::String(value))if value.as_utf8()==Some("keep"))
    );
}
