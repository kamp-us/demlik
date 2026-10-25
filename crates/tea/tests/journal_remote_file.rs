#![cfg(not(target_arch = "wasm32"))]
use demlik_tea::{
    PlainData,
    data::JsText,
    file_store::{FileStore, FileStoreError, file_store},
    journal::{
        FileJournalError, JournalError, file_journal,
        remote::{
            CursorStore, LocalWork, PullRequest, RemoteJournal, SyncClientOptions, SyncFailure,
            make_sync_client, memory_remote_journal,
        },
    },
    storage::{Migrated, Refusal, Store, refuse},
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
            "demlik-sync-consumer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
type Cursors = BTreeMap<JsText, f64>;
type CursorFile = FileStore<Cursors, fn(PlainData) -> Migrated<Cursors>>;
struct FileCursors(CursorFile);
#[derive(Debug)]
enum CursorError {
    File(FileStoreError),
    Refused(Refusal),
}
fn cursor_decode(raw: PlainData) -> Migrated<Cursors> {
    if matches!(raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    let PlainData::Object(fields) = raw else {
        return Migrated::Refused(refuse("expected cursor record"));
    };
    let mut result = Cursors::new();
    for (key, value) in fields {
        let PlainData::Number(seq) = value else {
            return Migrated::Refused(refuse("expected numeric cursor"));
        };
        result.insert(key, seq);
    }
    Migrated::State(result)
}
async fn read(store: &CursorFile) -> Result<Cursors, CursorError> {
    match store.migrate(store.load().await.map_err(CursorError::File)?) {
        Migrated::Fresh => Ok(Cursors::new()),
        Migrated::State(cursors) => Ok(cursors),
        Migrated::Refused(error) => Err(CursorError::Refused(error)),
    }
}
impl CursorStore for FileCursors {
    type Error = CursorError;
    fn get(&self, stream: JsText) -> LocalWork<f64, Self::Error> {
        let store = self.0.clone();
        Box::pin(async move { Ok(read(&store).await?.get(&stream).copied().unwrap_or(0.0)) })
    }
    fn set(&self, stream: JsText, seq: f64) -> LocalWork<(), Self::Error> {
        let store = self.0.clone();
        Box::pin(async move {
            let mut cursors = read(&store).await?;
            cursors.insert(stream, seq);
            store.save(&cursors).await.map_err(CursorError::File)
        })
    }
}
impl std::fmt::Display for CursorError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File(error) => error.fmt(output),
            Self::Refused(error) => output.write_str(&error.reason),
        }
    }
}
fn cursor_file(directory: &Directory) -> Rc<FileCursors> {
    Rc::new(FileCursors(file_store(
        directory.0.join("cursor.json"),
        cursor_decode as fn(PlainData) -> Migrated<Cursors>,
    )))
}
#[derive(serde::Serialize)]
struct IssueEvent {
    kind: String,
}
fn event(raw: PlainData) -> Result<IssueEvent, &'static str> {
    let PlainData::Object(mut fields) = raw else {
        return Err("expected issue event");
    };
    let Some(PlainData::String(kind)) = fields.shift_remove(&JsText::from("kind")) else {
        return Err("expected issue event kind");
    };
    let Some(kind) = kind.as_utf8() else {
        return Err("expected UTF-8 issue kind");
    };
    if !matches!(kind, "opened" | "commented") {
        return Err("unknown issue event kind");
    }
    Ok(IssueEvent { kind: kind.into() })
}

