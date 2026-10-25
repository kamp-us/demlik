#![cfg(not(target_arch = "wasm32"))]
use demlik_tea::{PlainData, journal::file_journal};
use serde::Serialize;
use std::{
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
            "demlik-journal-native-{}-{}",
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
#[derive(Serialize)]
struct Event {
    tag: String,
}
fn parse(raw: PlainData) -> Result<Event, String> {
    let PlainData::Object(mut fields) = raw else {
        return Err("expected event record".into());
    };
    let Some(PlainData::String(tag)) = fields.shift_remove(&demlik_tea::data::JsText::from("tag"))
    else {
        return Err("expected event tag".into());
    };
    Ok(Event {
        tag: tag
            .as_utf8()
            .ok_or("expected UTF-8 event tag")?
            .to_uppercase(),
    })
}
#[tokio::test(flavor = "current_thread")]
async fn a_new_file_journal_recovers_parsed_records_and_keeps_readable_atomic_rewrite_bytes() {
    tokio::task::LocalSet::new().run_until(async {
        let directory = Directory::new();
        let journal = file_journal(&directory.0, parse);
        let stream = "order/a &+!";
        assert_eq!(journal.append(stream, Rc::new(Event { tag: "one".into() })).await.unwrap().seq, 1.0);
        assert_eq!(journal.append(stream, Rc::new(Event { tag: "two".into() })).await.unwrap().seq, 2.0);
        drop(journal);
        let restarted = file_journal(&directory.0, parse);
        let entries = restarted.list(stream).await.unwrap();
        assert_eq!(entries.iter().map(|entry| entry.record.tag.as_str()).collect::<Vec<_>>(), ["ONE", "TWO"]);
        assert_eq!(tokio::fs::read_to_string(directory.0.join("order%2Fa%20%26%2B!.jsonl")).await.unwrap(), "{\"seq\":1,\"record\":{\"tag\":\"ONE\"}}\n{\"seq\":2,\"record\":{\"tag\":\"two\"}}\n");
    }).await;
}

fn parse_string(raw: PlainData) -> Result<String, String> {
    let PlainData::String(value) = raw else {
        return Err("expected string record".into());
    };
    value
        .as_utf8()
        .map(str::to_owned)
        .ok_or_else(|| "expected UTF-8 record".into())
}
#[tokio::test(flavor = "current_thread")]
async fn recovery_preserves_unvalidated_sequence_fields_and_appends_by_row_count() {
    tokio::task::LocalSet::new().run_until(async {
        let directory = Directory::new();
        tokio::fs::create_dir_all(&directory.0).await.unwrap();
        tokio::fs::write(directory.0.join("s.jsonl"), "{\"record\":\"missing-seq\"}\n{\"seq\":null,\"record\":\"null-seq\"}\n{\"seq\":\"legacy\",\"record\":\"text-seq\"}\n").await.unwrap();
        let journal = file_journal(&directory.0, parse_string);
        let entries = journal.list("s").await.unwrap();
        assert!(matches!(entries[0].seq.raw(), PlainData::Undefined));
        assert!(matches!(entries[1].seq.raw(), PlainData::Null));
        assert!(matches!(entries[2].seq.raw(), PlainData::String(value) if value.as_utf8()==Some("legacy")));
        assert_eq!(journal.append("s", Rc::new("next".into())).await.unwrap().seq, 4.0);
        assert_eq!(tokio::fs::read_to_string(directory.0.join("s.jsonl")).await.unwrap(), "{\"record\":\"missing-seq\"}\n{\"seq\":null,\"record\":\"null-seq\"}\n{\"seq\":\"legacy\",\"record\":\"text-seq\"}\n{\"seq\":4,\"record\":\"next\"}\n");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn record_refusal_preserves_bytes_and_an_opaque_lock_failure_releases_other_instances() {
    use demlik_tea::journal::{FileJournalError, JournalError};
    use std::time::Duration;
    struct Refusal {
        _local: Rc<()>,
    }
    tokio::task::LocalSet::new().run_until(async {
        let directory = Directory::new();
        tokio::fs::create_dir_all(&directory.0).await.unwrap();
        let bytes = "{\"seq\":1,\"record\":null}\n";
        tokio::fs::write(directory.0.join("s.jsonl"), bytes).await.unwrap();
        let journal = file_journal(&directory.0, parse_string);
        let error = journal.append("s", Rc::new("new".into())).await.unwrap_err();
        assert!(matches!(error, JournalError::Backend(FileJournalError::Parse { raw: PlainData::Null, cause, .. }) if cause=="expected string record"));
        assert_eq!(tokio::fs::read_to_string(directory.0.join("s.jsonl")).await.unwrap(), bytes);
        let refused = Rc::new(Refusal { _local: Rc::new(()) });
        let expected = Rc::clone(&refused);
        let error = journal.with_lock("other", move || async move { Err::<(), _>(refused) }).await;
        let Err(JournalError::Effect(actual)) = error else { panic!("opaque failure data was lost") };
        assert!(Rc::ptr_eq(&actual, &expected));
        let independent = file_journal(&directory.0, parse_string);
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), independent.append("other", Rc::new("accepted".into()))).await.unwrap().unwrap().seq, 1.0);
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_file_lock_orders_an_independent_journal_behind_a_held_reentrant_append() {
    use std::{convert::Infallible, time::Duration};
    tokio::task::LocalSet::new()
        .run_until(async {
            tokio::time::timeout(Duration::from_secs(2), async {
                let directory = Directory::new();
                let first = file_journal(&directory.0, parse_string);
                let second = file_journal(&directory.0, parse_string);
                let inside = first.clone();
                let (entered, has_lock) = tokio::sync::oneshot::channel();
                let (release, released) = tokio::sync::oneshot::channel();
                let a = first.with_lock("s", move || async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok::<_, Infallible>(inside.append("s", Rc::new("A".into())).await.unwrap().seq)
                });
                has_lock.await.unwrap();
                let b = second.append("s", Rc::new("B".into()));
                release.send(()).unwrap();
                assert_eq!(a.await.unwrap(), 1.0);
                assert_eq!(b.await.unwrap().seq, 2.0);
                let recovered = file_journal(&directory.0, parse_string)
                    .list("s")
                    .await
                    .unwrap();
                assert_eq!(
                    recovered
                        .iter()
                        .map(|entry| entry.record.as_str())
                        .collect::<Vec<_>>(),
                    ["A", "B"]
                );
            })
            .await
            .expect("the file lock must release after reentrant work finishes");
        })
        .await;
}

mod runtime_restart {
    use super::Directory;
    use demlik_tea::command::{CommandContractError, CommandFamily};
    use demlik_tea::journal::{
        FileBackend, FileJournalError, Journal, JournalError, JournalTask, file_journal,
    };
    use demlik_tea::runtime::{
        CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
        launch,
    };
    use demlik_tea::storage::{Migrated, Store};
    use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update, messages};
    use std::{
        cell::{Cell, RefCell},
        fmt,
        rc::Rc,
    };

    #[derive(serde::Serialize)]
    struct Applied {
        delta: i32,
    }
    struct Model {
        count: i32,
        local: Rc<()>,
    }
    impl Tagged for Model {
        fn tag(&self) -> &str {
            "counter"
        }
    }
    messages! { enum Msg { Applied { event: Rc<Applied> } } }
    enum Cmd {
        Audit,
    }
    impl Tagged for Cmd {
        fn tag(&self) -> &str {
            "audit"
        }
    }
    impl CommandFamily for Cmd {
        type Msg = Msg;
        type Completion = Vec<Msg>;
        fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
            Ok(messages)
        }
    }
    fn machine() -> Machine<'static, Model, Msg, Cmd, Sub<PlainData>> {
        Machine {
            init: Box::new(|loaded, _| {
                Step::new(
                    loaded.unwrap_or(Model {
                        count: 0,
                        local: Rc::new(()),
                    }),
                    vec![],
                )
            }),
            update: Update::reducer(|state: &Model, msg: &Msg| match msg {
                Msg::Applied { event } => Step::new(
                    Model {
                        count: state.count + event.delta,
                        local: Rc::clone(&state.local),
                    },
                    vec![Cmd::Audit],
                ),
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        }
    }
    fn parse(raw: PlainData) -> Result<Applied, String> {
        let PlainData::Object(fields) = raw else {
            return Err("expected applied event".into());
        };
        let Some(PlainData::Number(delta)) = fields.get(&demlik_tea::data::JsText::from("delta"))
        else {
            return Err("expected event delta".into());
        };
        if delta.fract() != 0.0 || *delta < i32::MIN as f64 || *delta > i32::MAX as f64 {
            return Err("expected i32 event delta".into());
        }
        Ok(Applied {
            delta: *delta as i32,
        })
    }
    type Log = Journal<Applied, FileBackend<Applied, fn(PlainData) -> Result<Applied, String>>>;
    type Receipt = JournalTask<demlik_tea::journal::Appended, FileJournalError<String>>;
    #[derive(Debug)]
    enum RecoveryError {
        Journal(JournalError<FileJournalError<String>>),
        Fold(demlik_tea::NoCellError),
    }
    impl fmt::Display for RecoveryError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::Journal(error) => error.fmt(f),
                Self::Fold(error) => error.fmt(f),
            }
        }
    }
    struct RecoveredStore(Log);
    impl Store<Model> for RecoveredStore {
        type Raw = Model;
        type Error = RecoveryError;
        async fn load(&self) -> Result<Model, Self::Error> {
            let entries = self
                .0
                .list("counter")
                .await
                .map_err(RecoveryError::Journal)?;
            let messages = entries.into_iter().map(|entry| Msg::Applied {
                event: Rc::clone(&entry.record),
            });
            demlik_tea::replay(&machine(), None, &(), messages)
                .map(|recovered| recovered.state)
                .map_err(RecoveryError::Fold)
        }
        async fn save(&self, _: &Model) -> Result<(), Self::Error> {
            Ok(())
        }
        fn migrate(&self, state: Model) -> Migrated<Model> {
            Migrated::State(state)
        }
    }
    struct Audit(Rc<Cell<u32>>);
    impl Interpreter<Cmd> for Audit {
        type Error = std::convert::Infallible;
        fn interpret<'a>(
            &'a self,
            _: &'a Cmd,
            _: CommandContext<Msg, Self::Error>,
        ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
            Some(CommandWork::new(async move {
                self.0.set(self.0.get() + 1);
                Ok(vec![])
            }))
        }
    }
    async fn flush(receipts: &Rc<RefCell<Vec<Receipt>>>) {
        let pending = std::mem::take(&mut *receipts.borrow_mut());
        for receipt in pending {
            receipt.await.unwrap();
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn a_persisted_aggregate_restarts_through_store_and_runtime_without_reexecuting_old_commands()
     {
        tokio::task::LocalSet::new()
            .run_until(async {
                for profile in [Profile::Promise, Profile::Effect] {
                    let directory = Directory::new();
                    let audits = Rc::new(Cell::new(0));
                    for (deltas, restored, expected) in [(vec![3, 4], 0, 7), (vec![-2], 7, 5)] {
                        let log: Log = file_journal(
                            &directory.0,
                            parse as fn(PlainData) -> Result<Applied, String>,
                        );
                        let mut options = Options::new(profile);
                        options.store = Some(Persistence::new(RecoveredStore(log.clone())));
                        let runtime = launch(
                            machine(),
                            (),
                            Audit(Rc::clone(&audits)),
                            NoSubscriptions::new(),
                            options,
                        );
                        let before = audits.get();
                        runtime.ready().await.unwrap();
                        assert_eq!(runtime.get_state().unwrap().count, restored);
                        assert_eq!(
                            audits.get(),
                            before,
                            "recovery folds commands but never performs them"
                        );
                        let receipts = Rc::new(RefCell::new(Vec::new()));
                        let pending = Rc::clone(&receipts);
                        let _observer = runtime.observe(move |msg, _| {
                            let Msg::Applied { event } = msg;
                            pending
                                .borrow_mut()
                                .push(log.append("counter", Rc::clone(event)));
                        });
                        for delta in deltas {
                            runtime
                                .dispatch(Msg::Applied {
                                    event: Rc::new(Applied { delta }),
                                })
                                .await
                                .unwrap();
                            flush(&receipts).await;
                        }
                        assert_eq!(runtime.get_state().unwrap().count, expected);
                        runtime.stop().await;
                    }
                    assert_eq!(audits.get(), 3);
                    let recovered: Log = file_journal(
                        &directory.0,
                        parse as fn(PlainData) -> Result<Applied, String>,
                    );
                    let state = RecoveredStore(recovered).load().await.unwrap();
                    assert_eq!(state.count, 5);
                }
            })
            .await;
    }
}
