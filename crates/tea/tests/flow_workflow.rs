use demlik_tea::Tagged;
use demlik_tea::durable_effects::EffectLedgerEvent;
use demlik_tea::flow::workflow::{
    ActivityOk, Workflow, WorkflowCmd, WorkflowPhase, WorkflowStep, WorkflowSteps, create_workflow,
};
use std::rc::Rc;
struct Activity<'a> {
    label: &'a str,
    _local: Rc<()>,
}
struct Answer(u32);
struct Failure;
#[test]
fn an_activity_success_confirms_its_delivery_before_owing_the_next_opaque_command() {
    let borrowed_label = String::from("reserve");
    let activity = |label| {
        Rc::new(Activity {
            label,
            _local: Rc::new(()),
        })
    };
    let first = Rc::new(WorkflowStep::new("first", activity(&borrowed_label)));
    let second = Rc::new(WorkflowStep::new("second", activity("charge")));
    let steps = WorkflowSteps::new(Rc::clone(&first), [Rc::clone(&second)]);
    let workflow: Workflow<Activity, Answer, Failure> = create_workflow(Default::default());
    let started = workflow.init(&steps).unwrap();
    assert!(matches!(
        started.state.status,
        WorkflowPhase::Running { .. }
    ));
    assert_eq!(started.state.current().unwrap().id.number(), Some(1.0));
    assert!(Rc::ptr_eq(&started.state.current().unwrap().step, &first));
    let EffectLedgerEvent::Owed(owed) = started.ledger[0].as_ref() else {
        panic!("first activity is owed")
    };
    assert!(Rc::ptr_eq(&owed.effect, &started.cmds[0]));
    let result = Rc::new(Answer(7));
    let advanced = workflow
        .on_activity_ok(
            &started.state,
            &ActivityOk::new(1.0.into(), Rc::clone(&result)),
        )
        .unwrap();
    assert_eq!(
        advanced
            .ledger
            .iter()
            .map(|event| event.tag())
            .collect::<Vec<_>>(),
        vec!["effect_confirmed", "effect_owed"]
    );
    assert_eq!(advanced.state.current().unwrap().id.number(), Some(2.0));
    assert!(Rc::ptr_eq(&advanced.state.completed[0].step, &first));
    assert!(Rc::ptr_eq(
        advanced.state.completed[0].result.value().unwrap(),
        &result
    ));
    let WorkflowCmd::Activity(command) = advanced.cmds[0].as_ref() else {
        panic!("next forward command")
    };
    assert_eq!(command.input().activity.value().unwrap().label, "charge");
    assert_eq!(command.input().index.number(), Some(1.0));
    assert!(started.state.completed.is_empty());
    let done = workflow
        .on_activity_ok(
            &advanced.state,
            &ActivityOk::new(2.0.into(), Rc::new(Answer(9))),
        )
        .unwrap();
    assert!(
        matches!(&done.state.status,WorkflowPhase::Completed{output} if output.value().unwrap().0==9)
    );
    assert!(done.cmds.is_empty());
    assert_eq!(done.ledger.len(), 1);
    let duplicate = workflow
        .on_activity_ok(
            &done.state,
            &ActivityOk::new(2.0.into(), Rc::new(Answer(99))),
        )
        .unwrap();
    assert!(Rc::ptr_eq(&duplicate.state, &done.state));
    assert!(duplicate.ledger.is_empty());
    assert!(duplicate.cmds.is_empty());
}

