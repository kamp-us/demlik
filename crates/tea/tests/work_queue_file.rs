#![cfg(not(target_arch = "wasm32"))]
use demlik_tea::{
    PlainData,
    data::stringify_json,
    file_store::file_store,
    storage::{Migrated, refuse},
    work_queue::*,
};
use std::rc::Rc;

fn migrate(raw: PlainData) -> Migrated<Queue<String>> {
    if matches!(raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    match stringify_json(&raw).and_then(|raw| serde_json::from_str(&raw).ok()) {
        Some(queue) => Migrated::State(queue),
        None => Migrated::Refused(refuse("the saved state does not match the schema")),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn a_fresh_file_adapter_recovers_running_work_and_refuses_unreadable_bytes() {
    let directory = std::env::temp_dir().join(format!(
        "demlik-queue-file-{}-{}",
        std::process::id(),
        fastrand::u64(..)
    ));
    tokio::fs::create_dir(&directory).await.unwrap();
    let path = directory.join("queue.json");
    let first = QueueClient::with_sources(file_store(&path, migrate), || 17.25, || "job".into());
    first
        .enqueue(Rc::new("https://example.test/page".into()))
        .await
        .unwrap();
    first.claim_next().await.unwrap();
    drop(first);
    let restarted = create_queue(file_store(&path, migrate));
    assert!(restarted.claim_next().await.unwrap().is_none());
    restarted.reset_running_to_pending().await.unwrap();
    drop(restarted);
    let restarted =
        QueueClient::with_sources(file_store(&path, migrate), || 42.5, || "unused".into());
    let claimed = restarted.claim_next().await.unwrap().unwrap();
    assert_eq!(claimed.id.as_utf8(), Some("job"));
    assert_eq!(claimed.input.as_str(), "https://example.test/page");
    assert_eq!(claimed.started_at.value().unwrap().number(), Some(42.5));
    restarted.mark_done("job").await.unwrap();
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "[]");
    let bytes = b"{\"unrelated\":true}";
    tokio::fs::write(&path, bytes).await.unwrap();
    let QueueError::Restore(error) = restarted
        .enqueue(Rc::new("must not overwrite".into()))
        .await
        .unwrap_err()
    else {
        panic!("refusal")
    };
    assert_eq!(error.reason, "the saved state does not match the schema");
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    tokio::fs::remove_dir_all(directory).await.unwrap();
}
