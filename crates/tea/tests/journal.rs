use demlik_tea::journal::memory_journal;
use std::{cell::RefCell, rc::Rc};

struct Record {
    items: Vec<&'static str>,
    _local: Rc<()>,
}

#[tokio::test(flavor = "current_thread")]
async fn an_opaque_record_keeps_its_reference_and_each_stream_has_its_own_order() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let journal = memory_journal::<RefCell<Record>>();
            let record = Rc::new(RefCell::new(Record {
                items: vec!["accepted"],
                _local: Rc::new(()),
            }));
            let first = journal.append("orders", Rc::clone(&record)).await.unwrap();
            let second = journal.append("orders", Rc::clone(&record)).await.unwrap();
            let other = journal.append("audit", Rc::clone(&record)).await.unwrap();
            assert_eq!(first.seq, 1.0);
            assert_eq!(second.seq, 2.0);
            assert_eq!(other.seq, 1.0);
            record.borrow_mut().items.push("confirmed");
            let entries = journal.list("orders").await.unwrap();
            assert_eq!(entries.len(), 2);
            assert!(Rc::ptr_eq(&entries[0].record, &record));
            assert_eq!(entries[0].record.borrow().items, ["accepted", "confirmed"]);
            assert!(journal.list("never-written").await.unwrap().is_empty());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn submitting_an_append_starts_work_even_before_its_receipt_is_awaited() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let journal = memory_journal::<u32>();
            let pending = journal.append("s", Rc::new(7));
            let old = journal.list("s").await.unwrap();
            let fresh = journal.list("s").await.unwrap();
            assert!(old.is_empty());
            assert_eq!(fresh.len(), 1);
            assert_eq!(*fresh[0].record, 7);
            assert_eq!(pending.await.unwrap().seq, 1.0);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_listener_refuses_the_receipt_after_persistence_and_stops_later_listeners() {
    use demlik_tea::journal::{ChangeListener, JournalError};
    use std::cell::Cell;
    struct ListenerFault {
        code: u8,
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            let journal = memory_journal::<u32>();
            let failing: Rc<ChangeListener<u32>> = Rc::new(|_| {
                std::panic::panic_any(ListenerFault { code: 7 });
            });
            let unsubscribe = journal.changes(failing);
            let calls = Rc::new(Cell::new(0));
            let counted = Rc::clone(&calls);
            let _last = journal.changes(Rc::new(move |_| counted.set(counted.get() + 1)));
            let error = journal.append("s", Rc::new(3)).await.unwrap_err();
            let JournalError::Panic(cause) = error else {
                panic!("listener payload was lost")
            };
            cause.with_payload(|payload| {
                assert_eq!(payload.downcast_ref::<ListenerFault>().unwrap().code, 7);
            });
            assert_eq!(calls.get(), 0);
            assert_eq!(journal.list("s").await.unwrap()[0].seq, 1.0);
            unsubscribe();
            unsubscribe();
            assert_eq!(journal.append("s", Rc::new(4)).await.unwrap().seq, 2.0);
            assert_eq!(calls.get(), 1);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn an_independent_append_waits_while_reentrant_work_keeps_the_held_stream() {
    use std::{convert::Infallible, time::Duration};
    tokio::task::LocalSet::new()
        .run_until(async {
            tokio::time::timeout(Duration::from_secs(2), async {
                let journal = memory_journal::<&'static str>();
                let inside = journal.clone();
                let (entered, has_lock) = tokio::sync::oneshot::channel();
                let (release, released) = tokio::sync::oneshot::channel();
                let first = journal.with_lock("s", move || async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    let nested = inside.clone();
                    let result = inside
                        .with_lock("s", move || async move {
                            Ok::<_, Infallible>(nested.append("s", Rc::new("A")).await.unwrap().seq)
                        })
                        .await
                        .unwrap();
                    Ok::<_, Infallible>(result)
                });
                has_lock.await.unwrap();
                let second = journal.append("s", Rc::new("B"));
                assert!(journal.list("s").await.unwrap().is_empty());
                assert!(journal.list("s").await.unwrap().is_empty());
                release.send(()).unwrap();
                assert_eq!(first.await.unwrap(), 1.0);
                assert_eq!(second.await.unwrap().seq, 2.0);
                let entries = journal.list("s").await.unwrap();
                assert_eq!(
                    entries
                        .iter()
                        .map(|entry| *entry.record)
                        .collect::<Vec<_>>(),
                    ["A", "B"]
                );
            })
            .await
            .expect("a reentrant append must not deadlock its own stream");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_detached_listener_respects_a_new_journals_own_lock_refusal() {
    use demlik_tea::{
        data::JsText,
        journal::{JournalBackend, JournalEntry, JournalError, MemoryBackend, make_journal},
    };
    use std::{cell::Cell, future::Future};
    struct Guarded {
        memory: Rc<MemoryBackend<u32>>,
        attempts: Rc<Cell<usize>>,
        refuse: bool,
    }
    impl JournalBackend<u32> for Guarded {
        type Error = &'static str;
        async fn read(&self, stream: JsText) -> Result<Vec<Rc<JournalEntry<u32>>>, Self::Error> {
            Ok(self.memory.read(stream).await.unwrap())
        }
        async fn append(
            &self,
            stream: JsText,
            record: Rc<u32>,
        ) -> Result<Rc<JournalEntry<u32>>, Self::Error> {
            Ok(self.memory.append(stream, record).await.unwrap())
        }
        async fn lock<T>(
            &self,
            _: JsText,
            effect: impl Future<Output = T>,
        ) -> Result<T, Self::Error> {
            self.attempts.set(self.attempts.get() + 1);
            if self.refuse {
                Err("new instance refused its writer lease")
            } else {
                Ok(effect.await)
            }
        }
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            let memory = Rc::new(MemoryBackend::default());
            let attempts = Rc::new(Cell::new(0));
            let journal = make_journal(Guarded {
                memory: Rc::clone(&memory),
                attempts: Rc::clone(&attempts),
                refuse: false,
            });
            let pending = Rc::new(RefCell::new(None));
            let written = Rc::clone(&pending);
            let underlying = Rc::clone(&memory);
            let counted = Rc::clone(&attempts);
            let _unsubscribe = journal.changes(Rc::new(move |_| {
                let independent = make_journal(Guarded {
                    memory: Rc::clone(&underlying),
                    attempts: Rc::clone(&counted),
                    refuse: true,
                });
                *written.borrow_mut() = Some(independent.append("s", Rc::new(2)));
            }));
            let accepted = journal.append("s", Rc::new(1));
            drop(journal);
            accepted.await.unwrap();
            let receipt = pending.borrow_mut().take().unwrap();
            let refused = receipt.await.unwrap_err();
            assert!(matches!(
                refused,
                JournalError::Backend("new instance refused its writer lease")
            ));
            assert_eq!(attempts.get(), 2);
            assert_eq!(memory.read("s".into()).await.unwrap().len(), 1);
        })
        .await;
}