#[test]
fn rollback_skips_undefined_compensation_and_preserves_both_failures_when_an_inverse_fails() {
    use demlik_tea::flow::workflow::{ActivityErr, CompensationErr, CompensationOk, WorkflowValue};
    struct Fault(&'static str);
    let activity = |label| {
        Rc::new(Activity {
            label,
            _local: Rc::new(()),
        })
    };
    let step = |name, undo: Option<&'static str>| {
        Rc::new(WorkflowStep::new(name, activity(name)).with_compensation(
            undo.map_or(WorkflowValue::Undefined, |undo| {
                WorkflowValue::Value(activity(undo))
            }),
        ))
    };
    let first = step("first", Some("undo-first"));
    let skipped = step("no-inverse", None);
    let third = step("third", Some("undo-third"));
    let failed = step("failed", Some("never-undo-failed"));
    let steps = WorkflowSteps::new(
        Rc::clone(&first),
        [skipped, Rc::clone(&third), Rc::clone(&failed)],
    );
    let workflow: Workflow<Activity, Answer, Fault> = create_workflow(Default::default());
    let mut state = workflow.init(&steps).unwrap().state;
    for id in 1..=3 {
        state = workflow
            .on_activity_ok(
                &state,
                &ActivityOk::new((id as f64).into(), Rc::new(Answer(id))),
            )
            .unwrap()
            .state;
    }
    let original = Rc::new(Fault("forward"));
    let pivot = workflow
        .on_activity_err(&state, &ActivityErr::new(4.0.into(), Rc::clone(&original)))
        .unwrap();
    assert_eq!(
        pivot
            .ledger
            .iter()
            .map(|event| event.tag())
            .collect::<Vec<_>>(),
        vec!["effect_confirmed", "effect_owed"]
    );
    let WorkflowCmd::Compensation(command) = pivot.cmds[0].as_ref() else {
        panic!("rollback command")
    };
    assert_eq!(command.input().index.number(), Some(2.0));
    assert_eq!(
        command.input().compensation.value().unwrap().label,
        "undo-third"
    );
    assert_eq!(pivot.state.current().unwrap().id.number(), Some(5.0));
    let next = workflow
        .on_compensation_ok(&pivot.state, &CompensationOk { id: 5.0.into() })
        .unwrap();
    let WorkflowCmd::Compensation(command) = next.cmds[0].as_ref() else {
        panic!("next inverse")
    };
    assert_eq!(command.input().index.number(), Some(0.0));
    assert_eq!(
        command.input().compensation.value().unwrap().label,
        "undo-first"
    );
    let inverse_error = Rc::new(Fault("inverse"));
    let halted = workflow
        .on_compensation_err(
            &next.state,
            &CompensationErr::new(6.0.into(), Rc::clone(&inverse_error)),
        )
        .unwrap();
    let WorkflowPhase::CompensationFailed {
        failure,
        compensated,
        failed_compensation_step,
        compensation_failure,
    } = &halted.state.status
    else {
        panic!("failed inverse is terminal")
    };
    assert!(Rc::ptr_eq(&failure.failed_step, &failed));
    assert!(Rc::ptr_eq(failure.failure.value().unwrap(), &original));
    assert_eq!(failure.failure.value().unwrap().0, "forward");
    assert_eq!(compensated.len(), 1);
    assert!(Rc::ptr_eq(&compensated[0].step, &third));
    assert!(Rc::ptr_eq(failed_compensation_step, &first));
    assert!(Rc::ptr_eq(
        compensation_failure.value().unwrap(),
        &inverse_error
    ));
    assert!(halted.cmds.is_empty());
    assert_eq!(halted.ledger.len(), 1);
    let late = workflow
        .on_compensation_ok(&halted.state, &CompensationOk { id: 6.0.into() })
        .unwrap();
    assert!(Rc::ptr_eq(&late.state, &halted.state));
    assert!(late.ledger.is_empty());
}

