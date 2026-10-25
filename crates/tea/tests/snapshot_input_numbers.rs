use demlik_tea::{
    PlainData,
    persistence::snapshot::{SnapshotConfig, SnapshotState, SnapshotWriteInput, create_snapshot},
};
use std::rc::Rc;

#[test]
fn json_restored_null_command_numbers_are_kept_until_confirmation_compares_them() {
    let encoded = r#"{"key":"snapshot","seq":null,"at":null,"payload":{"stage":2}}"#;
    let restored = serde_json::from_str::<SnapshotWriteInput<PlainData>>(encoded);
    assert!(
        restored.is_ok(),
        "a valid numeric->JSON-null input must restore"
    );
    let snapshot = create_snapshot::<PlainData>(SnapshotConfig {
        every: 1.0,
        key: None,
    });
    let command = snapshot.write.from_record(restored.unwrap());
    assert_eq!(
        serde_json::to_value(command.input()).unwrap()["seq"],
        serde_json::Value::Null
    );
    let message = snapshot.write.ok(command, PlainData::Undefined, Some(1.0));
    let initial = snapshot.init();
    let fresh = snapshot.confirm(&initial, &message);
    assert!(!Rc::ptr_eq(&fresh.state, &initial));
    assert_eq!(fresh.state.last_saved_seq, None);
    assert_eq!(fresh.state.last_saved_at, None);
    let saved = Rc::new(SnapshotState {
        last_saved_seq: Some(0.0),
        last_saved_at: Some(10.0),
        ..*initial
    });
    let stale = snapshot.confirm(&saved, &message);
    assert!(Rc::ptr_eq(&stale.state, &saved));
    assert_eq!(stale.state.last_saved_at, Some(10.0));
}
