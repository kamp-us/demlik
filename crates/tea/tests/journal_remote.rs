use demlik_tea::journal::remote::{SyncClientOptions, make_sync_client, memory_remote_journal};
use std::{cell::RefCell, rc::Rc};
struct Record {
    tag: &'static str,
    _local: Rc<()>,
}
struct Token {
    _local: Rc<()>,
}
#[tokio::test(flavor = "current_thread")]
async fn two_opaque_clients_append_offline_then_fold_one_remote_order() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let remote = Rc::new(memory_remote_journal::<RefCell<Record>>());
            let token = Rc::new(Token {
                _local: Rc::new(()),
            });
            let alice = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "alice").with_token(Rc::clone(&token)),
            );
            let bob = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "bob").with_token(token),
            );
            let record = Rc::new(RefCell::new(Record {
                tag: "claim",
                _local: Rc::new(()),
            }));
            alice.append("issue", Rc::clone(&record)).await.unwrap();
            bob.append(
                "issue",
                Rc::new(RefCell::new(Record {
                    tag: "comment",
                    _local: Rc::new(()),
                })),
            )
            .await
            .unwrap();
            assert!(alice.log("issue").is_empty());
            assert!(bob.log("issue").is_empty());
            let provisional = alice.pending("issue").await.unwrap();
            assert_eq!(provisional[0].author.as_utf8(), Some("alice"));
            assert!(Rc::ptr_eq(&provisional[0].record, &record));
            alice.sync("issue").await.unwrap();
            bob.sync("issue").await.unwrap();
            alice.sync("issue").await.unwrap();
            for client in [&alice, &bob] {
                let log = client.log("issue");
                assert_eq!(
                    log.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
                    [1.0, 2.0]
                );
                assert_eq!(
                    log.iter()
                        .map(|entry| entry.author.as_utf8().unwrap())
                        .collect::<Vec<_>>(),
                    ["alice", "bob"]
                );
                assert!(client.pending("issue").await.unwrap().is_empty());
            }
            record.borrow_mut().tag = "edited";
            assert_eq!(bob.log("issue")[0].record.borrow().tag, "edited");
            let mut snapshot = bob.log("issue");
            snapshot.clear();
            assert_eq!(bob.log("issue").len(), 2);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn restarting_with_a_retained_local_log_repushes_the_old_tail() {
    use demlik_tea::PlainData;
    use demlik_tea::journal::{
        memory_journal,
        remote::{PullRequest, RemoteJournal, memory_cursor_store},
    };
    tokio::task::LocalSet::new()
        .run_until(async {
            let remote = Rc::new(memory_remote_journal::<u32>());
            let local = Rc::new(memory_journal());
            let cursors = Rc::new(memory_cursor_store());
            let first = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "a")
                    .with_local(Rc::clone(&local))
                    .with_cursors(Rc::clone(&cursors)),
            );
            first.append("s", Rc::new(7)).await.unwrap();
            first.sync("s").await.unwrap();
            let restarted = make_sync_client(
                SyncClientOptions::new(Rc::clone(&remote), "a")
                    .with_local(local)
                    .with_cursors(cursors),
            );
            assert_eq!(restarted.pending("s").await.unwrap().len(), 1);
            restarted.sync("s").await.unwrap();
            assert_eq!(
                restarted
                    .log("s")
                    .iter()
                    .map(|entry| entry.seq)
                    .collect::<Vec<_>>(),
                [2.0]
            );
            let all = remote
                .pull(PullRequest::<PlainData> {
                    token: None,
                    stream: "s".into(),
                    since: 0.0,
                })
                .await
                .unwrap();
            assert_eq!(
                all.entries
                    .iter()
                    .map(|entry| entry.seq)
                    .collect::<Vec<_>>(),
                [1.0, 2.0]
            );
            assert!(Rc::ptr_eq(&all.entries[0].record, &all.entries[1].record));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn overlapping_syncs_keep_the_sources_duplicate_log_and_overshot_watermark() {
    use demlik_tea::{
        PlainData,
        data::JsText,
        journal::remote::{
            CursorStore, LocalWork, MemoryCursorStore, MemoryError, PullRequest, RemoteJournal,
            memory_cursor_store,
        },
    };
    use std::{cell::Cell, time::Duration};
    struct Held {
        base: MemoryCursorStore,
        count: Rc<Cell<usize>>,
        both: Rc<tokio::sync::Notify>,
        release: Rc<tokio::sync::Notify>,
    }
    impl CursorStore for Held {
        type Error = MemoryError;
        fn get(&self, stream: JsText) -> LocalWork<f64, Self::Error> {
            let base = self.base.clone();
            let count = Rc::clone(&self.count);
            let both = Rc::clone(&self.both);
            let release = Rc::clone(&self.release);
            Box::pin(async move {
                let value = base.get(stream).await?;
                count.set(count.get() + 1);
                if count.get() == 2 {
                    both.notify_one();
                }
                release.notified().await;
                Ok(value)
            })
        }
        fn set(&self, stream: JsText, seq: f64) -> LocalWork<(), Self::Error> {
            self.base.set(stream, seq)
        }
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            tokio::time::timeout(Duration::from_secs(2), async {
                let remote = Rc::new(memory_remote_journal::<u32>());
                let both = Rc::new(tokio::sync::Notify::new());
                let release = Rc::new(tokio::sync::Notify::new());
                let cursors = Rc::new(Held {
                    base: memory_cursor_store(),
                    count: Rc::new(Cell::new(0)),
                    both: Rc::clone(&both),
                    release: Rc::clone(&release),
                });
                let client = make_sync_client(
                    SyncClientOptions::new(Rc::clone(&remote), "r").with_cursors(cursors),
                );
                client.append("s", Rc::new(7)).await.unwrap();
                let first = client.sync("s");
                let second = client.sync("s");
                both.notified().await;
                release.notify_waiters();
                let (first, second) = tokio::join!(first, second);
                first.unwrap();
                second.unwrap();
                assert_eq!(
                    client
                        .log("s")
                        .iter()
                        .map(|entry| entry.seq)
                        .collect::<Vec<_>>(),
                    [1.0, 2.0, 1.0, 2.0]
                );
                client.append("s", Rc::new(9)).await.unwrap();
                assert!(client.pending("s").await.unwrap().is_empty());
                let entries = remote
                    .pull(PullRequest::<PlainData> {
                        token: None,
                        stream: "s".into(),
                        since: 0.0,
                    })
                    .await
                    .unwrap()
                    .entries;
                assert_eq!(
                    entries
                        .iter()
                        .map(|entry| *entry.record)
                        .collect::<Vec<_>>(),
                    [7, 7]
                );
            })
            .await
            .expect("both independent syncs must reach their cursor reads");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn cursor_failure_keeps_the_pushed_and_pulled_state_and_forwards_the_original_token() {
    use demlik_tea::data::JsText;
    use demlik_tea::journal::{
        JournalError,
        remote::{
            CursorStore, LocalWork, MemoryCursorStore, MemoryError, MemoryRemote, PullRequest,
            PullResult, PushRequest, PushResult, RemoteJournal, SyncFailure, memory_cursor_store,
        },
    };
    use std::cell::Cell;
    #[derive(Debug)]
    struct Refusal {
        _local: Rc<()>,
    }
    #[derive(Debug)]
    enum TransportProblem {
        Journal(MemoryError),
    }
    #[derive(Debug)]
    enum CursorProblem {
        Journal(MemoryError),
        Refused(Rc<Refusal>),
    }
    impl std::fmt::Display for TransportProblem {
        fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Journal(error) => error.fmt(output),
            }
        }
    }
    impl std::fmt::Display for CursorProblem {
        fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Journal(error) => error.fmt(output),
                Self::Refused(_) => output.write_str("cursor refused"),
            }
        }
    }
    struct Recording {
        inner: MemoryRemote<u32>,
        token: Rc<Token>,
        calls: Rc<RefCell<Vec<&'static str>>>,
    }
    impl RemoteJournal<u32, Token> for Recording {
        type Error = TransportProblem;
        fn push(&self, request: PushRequest<u32, Token>) -> LocalWork<PushResult, Self::Error> {
            assert!(Rc::ptr_eq(request.token.as_ref().unwrap(), &self.token));
            self.calls.borrow_mut().push("push");
            let receipt = self.inner.push(request);
            Box::pin(async move { receipt.await.map_err(TransportProblem::Journal) })
        }
        fn pull(&self, request: PullRequest<Token>) -> LocalWork<PullResult<u32>, Self::Error> {
            assert!(Rc::ptr_eq(request.token.as_ref().unwrap(), &self.token));
            self.calls.borrow_mut().push("pull");
            let receipt = self.inner.pull(request);
            Box::pin(async move { receipt.await.map_err(TransportProblem::Journal) })
        }
    }
    struct RefusingCursor {
        base: MemoryCursorStore,
        fail: Cell<bool>,
        refusal: Rc<Refusal>,
        calls: Rc<RefCell<Vec<&'static str>>>,
    }
    impl CursorStore for RefusingCursor {
        type Error = CursorProblem;
        fn get(&self, stream: JsText) -> LocalWork<f64, Self::Error> {
            self.calls.borrow_mut().push("cursor.get");
            let receipt = self.base.get(stream);
            Box::pin(async move { receipt.await.map_err(CursorProblem::Journal) })
        }
        fn set(&self, stream: JsText, seq: f64) -> LocalWork<(), Self::Error> {
            self.calls.borrow_mut().push("cursor.set");
            if self.fail.replace(false) {
                let refusal = Rc::clone(&self.refusal);
                return Box::pin(async move { Err(CursorProblem::Refused(refusal)) });
            }
            let receipt = self.base.set(stream, seq);
            Box::pin(async move { receipt.await.map_err(CursorProblem::Journal) })
        }
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            let token = Rc::new(Token {
                _local: Rc::new(()),
            });
            let calls = Rc::new(RefCell::new(Vec::new()));
            let remote = Rc::new(Recording {
                inner: memory_remote_journal(),
                token: Rc::clone(&token),
                calls: Rc::clone(&calls),
            });
            let refusal = Rc::new(Refusal {
                _local: Rc::new(()),
            });
            let base = memory_cursor_store();
            let cursors = Rc::new(RefusingCursor {
                base: base.clone(),
                fail: Cell::new(true),
                refusal: Rc::clone(&refusal),
                calls: Rc::clone(&calls),
            });
            let client = make_sync_client(
                SyncClientOptions::new(remote, "a")
                    .with_token(token)
                    .with_cursors(cursors),
            );
            client.append("s", Rc::new(7)).await.unwrap();
            let error = client.sync("s").await.unwrap_err();
            let JournalError::Backend(SyncFailure::CursorSet(CursorProblem::Refused(actual))) =
                error
            else {
                panic!("cursor refusal payload was lost")
            };
            assert!(Rc::ptr_eq(&actual, &refusal));
            assert_eq!(
                &*calls.borrow(),
                &["push", "cursor.get", "pull", "cursor.set"]
            );
            assert_eq!(
                client
                    .log("s")
                    .iter()
                    .map(|entry| entry.seq)
                    .collect::<Vec<_>>(),
                [1.0]
            );
            assert!(client.pending("s").await.unwrap().is_empty());
            assert_eq!(base.get("s".into()).await.unwrap(), 0.0);
            client.sync("s").await.unwrap();
            assert_eq!(&calls.borrow()[4..], &["cursor.get", "pull", "cursor.set"]);
            assert_eq!(
                client
                    .log("s")
                    .iter()
                    .map(|entry| entry.seq)
                    .collect::<Vec<_>>(),
                [1.0, 1.0]
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn cursor_numbers_and_remote_since_bounds_keep_ieee_values() {
    use demlik_tea::{
        PlainData,
        journal::remote::{
            AuthoredRecord, CursorStore, PullRequest, PushRequest, RemoteJournal,
            memory_cursor_store,
        },
    };
    tokio::task::LocalSet::new()
        .run_until(async {
            let cursor = memory_cursor_store();
            assert_eq!(cursor.get("missing".into()).await.unwrap(), 0.0);
            cursor.set("s".into(), f64::NAN).await.unwrap();
            assert!(cursor.get("s".into()).await.unwrap().is_nan());
            cursor.set("s".into(), -0.0).await.unwrap();
            assert!(cursor.get("s".into()).await.unwrap().is_sign_negative());
            let remote = memory_remote_journal::<u32>();
            let written = remote
                .push(PushRequest::<_, PlainData> {
                    token: None,
                    stream: "s".into(),
                    records: vec![Rc::new(AuthoredRecord {
                        author: "a".into(),
                        record: Rc::new(7),
                    })],
                })
                .await
                .unwrap();
            assert_eq!(written.seqs, [1.0]);
            for (since, expected) in [
                (f64::NAN, 0),
                (f64::INFINITY, 0),
                (f64::NEG_INFINITY, 1),
                (-0.0, 1),
                (1.0, 0),
            ] {
                assert_eq!(
                    remote
                        .pull(PullRequest::<PlainData> {
                            token: None,
                            stream: "s".into(),
                            since
                        })
                        .await
                        .unwrap()
                        .entries
                        .len(),
                    expected
                );
            }
        })
        .await;
}
