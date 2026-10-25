use demlik_tea::{
    PlainData,
    command::{Cmd, CmdDef, CommandFamily, CommandSpec, Outcome, Settlement},
    flow::workflow::{
        WorkflowActivityInput, WorkflowCompensationInput, WorkflowValue, workflow_activity_def,
        workflow_compensation_def,
    },
    persistence::snapshot::{SnapshotWriteInput, snapshot_write_def},
};
use std::rc::Rc;

fn persisted_ack<D>(command: Cmd<D>)
where
    D: CommandSpec<RawOutput = PlainData, Output = PlainData>,
    D::Input: serde::de::DeserializeOwned + serde::Serialize,
    D::Error: serde::de::DeserializeOwned + serde::Serialize,
{
    let messages =
        CommandFamily::settle(command, Some(Outcome::ok(PlainData::Undefined)), 17.25).unwrap();
    let encoded = serde_json::to_value(&messages[0]).unwrap();
    assert!(!encoded.as_object().unwrap().contains_key("value"));

    let restored = CmdDef::<D>::new().restore_settled(encoded.clone()).unwrap();
    assert!(matches!(
        restored.outcome(),
        Settlement::Ok(PlainData::Undefined)
    ));
    assert_eq!(restored.at(), Some(17.25));
    assert_eq!(serde_json::to_value(restored).unwrap(), encoded);
}

#[test]
fn persisted_workflow_and_checkpoint_acknowledgements_restore_after_json_omits_undefined() {
    persisted_ack(workflow_activity_def().from_record(WorkflowActivityInput {
        index: 0.0.into(),
        id: 1.0.into(),
        activity: WorkflowValue::Value(Rc::new(PlainData::String("send".into()))),
    }));
    persisted_ack(
        workflow_compensation_def().from_record(WorkflowCompensationInput {
            index: 0.0.into(),
            id: 2.0.into(),
            compensation: WorkflowValue::Value(Rc::new(PlainData::Null)),
        }),
    );
    persisted_ack(snapshot_write_def().from_record(SnapshotWriteInput {
        key: "bot".into(),
        seq: 1.0,
        at: 17.0,
        payload: Rc::new(PlainData::String("saved".into())),
    }));
}