#[tokio::test(flavor = "current_thread")]
async fn offline_issue_appends_and_a_file_cursor_survive_restart_with_source_watermark_limits() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let directory = Directory::new();
            let remote = Rc::new(memory_remote_journal::<IssueEvent>());
            let peer = make_sync_client(SyncClientOptions::new(Rc::clone(&remote), "reviewer"));
            peer.append(
                "issues",
                Rc::new(IssueEvent {
                    kind: "commented".into(),
                }),
            )
            .await
            .unwrap();
            peer.sync("issues").await.unwrap();
            let offline = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "author")
                    .with_local(Rc::new(file_journal(directory.0.join("local"), event)))
                    .with_cursors(cursor_file(&directory)),
            );
            offline
                .append(
                    "issues",
                    Rc::new(IssueEvent {
                        kind: "opened".into(),
                    }),
                )
                .await
                .unwrap();
            drop(offline);
            let reopened = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "author")
                    .with_local(Rc::new(file_journal(directory.0.join("local"), event)))
                    .with_cursors(cursor_file(&directory)),
            );
            assert_eq!(
                reopened.pending("issues").await.unwrap()[0].record.kind,
                "opened"
            );
            reopened.sync("issues").await.unwrap();
            let log = reopened.log("issues");
            let (opened, comments) = log.iter().fold((false, 0), |(opened, comments), entry| {
                match entry.record.kind.as_str() {
                    "opened" => (true, comments),
                    "commented" => (opened, comments + 1),
                    _ => unreachable!(),
                }
            });
            assert!(opened);
            assert_eq!(comments, 1);
            assert_eq!(
                log.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
                [1.0, 2.0]
            );
            assert_eq!(
                tokio::fs::read_to_string(directory.0.join("cursor.json"))
                    .await
                    .unwrap(),
                "{\"issues\":2}"
            );
            drop(reopened);
            let restarted = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "author")
                    .with_local(Rc::new(file_journal(directory.0.join("local"), event)))
                    .with_cursors(cursor_file(&directory)),
            );
            assert!(restarted.log("issues").is_empty());
            assert_eq!(restarted.pending("issues").await.unwrap().len(), 1);
            restarted.sync("issues").await.unwrap();
            assert_eq!(
                restarted
                    .log("issues")
                    .iter()
                    .map(|entry| entry.seq)
                    .collect::<Vec<_>>(),
                [3.0]
            );
            assert_eq!(
                tokio::fs::read_to_string(directory.0.join("cursor.json"))
                    .await
                    .unwrap(),
                "{\"issues\":3}"
            );
            let remote = remote
                .pull(PullRequest::<PlainData> {
                    token: None,
                    stream: "issues".into(),
                    since: 0.0,
                })
                .await
                .unwrap();
            assert_eq!(
                remote
                    .entries
                    .iter()
                    .map(|entry| entry.record.kind.as_str())
                    .collect::<Vec<_>>(),
                ["commented", "opened", "opened"]
            );
            assert_eq!(
                tokio::fs::read_to_string(directory.0.join("local/issues.jsonl"))
                    .await
                    .unwrap(),
                "{\"seq\":1,\"record\":{\"kind\":\"opened\"}}\n"
            );
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn persisted_record_and_cursor_refusals_retain_their_failure_phase_and_raw_data() {
    tokio::task::LocalSet::new().run_until(async {
        let directory=Directory::new();tokio::fs::create_dir_all(&directory.0).await.unwrap();
        let remote=Rc::new(memory_remote_journal::<IssueEvent>());
        tokio::fs::write(directory.0.join("issues.jsonl"),"{\"seq\":1,\"record\":null}\n").await.unwrap();
        let client=make_sync_client(SyncClientOptions::new(Rc::clone(&remote),"author")
            .with_local(Rc::new(file_journal(&directory.0,event))).with_cursors(cursor_file(&directory)));
        let error=client.pending("issues").await.err().expect("malformed event must refuse");
        assert!(matches!(error,JournalError::Backend(SyncFailure::Local(JournalError::Backend(FileJournalError::Parse{raw:PlainData::Null,cause:"expected issue event",..})))));
        tokio::fs::write(directory.0.join("cursor.json"),"{\"issues\":\"old\"}").await.unwrap();
        let client=make_sync_client(SyncClientOptions::new(remote,"author").with_cursors(cursor_file(&directory)));
        let error=client.sync("issues").await.expect_err("malformed cursor must refuse");
        assert!(matches!(error,JournalError::Backend(SyncFailure::CursorGet(CursorError::Refused(refusal))) if refusal.reason=="expected numeric cursor"));
        assert_eq!(tokio::fs::read_to_string(directory.0.join("cursor.json")).await.unwrap(),"{\"issues\":\"old\"}");
    }).await;
}
