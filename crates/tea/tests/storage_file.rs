use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use demlik_tea::file_store::file_store;
use demlik_tea::{
    PlainData,
    data::{decode_json, stringify_json},
    storage::{DeletableStore, Fencing, Migrated, Store},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-file-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn migrate(raw: PlainData) -> Migrated<PlainData> {
    if matches!(raw, PlainData::Null) {
        Migrated::Fresh
    } else {
        Migrated::State(raw)
    }
}
fn store(
    path: &Path,
) -> demlik_tea::file_store::FileStore<PlainData, fn(PlainData) -> Migrated<PlainData>> {
    file_store(path, migrate as fn(PlainData) -> Migrated<PlainData>)
}

#[tokio::test]
async fn a_file_save_commits_json_by_rename_and_a_new_adapter_reads_it() {
    let directory = Directory::new();
    let path = directory.path("nested/state.json");
    let first = store(&path);
    assert!(matches!(first.load().await.unwrap(), PlainData::Null));
    first
        .save(&decode_json(r#"{"count":7}"#).unwrap())
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(&path).await.unwrap(),
        r#"{"count":7}"#
    );
    let second = store(&path);
    assert_eq!(
        stringify_json(&second.load().await.unwrap()).unwrap(),
        r#"{"count":7}"#
    );
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(path.parent().unwrap()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        names.push(entry.file_name());
    }
    assert_eq!(names, ["state.json"]);
    second.delete().await.unwrap();
    assert!(matches!(first.load().await.unwrap(), PlainData::Null));
}

#[tokio::test]
async fn a_fenced_file_refuses_stale_writes_without_changing_the_winners_bytes() {
    let directory = Directory::new();
    let path = directory.path("state.json");
    let first = store(&path).fenced();
    let second = store(&path).fenced();
    assert_eq!(first.load_fenced().await.unwrap().version, 0.0);
    assert_eq!(second.load_fenced().await.unwrap().version, 0.0);
    assert_eq!(
        first
            .save_fenced(&decode_json(r#"{"owner":"winner"}"#).unwrap(), 0.0)
            .await
            .unwrap(),
        1.0
    );
    let error = second
        .save_fenced(&decode_json(r#"{"owner":"loser"}"#).unwrap(), 0.0)
        .await
        .unwrap_err();
    assert_eq!(error.tag(), Some("store_conflict"));
    assert_eq!(
        tokio::fs::read_to_string(&path).await.unwrap(),
        r#"{"owner":"winner"}"#
    );
    assert_eq!(
        tokio::fs::read_to_string(directory.path("state.json.fence"))
            .await
            .unwrap(),
        "1"
    );
    assert!(!directory.path("state.json.fence.lock").exists());
    second.delete().await.unwrap();
    assert_eq!(first.load_fenced().await.unwrap().version, 0.0);
}

#[tokio::test]
async fn malformed_and_live_lock_holders_wait_until_the_owner_releases() {
    use std::time::Duration;
    for holder in [
        String::new(),
        "not a pid".into(),
        std::process::id().to_string(),
        format!("0x{}", "f".repeat(256)),
    ] {
        let directory = Directory::new();
        let path = directory.path("state.json");
        let lock = directory.path("state.json.fence.lock");
        tokio::fs::write(&lock, &holder).await.unwrap();
        let store = store(&path).fenced();
        let state = decode_json(r#"{"count":1}"#).unwrap();
        let save = store.save_fenced(&state, 0.0);
        tokio::pin!(save);
        assert!(
            tokio::time::timeout(Duration::from_millis(35), &mut save)
                .await
                .is_err()
        );
        assert!(!path.exists(), "a held lock must not write state");
        assert_eq!(tokio::fs::read_to_string(&lock).await.unwrap(), holder);
        tokio::fs::remove_file(&lock).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), &mut save)
                .await
                .unwrap()
                .unwrap(),
            1.0
        );
        assert!(!lock.exists());
    }
}

#[tokio::test]
async fn file_boundary_keeps_utf16_and_replaces_invalid_utf8_like_node() {
    use demlik_tea::file_store::FileStoreError;
    let directory = Directory::new();
    let path = directory.path("state.json");
    let store = store(&path);
    tokio::fs::write(&path, [b'"', 0xff, b'"']).await.unwrap();
    assert_eq!(
        stringify_json(&store.load().await.unwrap()).unwrap(),
        "\"�\""
    );
    let value = decode_json(r#"{"\ud800":"\udc00","overflow":1e400}"#).unwrap();
    store.save(&value).await.unwrap();
    assert_eq!(
        tokio::fs::read_to_string(&path).await.unwrap(),
        r#"{"\ud800":"\udc00","overflow":null}"#
    );
    tokio::fs::write(&path, b"{broken").await.unwrap();
    let error = store.load().await.unwrap_err();
    assert_eq!(error.name(), "SyntaxError");
    let FileStoreError::Json { raw, cause, .. } = error else {
        panic!("original JSON error must remain data")
    };
    assert_eq!(raw, "{broken");
    assert!(cause.is_syntax());
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"{broken");
}

#[tokio::test]
async fn an_out_of_range_numeric_pid_is_stale_even_when_hex_exceeds_u64() {
    let directory = Directory::new();
    let path = directory.path("state.json");
    tokio::fs::write(
        directory.path("state.json.fence.lock"),
        "0x10000000000000000",
    )
    .await
    .unwrap();
    let store = store(&path).fenced();
    let state = PlainData::Number(1.0);
    assert_eq!(
        tokio::time::timeout(
            std::time::Duration::from_millis(150),
            store.save_fenced(&state, 0.0)
        )
        .await
        .expect(
            "Node Number accepts the hex PID; process.kill refuses its range, so the lock is stale"
        )
        .unwrap(),
        1.0
    );
}
