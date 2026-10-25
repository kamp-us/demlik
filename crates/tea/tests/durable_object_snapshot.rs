use demlik_tea::{
    PlainData,
    data::JsText,
    durable_object::{DoStoreError, DoStoreOptions, do_store, do_store_with},
    storage::{DeletableStore, Fencing, Migrated, Store, refuse},
};
use std::{collections::BTreeMap, rc::Rc};
#[path = "support/durable_storage.rs"]
#[allow(dead_code)]
mod durable_storage;
use durable_storage::{Call, MemoryStorage};
#[allow(dead_code)]
#[path = "support/controlled_storage.rs"]
mod controlled_storage;
use controlled_storage::{Behavior, ControlledStorage, Gate, Operation, Rule, Stage};
struct Roster {
    members: BTreeMap<String, String>,
    local: Rc<()>,
}
fn decode(raw: PlainData) -> Migrated<Roster> {
    if matches!(raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    let PlainData::Object(mut object) = raw else {
        return Migrated::Refused(refuse("expected roster carrier"));
    };
    let Some(PlainData::Array(entries)) = object.shift_remove(&JsText::from("members")) else {
        return Migrated::Refused(refuse("expected roster entries"));
    };
    let mut members = BTreeMap::new();
    for entry in entries {
        let PlainData::Array(pair) = entry else {
            return Migrated::Refused(refuse("expected member pair"));
        };
        let [PlainData::String(key), PlainData::String(value)] = pair.as_slice() else {
            return Migrated::Refused(refuse("expected member text"));
        };
        let (Some(key), Some(value)) = (key.as_utf8(), value.as_utf8()) else {
            return Migrated::Refused(refuse("expected UTF-8 member"));
        };
        members.insert(key.to_owned(), value.to_owned());
    }
    Migrated::State(Roster {
        members,
        local: Rc::new(()),
    })
}
fn encode(state: &Roster) -> Result<PlainData, &'static str> {
    Ok(PlainData::Object(indexmap::IndexMap::from([(
        "members".into(),
        PlainData::Array(
            state
                .members
                .iter()
                .map(|(key, value)| {
                    PlainData::Array(vec![
                        PlainData::String(key.into()),
                        PlainData::String(value.into()),
                    ])
                })
                .collect(),
        ),
    )])))
}
#[tokio::test(flavor = "current_thread")]
async fn opaque_roster_uses_only_boundary_codecs_and_reopens_through_required_migration() {
    let storage = Rc::new(MemoryStorage::new());
    let state = Roster {
        members: BTreeMap::from([
            ("a1".into(), "Aragorn".into()),
            ("b2".into(), "Boromir".into()),
        ]),
        local: Rc::new(()),
    };
    let store = do_store_with(
        Rc::clone(&storage),
        decode,
        encode,
        DoStoreOptions::default(),
    );
    assert!(matches!(
        store.migrate(store.load().await.unwrap()),
        Migrated::Fresh
    ));
    store.save(&state).await.unwrap();
    let saved = storage.cells();
    assert!(
        matches!(&saved[&JsText::from("@@state")],PlainData::String(value)if value.as_utf8()==Some("{\"members\":[[\"a1\",\"Aragorn\"],[\"b2\",\"Boromir\"]]}"))
    );
    let reopened = do_store_with(
        Rc::clone(&storage),
        decode,
        encode,
        DoStoreOptions::default(),
    );
    let Migrated::State(loaded) = reopened.migrate(reopened.load().await.unwrap()) else {
        panic!("known carrier must restore")
    };
    assert_eq!(loaded.members["a1"], "Aragorn");
    assert_eq!(loaded.members["b2"], "Boromir");
    assert!(!Rc::ptr_eq(&state.local, &loaded.local));
}
#[tokio::test(flavor = "current_thread")]
async fn fenced_store_checks_before_encoding_and_deletes_both_cells_as_one_operation() {
    let storage = Rc::new(MemoryStorage::new());
    let encoded = Rc::new(std::cell::Cell::new(0));
    let calls = Rc::clone(&encoded);
    let store = do_store_with(
        Rc::clone(&storage),
        decode,
        move |state: &Roster| {
            calls.set(calls.get() + 1);
            encode(state)
        },
        DoStoreOptions {
            key: Some("run".into()),
        },
    )
    .fenced();
    let state = Roster {
        members: BTreeMap::new(),
        local: Rc::new(()),
    };
    assert_eq!(store.load_fenced().await.unwrap().version, 0.0);
    assert_eq!(store.save_fenced(&state, 0.0).await.unwrap(), 1.0);
    let error = store
        .save_fenced(&state, 0.0)
        .await
        .expect_err("stale writer must refuse");
    assert!(
        matches!(error,DoStoreError::Conflict(error)if error.expected_version==0.0&&error.actual_version==1.0)
    );
    assert_eq!(encoded.get(), 1, "stale writer must not invoke serializer");
    assert!(matches!(
        storage.calls.borrow().last(),
        Some(Call::Rollback)
    ));
    store.delete().await.unwrap();
    assert!(storage.cells().is_empty());
    assert!(
        matches!(storage.calls.borrow().last(),Some(Call::Delete(keys))if keys==&vec![JsText::from("run"),JsText::from("run@@version")])
    );
}
#[tokio::test(flavor = "current_thread")]
async fn default_json_carrier_keeps_load_and_migrate_distinct_and_never_overwrites_bad_bytes() {
    let storage = Rc::new(MemoryStorage::new());
    let store = do_store(
        Rc::clone(&storage),
        |raw| match raw {
            PlainData::Number(value) => Migrated::State(value),
            _ => Migrated::Refused(refuse("expected counter")),
        },
        DoStoreOptions {
            key: Some("counter".into()),
        },
    );
    store.save(&17.25).await.unwrap();
    assert!(matches!(store.load().await.unwrap(),PlainData::Number(value)if value==17.25));
    storage.seed("counter", PlainData::String("{broken}".into()));
    assert!(matches!(store.load().await, Err(DoStoreError::Json { .. })));
    assert!(
        matches!(&storage.cells()[&JsText::from("counter")],PlainData::String(value)if value.as_utf8()==Some("{broken}"))
    );
    storage.seed("counter", PlainData::Null);
    assert!(matches!(store.load().await.unwrap(), PlainData::Null));
}

