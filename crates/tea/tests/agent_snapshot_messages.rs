use demlik_tea::{
    PlainData, Tagged,
    agent::snapshot::{AgentSnapshotMessages, SnapshotProfile, WithSnapshot},
    command::{CommandEdge, CommandFamily},
    persistence::snapshot::{SnapshotWriteInput, snapshot_write_def},
};
use std::{cell::Cell, rc::Rc};

// The old () adapter cannot expose a dropped/rebuilt/restamped completion.
// Cross the real command-family boundary with borrowed, opaque messages.
#[test]
fn returned_messages_keep_original_owners_order_stamps_and_plain_command() {
    struct Opaque(String);
    struct Message<'a> {
        label: &'a str,
        value: Rc<Opaque>,
        at: f64,
    }
    let text = String::from("borrowed invoice");
    let value = Rc::new(Opaque(text.clone()));
    let payload = Rc::new(PlainData::Undefined);
    let write = snapshot_write_def().from_record(SnapshotWriteInput::new(
        "invoice-checkpoint",
        7.0,
        17.25,
        Rc::clone(&payload),
    ));
    let wire = serde_json::to_string(&write).unwrap();
    let command = AgentSnapshotMessages::from(WithSnapshot::command(write).unwrap());
    assert_eq!(command.tag(), "snapshot_write");
    assert!(!command.is_defined());
    assert!(Rc::ptr_eq(&command.command().input().payload, &payload));
    assert_eq!(serde_json::to_string(&command).unwrap(), wire);
    let reads = Rc::new(Cell::new(0));
    let observed = Rc::clone(&reads);
    let edge = CommandEdge::new(move || {
        observed.set(observed.get() + 1);
        999.0
    });
    let messages = command
        .settle_in(
            vec![
                Message {
                    label: &text,
                    value: Rc::clone(&value),
                    at: -0.0,
                },
                Message {
                    label: "second",
                    value: Rc::clone(&value),
                    at: 18.5,
                },
            ],
            &edge,
        )
        .unwrap();
    assert_eq!(reads.get(), 0);
    assert_eq!(messages[0].label, "borrowed invoice");
    assert_eq!(messages[1].label, "second");
    assert_eq!(messages[0].at.to_bits(), (-0.0_f64).to_bits());
    assert_eq!(messages[1].at, 18.5);
    for message in messages {
        assert!(Rc::ptr_eq(&message.value, &value));
        assert_eq!(message.value.0, text);
    }
}
