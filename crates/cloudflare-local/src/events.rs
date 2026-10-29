//! Actual SDK consumer of the generic cmdless event journal.
#![allow(
    clippy::arc_with_non_send_sync,
    reason = "Local opaque state is retained without a Send requirement."
)]
use super::{BindingError, SdkStorage, binding_error, host_error};
use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    data::plain_data,
    durable_object::{
        DoStoreError, DurableObjectStorage, EventLogRange, EventSourcedOptions, EventSourcedStore,
        SnapshotInput, do_event_sourced_store,
    },
    storage::{Migrated, Store, StoredCell},
};
use futures::task::noop_waker_ref;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
    task::Context,
};
use worker::{
    Delay, Response, js_sys,
    wasm_bindgen::{JsValue, closure::Closure},
};

type Value = serde_json::Value;
struct Model {
    count: f64,
    owner: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "counting"
    }
}
struct Msg {
    by: f64,
    _owner: Rc<()>,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "inc"
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["inc"];
}
type Journal = EventSourcedStore<
    'static,
    Model,
    Msg,
    (),
    Sub,
    (),
    SdkStorage,
    demlik_tea::data::DependencyError,
>;
fn model(count: f64) -> Arc<Model> {
    Arc::new(Model {
        count,
        owner: Rc::new(()),
    })
}
fn message(by: f64) -> Arc<Msg> {
    Arc::new(Msg {
        by,
        _owner: Rc::new(()),
    })
}
fn view(state: &Model) -> Value {
    serde_json::json!({"type":"counting", "count":state.count})
}
fn event(msg: &Msg) -> Value {
    serde_json::json!({"type":"inc", "by":msg.by})
}
fn machine() -> Machine<'static, Arc<Model>, Msg, (), Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_else(|| model(0.0)), vec![])),
        update: Update::reducer(|state: &Arc<Model>, msg: &Msg| {
            Step::new(
                Arc::new(Model {
                    count: state.count + msg.by,
                    owner: Rc::clone(&state.owner),
                }),
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredModel {
    r#type: String,
    count: f64,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredMsg {
    r#type: String,
    by: f64,
}
fn parse(input: SnapshotInput<Model>) -> Option<Arc<Model>> {
    match input {
        SnapshotInput::Recovered(state) => Some(state),
        SnapshotInput::Stored(raw) => {
            let value: StoredModel =
                serde_json::from_value(serde_json::to_value(raw).ok()?).ok()?;
            (value.r#type == "counting" && value.count.is_finite() && value.count.fract() == 0.0)
                .then(|| model(value.count))
        }
    }
}
fn parse_event(raw: PlainData) -> Option<Msg> {
    let value: StoredMsg = serde_json::from_value(serde_json::to_value(raw).ok()?).ok()?;
    (value.r#type == "inc" && value.by.is_finite() && value.by.fract() == 0.0).then(|| Msg {
        by: value.by,
        _owner: Rc::new(()),
    })
}
fn make_store(storage: Rc<SdkStorage>, ready: Rc<Cell<u32>>) -> Journal {
    let mut options = EventSourcedOptions::new(
        parse,
        parse_event,
        |state| plain_data(&view(state)),
        |msg| plain_data(&event(msg)),
    );
    options.snapshot_every = Some(3.0);
    options.on_ready = Some(Box::new(move |_| {
        ready.set(ready.get() + 1);
        Ok(())
    }));
    do_event_sourced_store(storage, Rc::new(machine()), Rc::new(()), options)
        .expect("valid snapshot cadence")
}
fn journal_error(
    error: DoStoreError<BindingError, demlik_tea::data::DependencyError>,
) -> worker::Error {
    match error {
        DoStoreError::Storage { cause, .. } => binding_error(cause),
        other => host_error(other),
    }
}
fn text(raw: &str) -> StoredCell {
    StoredCell::String(raw.into())
}

pub(super) struct EventJournal {
    storage: Rc<SdkStorage>,
    ready: Rc<Cell<u32>>,
    journal: RefCell<Journal>,
}
impl EventJournal {
    pub(super) fn new(storage: SdkStorage) -> Self {
        let storage = Rc::new(storage);
        let ready = Rc::new(Cell::new(0));
        let journal = RefCell::new(make_store(Rc::clone(&storage), Rc::clone(&ready)));
        Self {
            storage,
            ready,
            journal,
        }
    }
    async fn cells(&self) -> worker::Result<Value> {
        let rows = self.storage.list("".into()).await.map_err(binding_error)?;
        let rows: Vec<_> = rows
            .into_iter()
            .map(|(key, value)| (key, value.snapshot()))
            .collect();
        serde_json::to_value(rows).map_err(host_error)
    }
    async fn wait_for(&self, key: &str, expected: &str) -> worker::Result<()> {
        for _ in 0..100 {
            if self.storage.storage.get::<String>(key).await?.as_deref() == Some(expected) {
                return Ok(());
            }
            Delay::from(std::time::Duration::from_millis(1)).await;
        }
        Err(host_error("dropped journal work did not complete"))
    }
    pub(super) async fn command(&self, body: &str) -> worker::Result<Response> {
        #[derive(serde::Deserialize)]
        #[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
        enum Command {
            Seed {},
            State {},
            Snapshot {},
            DropSnapshot {},
            Delete {},
            WrongSnapshot {},
            RestoreSnapshot {},
            StaleTail {},
            RestoreTail {},
            Malformed {},
            RestoreRow {},
            SdkFailure {},
            Step { by: f64 },
            DropStep { by: f64 },
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            return Response::error("invalid event command", 400);
        };
        if let Command::Step { by } | Command::DropStep { by } = command
            && (!by.is_finite() || by.fract() != 0.0 || !(-100.0..=100.0).contains(&by))
        {
            return Response::error("invalid event increment", 400);
        }
        let mut outcome = Value::Null;
        match command {
            Command::Seed {} => self
                .storage
                .put("unrelated/keep".into(), text("kept"))
                .await
                .map_err(binding_error)?,
            Command::Delete {} => {
                let rows = self
                    .storage
                    .list("@@es/evt/".into())
                    .await
                    .map_err(binding_error)?;
                let mut keys: Vec<_> = rows.into_iter().map(|(key, _)| key).collect();
                keys.extend(["@@es/meta".into(), "@@es/snapshot".into()]);
                self.storage.delete(keys).await.map_err(binding_error)?;
                *self.journal.borrow_mut() =
                    make_store(Rc::clone(&self.storage), Rc::clone(&self.ready));
            }
            Command::WrongSnapshot {} | Command::RestoreSnapshot {} => {
                let seq = if matches!(command, Command::WrongSnapshot {}) {
                    2
                } else {
                    3
                };
                self.storage
                    .put(
                        "@@es/snapshot".into(),
                        text(&format!(
                            "{{\"seq\":{seq},\"state\":{{\"type\":\"counting\",\"count\":6}}}}"
                        )),
                    )
                    .await
                    .map_err(binding_error)?;
            }
            Command::StaleTail {} | Command::RestoreTail {} => {
                let by = if matches!(command, Command::StaleTail {}) {
                    40
                } else {
                    4
                };
                self.storage
                    .put(
                        "@@es/evt/0000000000000004".into(),
                        text(&format!("{{\"type\":\"inc\",\"by\":{by}}}")),
                    )
                    .await
                    .map_err(binding_error)?;
            }
            Command::Malformed {} => self
                .storage
                .put("@@es/evt/0000000000000006".into(), text("{broken}"))
                .await
                .map_err(binding_error)?,
            Command::RestoreRow {} => self
                .storage
                .delete(vec!["@@es/evt/0000000000000006".into()])
                .await
                .map_err(binding_error)?,
            _ => {}
        }
        let es = self.journal.borrow().clone();
        if matches!(command, Command::SdkFailure {}) {
            let storage: JsValue = self.storage.storage.as_raw().into();
            let original = js_sys::Reflect::get(&storage, &"get".into())?;
            let cause: JsValue = js_sys::Error::new("injected event get failure").into();
            let captured = cause.clone();
            let callback = Closure::wrap(Box::new(move || js_sys::Promise::reject(&captured))
                as Box<dyn FnMut() -> js_sys::Promise>);
            if !js_sys::Reflect::set(&storage, &"get".into(), callback.as_ref())? {
                return Err(host_error("get fault refused"));
            }
            let result = es.store.load().await;
            if !js_sys::Reflect::set(&storage, &"get".into(), &original)? {
                return Err(host_error("get restore refused"));
            }
            match result {
                Err(DoStoreError::Storage {
                    operation,
                    cause:
                        BindingError::Sdk(
                            worker::Error::UnknownJsError { original, .. }
                            | worker::Error::Internal(original),
                        ),
                }) => {
                    outcome = serde_json::json!({"kind":"storage", "operation":operation, "original_error":js_sys::Object::is(&cause, &original)});
                }
                Err(other) => return Err(journal_error(other)),
                Ok(_) => return Err(host_error("get failure unexpectedly accepted")),
            }
        }
        let mut state = match es.store.load().await {
            Ok(raw) => match es.store.migrate(raw) {
                Migrated::State(state) => state,
                _ => return Err(host_error("unrecognized recovered model")),
            },
            Err(DoStoreError::Json { .. }) if matches!(command, Command::Malformed {}) => {
                return Response::from_json(
                    &serde_json::json!({"outcome":{"kind":"json"}, "ready_calls":self.ready.get(), "cells":self.cells().await?}),
                );
            }
            Err(other) => return Err(journal_error(other)),
        };
        match command {
            Command::Step { by } | Command::DropStep { by } => {
                let msg = message(by);
                state = machine()
                    .update
                    .apply(&state, &msg)
                    .map_err(host_error)?
                    .state;
                es.store.save(&state).await.map_err(journal_error)?;
                let meta = self.storage.storage.get::<String>("@@es/meta").await?;
                let seq = match meta {
                    Some(raw) => {
                        serde_json::from_str::<Value>(&raw).map_err(host_error)?["lastSeq"]
                            .as_u64()
                            .ok_or_else(|| host_error("invalid fixture sequence"))?
                            + 1
                    }
                    None => 1,
                };
                let mut submitted = es.append(msg);
                if matches!(command, Command::DropStep { .. }) {
                    let pending = submitted
                        .as_mut()
                        .poll(&mut Context::from_waker(noop_waker_ref()))
                        .is_pending();
                    if !pending {
                        return Err(host_error("append receipt must first be pending"));
                    }
                    drop(submitted);
                    self.wait_for("@@es/meta", &format!("{{\"lastSeq\":{seq}}}"))
                        .await?;
                    if seq % 3 == 0 {
                        self.wait_for("@@es/snapshot", &format!("{{\"seq\":{seq},\"state\":{{\"type\":\"counting\",\"count\":{}}}}}", state.count)).await?;
                    }
                    worker::console_log!(
                        "{}",
                        serde_json::json!({"event":"dropped_append", "first_poll_pending":pending, "seq":seq})
                    );
                    outcome = serde_json::json!({"kind":"dropped-append", "completed":true});
                } else {
                    submitted.await.map_err(journal_error)?;
                }
            }
            Command::Snapshot {} | Command::DropSnapshot {} => {
                es.store.save(&state).await.map_err(journal_error)?;
                let mut submitted = es.snapshot_now();
                if matches!(command, Command::DropSnapshot {}) {
                    let pending = submitted
                        .as_mut()
                        .poll(&mut Context::from_waker(noop_waker_ref()))
                        .is_pending();
                    if !pending {
                        return Err(host_error("snapshot receipt must first be pending"));
                    }
                    drop(submitted);
                    let raw = self
                        .storage
                        .storage
                        .get::<String>("@@es/meta")
                        .await?
                        .ok_or_else(|| host_error("missing fixture meta"))?;
                    let seq = serde_json::from_str::<Value>(&raw).map_err(host_error)?["lastSeq"]
                        .as_u64()
                        .ok_or_else(|| host_error("invalid fixture sequence"))?;
                    self.wait_for(
                        "@@es/snapshot",
                        &format!(
                            "{{\"seq\":{seq},\"state\":{{\"type\":\"counting\",\"count\":{}}}}}",
                            state.count
                        ),
                    )
                    .await?;
                    worker::console_log!(
                        "{}",
                        serde_json::json!({"event":"dropped_snapshot", "first_poll_pending":pending, "seq":seq})
                    );
                    outcome = serde_json::json!({"kind":"dropped-snapshot", "completed":true});
                } else {
                    outcome =
                        serde_json::json!({"snapshot":submitted.await.map_err(journal_error)?});
                }
            }
            _ => {}
        }
        self.storage.storage.sync().await?;
        let mut events = vec![];
        let mut reader = es.read_events(EventLogRange::default());
        while let Some(row) = reader.next().await {
            let row = row.map_err(journal_error)?;
            events.push(serde_json::json!({"seq":row.seq, "event":event(&row.event)}));
        }
        let mut window = vec![];
        let mut reader = es.read_events(EventLogRange {
            from_seq: Some(2.0),
            to_seq: Some(4.0),
        });
        while let Some(row) = reader.next().await {
            let row = row.map_err(journal_error)?;
            window.push(serde_json::json!({"seq":row.seq, "event":event(&row.event)}));
        }
        Response::from_json(
            &serde_json::json!({"model":view(&state), "outcome":outcome, "ready_calls":self.ready.get(), "events":events, "window":window, "cells":self.cells().await?}),
        )
    }
}
