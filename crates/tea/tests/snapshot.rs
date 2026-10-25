use demlik_tea::persistence::snapshot::{SnapshotConfig, create_snapshot};
use std::{cell::Cell, rc::Rc};
struct Payload {
    position: u32,
    local: Rc<Cell<u32>>,
}
#[test]
fn progress_hits_the_snapshot_cadence_and_emits_the_owned_payload_without_clone_or_serde_bounds() {
    let snapshot = create_snapshot(SnapshotConfig {
        every: 2.0,
        key: Some("checkpoint".into()),
    });
    let initial = snapshot.init();
    let payload = Rc::new(Payload {
        position: 7,
        local: Rc::new(Cell::new(3)),
    });
    let first = snapshot.record(&initial, Rc::clone(&payload), 100.0);
    assert!(first.commands.is_empty());
    assert_eq!(first.state.since_last.number(), Some(1.0));
    assert_eq!(initial.since_last.number(), Some(0.0));
    let saved = snapshot.record(&first.state, Rc::clone(&payload), 200.0);
    assert_eq!(saved.state.since_last.number(), Some(0.0));
    assert_eq!(saved.state.seq.number(), Some(1.0));
    assert_eq!(saved.commands.len(), 1);
    let data = saved.commands[0].input();
    assert_eq!(data.key.as_utf8(), Some("checkpoint"));
    assert_eq!(data.seq.number(), Some(1.0));
    assert_eq!(data.at.number(), Some(200.0));
    assert!(Rc::ptr_eq(&data.payload, &payload));
    assert_eq!(data.payload.position, 7);
    assert_eq!(data.payload.local.get(), 3);
}

#[test]
fn force_confirmation_and_recovery_keep_the_acknowledged_command_watermark() {
    use demlik_tea::PlainData;
    let snapshot = create_snapshot(SnapshotConfig {
        every: 9.0,
        key: None,
    });
    let initial = snapshot.init();
    let payload = Rc::new(Payload {
        position: 3,
        local: Rc::new(Cell::new(0)),
    });
    let first = snapshot.force(&initial, Rc::clone(&payload), 100.0);
    let second = snapshot.force(&first.state, Rc::clone(&payload), 200.0);
    let first_msg = snapshot.write.ok(
        first.commands.into_iter().next().unwrap(),
        PlainData::Undefined,
        Some(17.25),
    );
    let second_msg = snapshot.write.ok(
        second.commands.into_iter().next().unwrap(),
        PlainData::Undefined,
        Some(18.25),
    );
    let confirmed = snapshot.confirm(&second.state, &second_msg);
    assert_eq!(confirmed.state.last_saved_seq, Some(2.0));
    assert_eq!(confirmed.state.last_saved_at, Some(200.0));
    let stale = snapshot.confirm(&confirmed.state, &first_msg);
    assert!(Rc::ptr_eq(&stale.state, &confirmed.state));
    let progress = snapshot.record(&confirmed.state, Rc::clone(&payload), 250.0);
    assert_eq!(progress.state.since_last.number(), Some(1.0));
    let booted = snapshot.boot(&progress.state);
    assert_eq!(booted.state.since_last.number(), Some(0.0));
    assert_eq!(booted.state.seq.number(), Some(2.0));
    assert_eq!(booted.state.last_saved_seq, Some(2.0));
    assert_eq!(booted.state.last_saved_at, Some(200.0));
    let load = snapshot.request_load(&booted.state);
    assert!(Rc::ptr_eq(&load.state, &booted.state));
    assert_eq!(load.commands[0].input().key.as_utf8(), Some("@@snapshot"));
}

#[test]
fn nonfinite_counters_restore_as_null_then_follow_the_source_numeric_coercion() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        persistence::snapshot::SnapshotState,
    };
    let snapshot = create_snapshot::<PlainData>(SnapshotConfig {
        every: 2.0,
        key: None,
    });
    let original = SnapshotState {
        since_last: f64::NAN.into(),
        seq: f64::INFINITY.into(),
        last_saved_seq: Some(f64::INFINITY),
        last_saved_at: Some(f64::NAN),
    };
    let encoded = stringify_json(&plain_data(&original).unwrap()).unwrap();
    assert_eq!(
        encoded,
        "{\"sinceLast\":null,\"seq\":null,\"lastSavedSeq\":null,\"lastSavedAt\":null}"
    );
    let restored = Rc::new(serde_json::from_str::<SnapshotState>(&encoded).unwrap());
    assert_eq!(restored.since_last.number(), None);
    assert_eq!(restored.seq.number(), None);
    let first = snapshot.record(&restored, Rc::new(PlainData::Null), 10.0);
    assert!(first.commands.is_empty());
    assert_eq!(first.state.since_last.number(), Some(1.0));
    assert_eq!(first.state.seq.number(), None);
    let second = snapshot.record(&first.state, Rc::new(PlainData::Null), 20.0);
    assert_eq!(second.commands.len(), 1);
    assert_eq!(second.commands[0].input().seq.number(), Some(1.0));
    assert_eq!(second.state.seq.number(), Some(1.0));
    let ack = snapshot.write.ok(
        second.commands.into_iter().next().unwrap(),
        PlainData::Undefined,
        Some(77.25),
    );
    assert_eq!(
        snapshot.confirm(&second.state, &ack).state.last_saved_seq,
        Some(1.0)
    );
}