#[test]
fn a_present_null_inverse_survives_restore_and_replay_while_undefined_is_skipped() {
    use demlik_tea::PlainData;
    use demlik_tea::flow::workflow::{
        ActivityErr, CompensationOk, WorkflowMsg, WorkflowValue, fold_workflow, route_workflow_msg,
    };
    let first = Rc::new(
        WorkflowStep::new(
            "null-inverse",
            Rc::new(PlainData::String("do-first".into())),
        )
        .with_compensation(WorkflowValue::Value(Rc::new(PlainData::Null))),
    );
    let second = Rc::new(
        WorkflowStep::new(
            "undefined-inverse",
            Rc::new(PlainData::String("do-second".into())),
        )
        .with_compensation(WorkflowValue::Undefined),
    );
    let last = Rc::new(WorkflowStep::new(
        "fails",
        Rc::new(PlainData::String("do-last".into())),
    ));
    let steps = WorkflowSteps::new(first, [second, last]);
    let messages = vec![
        WorkflowMsg::ActivityOk(ActivityOk::new(1.0.into(), Rc::new(PlainData::Undefined))),
        WorkflowMsg::ActivityOk(ActivityOk::new(2.0.into(), Rc::new(PlainData::Null))),
        WorkflowMsg::ActivityErr(ActivityErr::new(3.0.into(), Rc::new(PlainData::Null))),
        WorkflowMsg::CompensationOk(CompensationOk { id: 4.0.into() }),
    ];
    let workflow: Workflow<PlainData, PlainData, PlainData> = create_workflow(Default::default());
    let started = workflow.init(&steps).unwrap();
    let mut state = started.state;
    let mut log = started.ledger;
    for message in &messages[..3] {
        let step = route_workflow_msg(&workflow, &state, message).unwrap();
        state = step.state;
        log.extend(step.ledger);
    }
    let survivors = workflow.surviving_activities(&log);
    assert_eq!(survivors.len(), 1);
    let WorkflowCmd::Compensation(command) = survivors[0].as_ref() else {
        panic!("null is a declared inverse")
    };
    assert!(matches!(
        command.input().compensation.value().unwrap().as_ref(),
        PlainData::Null
    ));
    assert_eq!(command.input().index.number(), Some(0.0));
    assert_eq!(command.input().id.number(), Some(4.0));
    let restored: Workflow<PlainData, PlainData, PlainData> =
        create_workflow(demlik_tea::durable_effects::LedgerRestore::from_events(log));
    let terminal = route_workflow_msg(&restored, &state, &messages[3]).unwrap();
    assert!(matches!(
        terminal.state.status,
        WorkflowPhase::FailedCompensated { .. }
    ));
    assert!(terminal.cmds.is_empty());
    let replayed = fold_workflow(&steps, &messages).unwrap();
    assert!(matches!(
        replayed.status,
        WorkflowPhase::FailedCompensated { .. }
    ));
    assert_eq!(replayed.completed.len(), 2);
}

#[test]
fn both_transport_definitions_turn_a_nonvoid_success_into_a_malformed_result() {
    use demlik_tea::flow::workflow::{
        WorkflowActivityInput, WorkflowCompensationInput, WorkflowValue, workflow_activity_def,
        workflow_compensation_def,
    };
    use demlik_tea::{
        PlainData,
        command::{Cmd, CommandFamily, CommandSpec, Failure, Outcome, Settlement},
    };
    fn check<D: CommandSpec<RawOutput = PlainData>>(command: Cmd<D>, tag: &str)
    where
        D::Error: serde::Serialize,
    {
        let mut messages =
            CommandFamily::settle(command, Some(Outcome::ok(PlainData::Null)), 17.25).unwrap();
        assert_eq!(messages.len(), 1);
        let message = messages.pop().unwrap();
        assert_eq!(message.tag(), tag);
        assert_eq!(message.at(), Some(17.25));
        let Settlement::Err(Failure::Malformed(error)) = message.outcome() else {
            panic!("malformed transport success")
        };
        assert_eq!(error.issues.len(), 1);
        assert_eq!(error.issues[0].path, "");
        assert_eq!(error.issues[0].message, "expected no value");
    }
    let payload = Rc::new(Activity {
        label: "opaque",
        _local: Rc::new(()),
    });
    check(
        workflow_activity_def().from_record(WorkflowActivityInput {
            index: 0.0.into(),
            id: 1.0.into(),
            activity: WorkflowValue::Value(Rc::clone(&payload)),
        }),
        "workflow_activity_err",
    );
    check(
        workflow_compensation_def().from_record(WorkflowCompensationInput {
            index: 0.0.into(),
            id: 2.0.into(),
            compensation: WorkflowValue::Value(payload),
        }),
        "workflow_compensation_err",
    );
}

