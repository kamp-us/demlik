#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The event store retains Arc snapshots without requiring opaque local models or messages to be Send."
)]
use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandFamily},
    core::Message,
    data::JsText,
    durable_object::{
        DoStoreError, EventLogRange, EventSourcedOptions, SnapshotInput, do_event_sourced_store,
    },
    runtime::{NoInterpreter, NoSubscriptions, Options, Persistence, Profile, launch},
    storage::{Migrated, Store},
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
#[allow(dead_code)]
#[path = "support/durable_storage.rs"]
mod durable_storage;
use durable_storage::{Call, MemoryStorage};
struct Model {
    count: Cell<f64>,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "counting"
    }
}
struct Msg {
    by: f64,
    local: Rc<()>,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "inc"
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["inc"];
}
enum Never {}
impl Tagged for Never {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Never {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, _: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
type InitCalls = Rc<RefCell<Vec<(bool, f64)>>>;
fn model(count: f64) -> Arc<Model> {
    Arc::new(Model {
        count: Cell::new(count),
        local: Rc::new(()),
    })
}
fn message(by: f64) -> Arc<Msg> {
    Arc::new(Msg {
        by,
        local: Rc::new(()),
    })
}
fn machine(active: bool, inits: InitCalls) -> Machine<'static, Arc<Model>, Msg, Never, Sub, ()> {
    Machine {
        init: Box::new(move |loaded, _| {
            let loaded: Option<Arc<Model>> = loaded;
            inits.borrow_mut().push((
                loaded.is_some(),
                loaded.as_ref().map_or(0.0, |s| s.count.get()),
            ));
            Step::new(
                match loaded {
                    Some(state) if active => model(state.count.get() + 100.0),
                    Some(state) => state,
                    None => model(0.0),
                },
                vec![],
            )
        }),
        update: Update::reducer(|state: &Arc<Model>, msg: &Msg| {
            let _opaque = &msg.local;
            Step::new(
                Arc::new(Model {
                    count: Cell::new(state.count.get() + msg.by),
                    local: Rc::clone(&state.local),
                }),
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
fn parse(input: SnapshotInput<Model>) -> Option<Arc<Model>> {
    match input {
        SnapshotInput::Recovered(state) => Some(state),
        SnapshotInput::Stored(PlainData::Object(fields)) => match fields.get("count") {
            Some(PlainData::Number(value)) => Some(model(*value)),
            _ => None,
        },
        SnapshotInput::Stored(_) => None,
    }
}
fn parse_event(raw: PlainData) -> Option<Msg> {
    let PlainData::Object(fields) = raw else {
        return None;
    };
    let (Some(PlainData::String(kind)), Some(PlainData::Number(by))) =
        (fields.get("type"), fields.get("by"))
    else {
        return None;
    };
    (kind.as_utf8() == Some("inc")).then(|| Msg {
        by: *by,
        local: Rc::new(()),
    })
}
fn encode_model(state: &Model) -> Result<PlainData, &'static str> {
    Ok(PlainData::Object(indexmap::IndexMap::from([
        ("type".into(), PlainData::String("counting".into())),
        ("count".into(), PlainData::Number(state.count.get())),
    ])))
}
fn encode_event(msg: &Msg) -> Result<PlainData, &'static str> {
    Ok(PlainData::Object(indexmap::IndexMap::from([
        ("type".into(), PlainData::String("inc".into())),
        ("by".into(), PlainData::Number(msg.by)),
    ])))
}
fn options(every: f64) -> EventSourcedOptions<'static, Model, Msg, &'static str> {
    let mut options = EventSourcedOptions::new(parse, parse_event, encode_model, encode_event);
    options.snapshot_every = Some(every);
    options
}
fn text(raw: &PlainData) -> &str {
    let PlainData::String(value) = raw else {
        panic!("stored cell must be JSON text")
    };
    value.as_utf8().unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn opaque_cmdless_runtime_restarts_from_snapshot_then_tail_without_reinitializing_the_snapshot()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let storage = Rc::new(MemoryStorage::new());
                let inits = Rc::new(RefCell::new(vec![]));
                let recovered = Rc::new(RefCell::new(Vec::new()));
                let seen = Rc::clone(&recovered);
                let mut config = options(2.0);
                config.on_ready = Some(Box::new(move |state| {
                    seen.borrow_mut().push(state);
                    Ok(())
                }));
                let es = do_event_sourced_store(
                    Rc::clone(&storage),
                    Rc::new(machine(false, Rc::clone(&inits))),
                    Rc::new(()),
                    config,
                )
                .unwrap();
                let mut config: Options<
                    Arc<Model>,
                    Msg,
                    DoStoreError<Infallible, &'static str>,
                    Infallible,
                > = Options::new(profile);
                config.store = Some(Persistence::new(es.store.clone()));
                let runtime = launch(
                    machine(false, Rc::clone(&inits)),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    config,
                );
                runtime.ready().await.unwrap();
                let pending = Rc::new(RefCell::new(Vec::new()));
                let appends = Rc::clone(&pending);
                let writer = es.clone();
                let _off = runtime.observe_retained(move |msg, _| {
                    appends.borrow_mut().push(writer.append(Arc::clone(msg)))
                });
                for by in [1.0, 2.0, 3.0] {
                    runtime
                        .dispatch(Msg {
                            by,
                            local: Rc::new(()),
                        })
                        .await
                        .unwrap();
                    let receipts = std::mem::take(&mut *pending.borrow_mut());
                    for receipt in receipts {
                        receipt.await.unwrap();
                    }
                }
                assert_eq!(runtime.get_state().unwrap().count.get(), 6.0);
                runtime.stop().await;
                assert_eq!(recovered.borrow().len(), 1);
                assert_eq!(recovered.borrow()[0].count.get(), 0.0);
                assert_eq!(
                    text(&storage.cells()[&JsText::from("@@es/snapshot")]),
                    "{\"seq\":2,\"state\":{\"type\":\"counting\",\"count\":3}}"
                );
                let inits = Rc::new(RefCell::new(vec![]));
                let ready = Rc::new(RefCell::new(vec![]));
                let seen = Rc::clone(&ready);
                let mut config = options(2.0);
                config.on_ready = Some(Box::new(move |state| {
                    seen.borrow_mut().push(state);
                    Ok(())
                }));
                let reopened = do_event_sourced_store(
                    Rc::clone(&storage),
                    Rc::new(machine(true, Rc::clone(&inits))),
                    Rc::new(()),
                    config,
                )
                .unwrap();
                let mut config: Options<
                    Arc<Model>,
                    Msg,
                    DoStoreError<Infallible, &'static str>,
                    Infallible,
                > = Options::new(profile);
                config.store = Some(Persistence::new(reopened.store.clone()));
                let resumed = launch(
                    machine(true, Rc::clone(&inits)),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    config,
                );
                resumed.ready().await.unwrap();
                assert_eq!(resumed.get_state().unwrap().count.get(), 106.0);
                assert_eq!(*inits.borrow(), [(true, 6.0)]);
                assert_eq!(ready.borrow().len(), 1);
                assert_eq!(ready.borrow()[0].count.get(), 6.0);
                let mut reader = reopened.read_events(EventLogRange::default());
                let mut seqs = Vec::new();
                while let Some(row) = reader.next().await {
                    seqs.push(row.unwrap().seq);
                }
                assert_eq!(
                    seqs,
                    [1.0, 2.0, 3.0],
                    "snapshot must not truncate the event log"
                );
                resumed.stop().await;
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn cold_parallel_appends_keep_the_source_overwrite_and_each_read_the_uncached_meta() {
    tokio::task::LocalSet::new().run_until(async {
        let storage=Rc::new(MemoryStorage::new());
        let es=do_event_sourced_store(Rc::clone(&storage),Rc::new(machine(false,Rc::new(RefCell::new(vec![])))),Rc::new(()),options(100.0)).unwrap();
        let a=es.append(message(1.0));let b=es.append(message(2.0));
        assert!(matches!(storage.calls.borrow().as_slice(),[Call::Get(a),Call::Get(b)]if a.as_utf8()==Some("@@es/meta")&&b.as_utf8()==Some("@@es/meta")));
        a.await.unwrap();b.await.unwrap();
        let cells=storage.cells();assert_eq!(cells.len(),2);
        assert_eq!(text(&cells[&JsText::from("@@es/evt/0000000000000001")]),"{\"type\":\"inc\",\"by\":2}");
        assert_eq!(text(&cells[&JsText::from("@@es/meta")]),"{\"lastSeq\":1}");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn eager_save_and_awaited_meta_pair_a_delayed_append_with_the_latest_retained_model() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let storage = Rc::new(MemoryStorage::new());
            let es = do_event_sourced_store(
                Rc::clone(&storage),
                Rc::new(machine(false, Rc::new(RefCell::new(vec![])))),
                Rc::new(()),
                options(1.0),
            )
            .unwrap();
            es.store.load().await.unwrap();
            drop(es.store.save(&model(1.0)));
            storage.calls.borrow_mut().clear();
            let receipt = es.append(message(1.0));
            let manual = es.snapshot_now();
            assert!(
                storage.calls.borrow().is_empty(),
                "cached ensureLastSeq still returns through an await"
            );
            let latest = model(9.0);
            drop(es.store.save(&latest));
            latest.count.set(10.0);
            receipt.await.unwrap();
            assert!(!manual.await.unwrap());
            assert_eq!(
                text(&storage.cells()[&JsText::from("@@es/snapshot")]),
                "{\"seq\":1,\"state\":{\"type\":\"counting\",\"count\":10}}"
            );
            assert!(!es.snapshot_now().await.unwrap());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn ignored_observer_receipts_continue_until_the_host_has_written_the_checkpoint() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let storage = Rc::new(MemoryStorage::new());
            let es = do_event_sourced_store(
                Rc::clone(&storage),
                Rc::new(machine(false, Rc::new(RefCell::new(vec![])))),
                Rc::new(()),
                options(1.0),
            )
            .unwrap();
            let mut config: Options<
                Arc<Model>,
                Msg,
                DoStoreError<Infallible, &'static str>,
                Infallible,
            > = Options::new(Profile::Promise);
            config.store = Some(Persistence::new(es.store.clone()));
            let runtime = launch(
                machine(false, Rc::new(RefCell::new(vec![]))),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                config,
            );
            runtime.ready().await.unwrap();
            let _off = runtime.observe_retained(move |msg, _| drop(es.append(Arc::clone(msg))));
            runtime
                .dispatch(Msg {
                    by: 5.0,
                    local: Rc::new(()),
                })
                .await
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(2),
                storage.wait_for_cell("@@es/snapshot", |raw| matches!(raw, PlainData::String(_))),
            )
            .await
            .expect("submitted append must outlive its receipt");
            assert_eq!(
                text(&storage.cells()[&JsText::from("@@es/snapshot")]),
                "{\"seq\":1,\"state\":{\"type\":\"counting\",\"count\":5}}"
            );
            runtime.stop().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn read_events_is_lazy_inclusive_and_can_stop_before_a_later_bad_row() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let storage = Rc::new(MemoryStorage::new());
            for (seq, raw) in [
                (1, "{\"type\":\"inc\",\"by\":1}"),
                (2, "null"),
                (3, "{\"type\":\"inc\",\"by\":3}"),
                (4, "{broken}"),
            ] {
                storage.seed(format!("@@es/evt/{seq:016}"), PlainData::String(raw.into()));
            }
            let es = do_event_sourced_store(
                Rc::clone(&storage),
                Rc::new(machine(false, Rc::new(RefCell::new(vec![])))),
                Rc::new(()),
                options(100.0),
            )
            .unwrap();
            let mut bounded = es.read_events(EventLogRange {
                from_seq: Some(1.0),
                to_seq: Some(3.0),
            });
            assert!(storage.calls.borrow().is_empty());
            assert_eq!(bounded.next().await.unwrap().unwrap().seq, 1.0);
            assert_eq!(bounded.next().await.unwrap().unwrap().seq, 3.0);
            assert!(bounded.next().await.is_none());
            let mut all = es.read_events(EventLogRange::default());
            assert_eq!(all.next().await.unwrap().unwrap().seq, 1.0);
            assert_eq!(all.next().await.unwrap().unwrap().seq, 3.0);
            assert!(matches!(
                all.next().await,
                Some(Err(DoStoreError::Json { .. }))
            ));
            assert!(all.next().await.is_none());
            assert!(storage.calls.borrow().iter().all(
                |call| matches!(call,Call::List(prefix)if prefix.as_utf8()==Some("@@es/evt/"))
            ));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn ready_failure_sets_the_latch_before_returning_the_original_failure() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let count = Rc::new(Cell::new(0));
            let calls = Rc::clone(&count);
            let mut config = options(100.0);
            config.on_ready = Some(Box::new(move |_| {
                calls.set(calls.get() + 1);
                Err("ready hook failed")
            }));
            let es = do_event_sourced_store(
                Rc::new(MemoryStorage::new()),
                Rc::new(machine(false, Rc::new(RefCell::new(vec![])))),
                Rc::new(()),
                config,
            )
            .unwrap();
            assert!(matches!(
                es.store.load().await,
                Err(DoStoreError::Ready("ready hook failed"))
            ));
            let Migrated::State(state) = es.store.migrate(es.store.load().await.unwrap()) else {
                panic!("known live state must migrate")
            };
            assert_eq!(state.count.get(), 0.0);
            assert_eq!(count.get(), 1);
        })
        .await;
}