#[tokio::test(flavor = "current_thread")]
async fn raw_storage_text_keeps_literal_utf16_and_uses_the_canonical_coercion_and_json_owners() {
    let storage = Rc::new(MemoryStorage::new());
    let store = do_store::<PlainData, _, _>(
        Rc::clone(&storage),
        Migrated::State,
        DoStoreOptions::default(),
    );
    for (raw, expected) in [
        (
            PlainData::String(JsText::from_units(vec![34, 0xd800, 34])),
            PlainData::String(JsText::from_units(vec![0xd800])),
        ),
        (
            PlainData::String(JsText::from_units(vec![34, 92, 92, 0xd800, 34])),
            PlainData::String(JsText::from_units(vec![92, 0xd800])),
        ),
        (PlainData::Bool(true), PlainData::Bool(true)),
        (
            PlainData::Array(vec![PlainData::Number(42.0)]),
            PlainData::Number(42.0),
        ),
    ] {
        storage.seed("@@state", raw);
        assert_eq!(
            demlik_tea::structural_hash(&store.load().await.unwrap()),
            demlik_tea::structural_hash(&expected)
        );
    }
    for units in [vec![34, 92, 0xd800, 34], vec![0xd800]] {
        storage.seed(
            "@@state",
            PlainData::String(JsText::from_units(units.clone())),
        );
        assert!(
            matches!(store.load().await,Err(DoStoreError::Json{raw:PlainData::String(value),..})if value.as_units()==units)
        );
    }
    assert!(
        storage
            .calls
            .borrow()
            .iter()
            .all(|call| matches!(call,Call::Get(key)if key.as_utf8()==Some("@@state")))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn storage_failures_keep_the_original_payload_and_distinguish_before_from_after_writes() {
    for stage in [Stage::Before, Stage::After] {
        let storage = Rc::new(ControlledStorage::new());
        let issue = Rc::new(PlainData::Object(indexmap::IndexMap::from([(
            "code".into(),
            PlainData::Number(7.0),
        )])));
        storage.rule(Rule {
            operation: Operation::Put,
            key: Some("@@state".into()),
            stage,
            remaining: 1,
            behavior: Behavior::Fail {
                message: "disk refused".into(),
                value: Rc::clone(&issue),
            },
        });
        let store = do_store_with(
            Rc::clone(&storage),
            decode,
            encode,
            DoStoreOptions::default(),
        );
        let state = Roster {
            members: BTreeMap::new(),
            local: Rc::new(()),
        };
        let error = store
            .save(&state)
            .await
            .expect_err("planned storage failure must be visible");
        let DoStoreError::Storage {
            operation: "put",
            cause,
        } = error
        else {
            panic!("storage phase and payload must survive")
        };
        assert_eq!(cause.message, "disk refused");
        assert!(Rc::ptr_eq(&cause.value, &issue));
        assert_eq!(
            storage.inner.cells().len(),
            usize::from(stage == Stage::After)
        );
    }
}
#[tokio::test(flavor = "current_thread")]
async fn failure_after_a_staged_version_put_rolls_back_both_fenced_cells() {
    let storage = Rc::new(ControlledStorage::new());
    storage.rule(Rule {
        operation: Operation::Put,
        key: Some("@@state@@version".into()),
        stage: Stage::After,
        remaining: 1,
        behavior: Behavior::Fail {
            message: "version write failed".into(),
            value: Rc::new(PlainData::Undefined),
        },
    });
    let store = do_store_with(
        Rc::clone(&storage),
        decode,
        encode,
        DoStoreOptions::default(),
    )
    .fenced();
    let state = Roster {
        members: BTreeMap::new(),
        local: Rc::new(()),
    };
    assert!(matches!(
        store.save_fenced(&state, 0.0).await,
        Err(DoStoreError::Storage {
            operation: "put",
            ..
        })
    ));
    assert!(storage.inner.cells().is_empty());
    assert!(matches!(
        storage.inner.calls.borrow().last(),
        Some(Call::Rollback)
    ));
    assert_eq!(store.save_fenced(&state, 0.0).await.unwrap(), 1.0);
}
#[tokio::test(flavor = "current_thread")]
async fn a_failure_after_transaction_commit_keeps_the_bytes_and_refuses_a_stale_retry() {
    let storage = Rc::new(ControlledStorage::new());
    storage.rule(Rule {
        operation: Operation::Commit,
        key: None,
        stage: Stage::After,
        remaining: 1,
        behavior: Behavior::Fail {
            message: "ack lost".into(),
            value: Rc::new(PlainData::Null),
        },
    });
    let store = do_store_with(
        Rc::clone(&storage),
        decode,
        encode,
        DoStoreOptions::default(),
    )
    .fenced();
    let state = Roster {
        members: BTreeMap::new(),
        local: Rc::new(()),
    };
    assert!(matches!(
        store.save_fenced(&state, 0.0).await,
        Err(DoStoreError::Storage {
            operation: "transaction",
            ..
        })
    ));
    assert_eq!(storage.inner.cells().len(), 2);
    assert!(matches!(
        store.save_fenced(&state, 0.0).await,
        Err(DoStoreError::Conflict(_))
    ));
}
#[tokio::test(flavor = "current_thread")]
async fn a_held_transaction_hides_staged_state_and_allows_only_one_version_zero_writer() {
    tokio::task::LocalSet::new().run_until(async{
        tokio::time::timeout(std::time::Duration::from_secs(2),async{
            let storage=Rc::new(ControlledStorage::new());let gate=Rc::new(Gate::new("state write"));
            storage.rule(Rule{operation:Operation::Put,key:Some("@@state".into()),stage:Stage::After,remaining:1,behavior:Behavior::Hold(Rc::clone(&gate))});
            let a=do_store_with(Rc::clone(&storage),decode,encode,DoStoreOptions::default()).fenced();
            let b=do_store_with(Rc::clone(&storage),decode,encode,DoStoreOptions::default()).fenced();
            let first=tokio::task::spawn_local(async move{a.save_fenced(&Roster{members:BTreeMap::from([("winner".into(),"one".into())]),local:Rc::new(())},0.0).await});
            gate.wait(1).await;
            let second=tokio::task::spawn_local(async move{b.save_fenced(&Roster{members:BTreeMap::from([("loser".into(),"two".into())]),local:Rc::new(())},0.0).await});
            storage.wait_for_transactions(2).await;
            assert!(storage.inner.cells().is_empty(),"staged state must remain invisible outside the transaction");
            gate.release();assert_eq!(first.await.unwrap().unwrap(),1.0);
            assert!(matches!(second.await.unwrap(),Err(DoStoreError::Conflict(_))));
            assert!(matches!(&storage.inner.cells()[&JsText::from("@@state")],PlainData::String(value)if value.as_utf8()==Some("{\"members\":[[\"winner\",\"one\"]]}")));
        }).await.expect("transaction handshake completes");
    }).await;
}
