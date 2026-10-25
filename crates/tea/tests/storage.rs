use std::cell::Cell;
use std::sync::{Arc, Mutex};

use demlik_tea::storage::*;
use serde_json::{Value, json};

#[tokio::test]
async fn memory_storage_preserves_shared_references_and_fences_competing_writers() {
    let seed = Arc::new(Mutex::new(json!({ "count": 1 })));
    let store = memory_store(Some(Arc::clone(&seed))).fenced();
    let first = store.load_fenced().await.unwrap();
    let second = store.load_fenced().await.unwrap();
    assert!(Arc::ptr_eq(first.raw.as_ref().unwrap(), &seed));
    seed.lock().unwrap()["count"] = json!(2);
    assert_eq!(
        store.load().await.unwrap().unwrap().lock().unwrap()["count"],
        2
    );
    let replacement = Arc::new(Mutex::new(json!({ "count": 3 })));
    assert_eq!(
        store
            .save_fenced(&replacement, first.version)
            .await
            .unwrap(),
        StoredCell::Number(1.0)
    );
    let error = store.save_fenced(&seed, second.version).await.unwrap_err();
    assert!(matches!(
        error,
        MemoryStoreError::Conflict(StoreConflictError {
            expected_version: StoredCell::Number(0.0),
            actual_version: StoredCell::Number(1.0),
            ..
        })
    ));
    assert_eq!(
        store.load().await.unwrap().unwrap().lock().unwrap()["count"],
        3
    );
    store.delete().await.unwrap();
    let empty = store.load_fenced().await.unwrap();
    assert!(empty.raw.is_none());
    assert_eq!(empty.version, StoredCell::Number(0.0));
}

struct RefusingStore {
    raw: Value,
    saves: Cell<usize>,
}
impl Store<Value> for RefusingStore {
    type Raw = Value;
    type Error = &'static str;
    async fn load(&self) -> Result<Value, Self::Error> {
        Ok(self.raw.clone())
    }
    async fn save(&self, _: &Value) -> Result<(), Self::Error> {
        self.saves.set(self.saves.get() + 1);
        Ok(())
    }
    fn migrate(&self, _: Value) -> Migrated<Value> {
        Migrated::Refused(refuse("not a saved State"))
    }
}

#[tokio::test]
async fn a_refused_restore_preserves_saved_bytes_and_failure_reason() {
    let store = RefusingStore {
        raw: json!({ "version": "foreign" }),
        saves: Cell::new(0),
    };
    let failure = restore(&store).await.unwrap_err();
    assert_eq!(failure.reason, "not a saved State");
    assert_eq!(
        failure.to_string(),
        "@demlik/tea: store refused — not a saved State. The saved state was not restored and nothing was written."
    );
    assert_eq!(store.saves.get(), 0);
    assert_eq!(store.load().await.unwrap(), json!({ "version": "foreign" }));
}

#[test]
fn schema_migration_separates_upgrade_rejection_from_no_saved_state() {
    #[derive(serde::Deserialize)]
    struct State {
        count: u32,
    }
    let migrate = schema_migrate_with_upcast(
        serde_json::from_value::<State>,
        |raw: Value| -> Result<Value, &'static str> {
            if raw["version"] == 1 {
                Ok(json!({ "count": raw["oldCount"] }))
            } else {
                Err("unsupported version")
            }
        },
    );
    assert!(matches!(migrate(Value::Null), Migrated::Fresh));
    assert!(matches!(
        migrate(json!({ "version": 1, "oldCount": 7 })),
        Migrated::State(State { count: 7 })
    ));
    let Migrated::Refused(failure) = migrate(json!({ "version": 2 })) else {
        panic!("unexpected migration")
    };
    assert_eq!(
        failure.reason,
        "upcast threw on the saved state (unsupported version)"
    );
}