#[test]
fn json_restore_keeps_omitted_values_and_null_delivery_ids_until_a_new_transition_writes_them() {
    use demlik_tea::flow::workflow::{ActivityErr, CompensationOk, WorkflowState, WorkflowValue};
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        durable_effects::LedgerRestore,
        work_queue::QueueField,
    };
    let first = Rc::new(
        WorkflowStep::new("opaque-to-json", Rc::new(PlainData::Undefined))
            .with_compensation(WorkflowValue::Value(Rc::new(PlainData::Null))),
    );
    let second = Rc::new(WorkflowStep::new(
        "next",
        Rc::new(PlainData::String("next".into())),
    ));
    let steps = WorkflowSteps::new(first, [second]);
    let workflow: Workflow<PlainData, PlainData, PlainData> = create_workflow(LedgerRestore {
        last_id: QueueField::Value(f64::INFINITY.into()),
        ..Default::default()
    });
    let started = workflow.init(&steps).unwrap();
    let advanced = workflow
        .on_activity_ok(
            &started.state,
            &ActivityOk::new(f64::INFINITY.into(), Rc::new(PlainData::Undefined)),
        )
        .unwrap();
    let mut log = started.ledger;
    log.extend(advanced.ledger);
    let encoded = stringify_json(&plain_data(&advanced.state).unwrap()).unwrap();
    let state = Rc::new(
        serde_json::from_str::<WorkflowState<PlainData, PlainData, PlainData>>(&encoded).unwrap(),
    );
    assert_eq!(state.current().unwrap().id.number(), None);
    assert!(state.completed[0].result.is_absent());
    assert!(state.steps[0].activity.is_absent());
    assert_eq!(
        stringify_json(&plain_data(&state).unwrap()).unwrap(),
        encoded
    );
    let encoded_log = stringify_json(&plain_data(&log).unwrap()).unwrap();
    let log: Vec<Rc<EffectLedgerEvent<WorkflowCmd<PlainData>>>> =
        serde_json::from_str(&encoded_log).unwrap();
    let restored: Workflow<PlainData, PlainData, PlainData> =
        create_workflow(LedgerRestore::from_events(log.iter().cloned()));
    assert_eq!(restored.surviving_activities(&log).len(), 1);
    let pivot = restored
        .on_activity_err(
            &state,
            &ActivityErr::new(
                demlik_tea::durable_effects::DeliveryId(None),
                Rc::new(PlainData::Undefined),
            ),
        )
        .unwrap();
    assert_eq!(pivot.state.current().unwrap().id.number(), Some(1.0));
    let encoded = stringify_json(&plain_data(&pivot.state).unwrap()).unwrap();
    let state = Rc::new(
        serde_json::from_str::<WorkflowState<PlainData, PlainData, PlainData>>(&encoded).unwrap(),
    );
    let done = restored
        .on_compensation_ok(&state, &CompensationOk { id: 1.0.into() })
        .unwrap();
    assert!(matches!(
        done.state.status,
        WorkflowPhase::FailedCompensated { .. }
    ));
    let PlainData::Object(record) = plain_data(&done.state).unwrap() else {
        panic!("workflow record")
    };
    assert!(matches!(record.get("failure"), Some(PlainData::Undefined)));
}

#[test]
fn business_messages_keep_missing_undefined_and_null_separate_at_the_json_boundary() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        flow::workflow::{WorkflowMsg, WorkflowValue},
    };
    let message = WorkflowMsg::<PlainData, PlainData>::ActivityOk(ActivityOk {
        id: 1.0.into(),
        result: WorkflowValue::Undefined,
    });
    let PlainData::Object(record) = plain_data(&message).unwrap() else {
        panic!("business message")
    };
    assert!(matches!(record.get("result"), Some(PlainData::Undefined)));
    let encoded = stringify_json(&PlainData::Object(record)).unwrap();
    assert_eq!(encoded, r#"{"type":"activity_ok","id":1}"#);
    let restored: WorkflowMsg<PlainData, PlainData> = serde_json::from_str(&encoded).unwrap();
    let WorkflowMsg::ActivityOk(restored) = restored else {
        panic!("success")
    };
    assert!(restored.result.is_absent());
    let restored: WorkflowMsg<PlainData, PlainData> =
        serde_json::from_str(r#"{"type":"compensation_err","id":null,"failure":null}"#).unwrap();
    let WorkflowMsg::CompensationErr(restored) = restored else {
        panic!("inverse error")
    };
    assert_eq!(restored.id.number(), None);
    assert!(matches!(
        restored.failure.value().unwrap().as_ref(),
        PlainData::Null
    ));
}
