use demlik_tea::{
    PlainData, Tagged,
    agent::snapshot::{AgentSnapshotWrite, SnapshotProfile, WithSnapshot},
    command::{CommandEdge, CommandFamily},
    persistence::snapshot::{SnapshotWriteInput, snapshot_write_def},
};
use std::{cell::Cell, rc::Rc};

// Contract: the Agent writer receives the actual monitored-run command owner.
// Risk: reconstructing it loses the original payload handle or command metadata.
// Prior leaf Snapshot tests never cross the Agent's plain-writer boundary.
#[test]
fn plain_adapter_preserves_original_command_data_and_payload_handle() {
    let payload = Rc::new(PlainData::Undefined);
    let command = snapshot_write_def().from_record(SnapshotWriteInput::new(
        "invoice-checkpoint",
        7.0,
        17.25,
        Rc::clone(&payload),
    ));
    let wire = serde_json::to_string(&command).unwrap();
    let adapted = WithSnapshot::command(command).unwrap();
    assert_eq!(adapted.tag(), "snapshot_write");
    assert!(Rc::ptr_eq(&adapted.command().input().payload, &payload));
    assert_eq!(serde_json::to_string(&adapted).unwrap(), wire);
    let original = adapted.into_command();
    assert!(Rc::ptr_eq(&original.input().payload, &payload));
    assert_eq!(serde_json::to_string(&original).unwrap(), wire);
}

// Contract: a plain completion has no acknowledgment or settlement timestamp.
// Risk: registering SnapshotWriteSpec would mint a message and read the clock.
// Existing defined Snapshot tests intentionally exercise that different contract.
#[test]
fn plain_completion_does_not_read_clock_or_mint_a_snapshot_ack() {
    let clock_reads = Rc::new(Cell::new(0));
    let count = Rc::clone(&clock_reads);
    let edge = CommandEdge::new(move || {
        count.set(count.get() + 1);
        99.0
    });
    let command: AgentSnapshotWrite =
        WithSnapshot::command(snapshot_write_def().from_record(SnapshotWriteInput::new(
            "invoice-checkpoint",
            1.0,
            17.25,
            Rc::new(PlainData::Undefined),
        )))
        .unwrap();
    assert!(!command.is_defined());
    assert!(command.settle_in((), &edge).unwrap().is_empty());
    assert_eq!(clock_reads.get(), 0);
}
