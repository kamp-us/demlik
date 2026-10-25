#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The fixture exercises the local runtime's owned Arc handles with opaque non-Send values."
)]
use demlik_tea::{
    Machine, NoCellError, PlainData, Step, Sub, Tagged, Update,
    core::{Cell as UpdateCell, Row},
    data::{DependencyError, JsText},
    durable_object::{
        self, DoStoreError, DoStoreOptions, EventLogRange, EventSourcedKeys, EventSourcedOptions,
        EventSourcedStore, SnapshotInput,
    },
    storage::{DeletableStore, Migrated, Store, refuse},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    io::{self, BufRead},
    pin::Pin,
    rc::Rc,
    sync::Arc,
    task::{Context, Waker},
};
#[allow(dead_code)]
#[path = "../../../tea/tests/support/controlled_storage.rs"]
mod controlled_storage;
#[allow(dead_code)]
#[path = "../../../tea/tests/support/durable_storage.rs"]
mod durable_storage;
#[allow(dead_code)]
#[path = "../paginate_queue/wire.rs"]
mod wire;
use controlled_storage::{
    Behavior, ControlledStorage, Gate, Operation, Rule, Stage, StorageFailure,
};
use durable_storage::Call;
use wire::{Number, data, normalized, number, text};
type Work<T> = Pin<Box<dyn Future<Output = T>>>;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Clone, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Text {
    Utf8(String),
    Units {
        #[serde(rename = "$utf16")]
        units: Vec<u16>,
    },
}
impl From<Text> for JsText {
    fn from(value: Text) -> Self {
        match value {
            Text::Utf8(value) => value.into(),
            Text::Units { units } => Self::from_units(units),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputRecord {
    id: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    key: Text,
    value: Value,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ParseMode {
    Default,
    Schema,
    Drop,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SerializeMode {
    Default,
    Watch,
    Undefined,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotConfig {
    key: Option<Text>,
    fenced: bool,
    parse: ParseMode,
    serialize: SerializeMode,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventConfig {
    every: Option<Number>,
    snapshot: Option<Text>,
    meta: Option<Text>,
    prefix: Option<Text>,
    parse: ParseMode,
    parse_event: ParseMode,
    active_init: bool,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum CommonAction {
    Seed {
        key: Text,
        value: Value,
    },
    Cells,
    Fault {
        at: Operation,
        key: Option<Text>,
        stage: Stage,
        message: String,
        value: Value,
    },
    CodecFault {
        at: String,
        message: String,
        value: Value,
    },
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Action<A> {
    Common(CommonAction),
    Specific(A),
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum SnapshotAction {
    Load,
    Save {
        model: String,
    },
    Migrate {
        value: Value,
    },
    Delete,
    LoadFenced,
    SaveFenced {
        model: String,
        expected: Number,
    },
    HeldSave {
        model: String,
        other: String,
        expected: Number,
        at: Operation,
        key: Option<Text>,
        stage: Stage,
    },
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum EventAction {
    Load,
    MigrateLoaded,
    Migrate {
        value: Value,
    },
    Save {
        model: String,
    },
    Append {
        message: String,
    },
    SnapshotNow,
    Read {
        from: Option<Number>,
        to: Option<Number>,
        limit: Option<usize>,
    },
    Restart,
    Mutate {
        model: String,
        field: String,
        value: Value,
    },
    MutateMessage {
        message: String,
        field: String,
        value: Value,
    },
    Parallel {
        messages: Vec<String>,
    },
    Delayed {
        message: String,
        model: String,
        field: String,
        value: Value,
    },
    Forget {
        message: String,
        model: String,
        wait: Text,
    },
    HeldAppend {
        message: String,
        model: String,
        replacement: String,
        at: Operation,
        key: Option<Text>,
        stage: Stage,
    },
    HeldSnapshot {
        model: String,
        replacement: String,
        at: Operation,
        key: Option<Text>,
        stage: Stage,
    },
}
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum Script {
    Snapshot {
        config: SnapshotConfig,
        models: Vec<InputRecord>,
        cells: Vec<Seed>,
        actions: Vec<Action<SnapshotAction>>,
    },
    Events {
        config: EventConfig,
        models: Vec<InputRecord>,
        messages: Vec<InputRecord>,
        cells: Vec<Seed>,
        actions: Vec<Action<EventAction>>,
    },
}
struct State {
    value: RefCell<PlainData>,
    tag: String,
    watched: bool,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        &self.tag
    }
}
struct Msg {
    value: RefCell<PlainData>,
    tag: String,
    watched: bool,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        &self.tag
    }
}
fn field(value: &PlainData, key: &str) -> PlainData {
    match value {
        PlainData::Object(values) => values.get(key).cloned().unwrap_or(PlainData::Undefined),
        _ => PlainData::Undefined,
    }
}
fn tag(value: &PlainData) -> String {
    match field(value, "type") {
        PlainData::String(value) => value.as_utf8().unwrap_or("(untagged state)").into(),
        _ => {
            if matches!(value, PlainData::Null | PlainData::Undefined) {
                "(no state)".into()
            } else {
                "(untagged state)".into()
            }
        }
    }
}
fn state(value: PlainData, watched: bool) -> Arc<State> {
    Arc::new(State {
        tag: tag(&value),
        value: RefCell::new(value),
        watched,
    })
}
fn message(value: PlainData, watched: bool) -> Arc<Msg> {
    let watched = watched && matches!(value, PlainData::Object(_));
    Arc::new(Msg {
        tag: tag(&value),
        value: RefCell::new(value),
        watched,
    })
}
fn numeric(value: &PlainData, key: &str, fallback: f64) -> f64 {
    match field(value, key) {
        PlainData::Number(value) => value,
        _ => fallback,
    }
}
fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
#[derive(Clone, Debug)]
struct Issue {
    at: String,
    message: String,
    value: PlainData,
}
impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
#[derive(Debug)]
struct Failure {
    comparison: Value,
    diagnostic: Box<Value>,
}
impl Failure {
    fn new(comparison: Value) -> Self {
        Self {
            diagnostic: Box::new(comparison.clone()),
            comparison,
        }
    }
}
fn issue(error: &Issue) -> Failure {
    Failure::new(
        json!({"kind":"codec","at":error.at,"message":error.message,"value":normalized(&error.value)}),
    )
}
fn dependency(error: &DependencyError) -> Failure {
    Failure::new(json!({"kind":"type","message":error.to_string()}))
}
fn no_cell(error: &NoCellError) -> Value {
    json!({"kind":"noCell","msgType":error.msg_type,"stateName":error.state_name,"acceptedTypes":error.accepted_types,"message":error.message})
}
fn failed<C>(error: &DoStoreError<StorageFailure, C>, codec: impl Fn(&C) -> Failure) -> Failure {
    match error {
        DoStoreError::Storage { operation, cause } => Failure::new(
            json!({"kind":"storage","at":operation,"stage":cause.stage.name(),"message":cause.message,"value":normalized(&cause.value)}),
        ),
        DoStoreError::Json { raw, cause } => Failure {
            comparison: json!({"kind":"syntax"}),
            diagnostic: Box::new(
                json!({"kind":"syntax","raw":normalized(raw),"message":cause.to_string()}),
            ),
        },
        DoStoreError::Coercion(error) => {
            Failure::new(json!({"kind":"type","message":error.message}))
        }
        DoStoreError::Encode(error) | DoStoreError::Ready(error) => codec(error),
        DoStoreError::Conflict(error) => Failure::new(
            json!({"kind":"conflict","expected":number(error.expected_version),"actual":number(error.actual_version),"message":error.to_string()}),
        ),
        DoStoreError::InvalidVersion(raw) => {
            Failure::new(json!({"kind":"invalidVersion","raw":normalized(raw)}))
        }
        DoStoreError::Fold(error) => Failure::new(no_cell(error)),
        DoStoreError::Panic(error) => {
            Failure::new(json!({"kind":"nativePanic","message":error.summary}))
        }
        DoStoreError::HostClosed => Failure::new(json!({"kind":"hostClosed"})),
    }
}
struct Shared {
    storage: Rc<ControlledStorage>,
    models: BTreeMap<String, Arc<State>>,
    messages: BTreeMap<String, Arc<Msg>>,
    calls: Calls,
    hooks: RefCell<Vec<Value>>,
    diagnostics: RefCell<Vec<Value>>,
    faults: RefCell<BTreeMap<String, Issue>>,
}
impl Shared {
    fn new(
        models: Vec<InputRecord>,
        messages: Vec<InputRecord>,
        cells: Vec<Seed>,
        watched: bool,
    ) -> Rc<Self> {
        let storage = Rc::new(ControlledStorage::new());
        for seed in cells {
            storage
                .inner
                .seed(JsText::from(seed.key), data(&seed.value));
        }
        Rc::new(Self {
            storage,
            models: models
                .into_iter()
                .map(|record| (record.id, state(data(&record.value), watched)))
                .collect(),
            messages: messages
                .into_iter()
                .map(|record| (record.id, message(data(&record.value), watched)))
                .collect(),
            calls: Rc::new(RefCell::new(Vec::new())),
            hooks: RefCell::new(Vec::new()),
            diagnostics: RefCell::new(Vec::new()),
            faults: RefCell::new(BTreeMap::new()),
        })
    }
    fn cells(&self) -> Value {
        json!(
            self.storage
                .inner
                .cells()
                .iter()
                .map(|(key, value)| json!([text(key), normalized(value)]))
                .collect::<Vec<_>>()
        )
    }
    fn callbacks(&self) -> Vec<Value> {
        std::mem::take(&mut *self.hooks.borrow_mut())
    }
    fn trace(&self) -> Vec<Value> {
        std::mem::take(&mut *self.storage.inner.calls.borrow_mut())
            .into_iter()
            .map(|call| match call {
                Call::Get(key) => json!({"op":"get","key":text(&key)}),
                Call::Put(key, value) => {
                    json!({"op":"put","key":text(&key),"value":normalized(&value)})
                }
                Call::Delete(keys) => {
                    json!({"op":"delete","keys":keys.iter().map(text).collect::<Vec<_>>()})
                }
                Call::List(prefix) => json!({"op":"list","prefix":text(&prefix)}),
                Call::Begin => json!({"op":"transactionBegin"}),
                Call::Commit => json!({"op":"transactionCommit"}),
                Call::Rollback => json!({"op":"transactionRollback"}),
                Call::Control(value) => normalized(&value),
            })
            .collect()
    }
    fn row(&self, result: Result<Value, Failure>) -> Value {
        let result = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                self.diagnostics.borrow_mut().push(*error.diagnostic);
                json!({"ok":false,"error":error.comparison})
            }
        };
        json!({"result":result,"calls":self.trace(),"callbacks":self.callbacks(),"cells":self.cells()})
    }
    fn common(&self, action: CommonAction) -> Result<Value, Failure> {
        match action {
            CommonAction::Seed { key, value } => {
                self.storage.inner.seed(JsText::from(key), data(&value));
                Ok(Value::Null)
            }
            CommonAction::Cells => Ok(self.cells()),
            CommonAction::Fault {
                at,
                key,
                stage,
                message,
                value,
            } => {
                self.storage.rule(Rule {
                    operation: at,
                    key: key.map(Into::into),
                    stage,
                    remaining: 1,
                    behavior: Behavior::Fail {
                        message,
                        value: Rc::new(data(&value)),
                    },
                });
                Ok(Value::Null)
            }
            CommonAction::CodecFault { at, message, value } => {
                self.faults.borrow_mut().insert(
                    at.clone(),
                    Issue {
                        at,
                        message,
                        value: data(&value),
                    },
                );
                Ok(Value::Null)
            }
        }
    }
    fn fault(&self, at: &str) -> Result<(), Issue> {
        match self.faults.borrow_mut().remove(at) {
            Some(issue) => Err(issue),
            None => Ok(()),
        }
    }
    fn codec(&self, at: &str, value: &PlainData) -> Result<PlainData, Issue> {
        self.hooks
            .borrow_mut()
            .push(json!({"op":at,"value":normalized(value)}));
        self.fault(at)?;
        Ok(value.clone())
    }
}
fn submit<T: 'static>(effect: impl Future<Output = T> + 'static) -> Work<T> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut worker = Box::pin(async move {
        let result = effect.await;
        let _ = sender.send(result);
    });
    if worker
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending()
    {
        tokio::task::spawn_local(worker);
    }
    Box::pin(async move { receiver.await.expect("fixture host remains alive") })
}
fn machine(shared: Rc<Shared>, active: bool) -> Machine<'static, Arc<State>, Msg, (), Sub, ()> {
    let initialize = Rc::clone(&shared);
    let subscriptions = Rc::clone(&shared);
    let mut row: Row<'static, Arc<State>, Msg, ()> = Row::new();
    for name in ["set", "add", "clear"] {
        let shared = Rc::clone(&shared);
        let cell: UpdateCell<'static, Arc<State>, Msg, ()> = Box::new(move |current, msg| {
            let current = current.value.borrow();
            let msg = msg.value.borrow();
            shared.hooks.borrow_mut().push(
                json!({"op":"update","state":normalized(&current),"message":normalized(&msg)}),
            );
            let n = numeric(&current, "n", 0.0);
            let (value, n) = match name {
                "set" => (field(&msg, "value"), n + 1.0),
                "clear" => (PlainData::Null, n + 1.0),
                "add" => (
                    match &*current {
                        PlainData::Object(fields) => {
                            fields.get("value").cloned().unwrap_or(PlainData::Null)
                        }
                        _ => PlainData::Null,
                    },
                    n + numeric(&msg, "by", 1.0),
                ),
                _ => unreachable!(),
            };
            Step::new(
                state(
                    object([
                        ("type", PlainData::String("state".into())),
                        ("n", PlainData::Number(n)),
                        ("value", value),
                    ]),
                    true,
                ),
                vec![],
            )
        });
        row.insert(name.into(), cell);
    }
    Machine {
        init: Box::new(move |loaded, _| {
            let loaded: Option<Arc<State>> = loaded;
            initialize.hooks.borrow_mut().push(json!({"op":"init","loaded":loaded.as_ref().map_or(Value::Null,|state|normalized(&state.value.borrow()))}));
            let next = match loaded {
                Some(current) if active => {
                    let mut raw = current.value.borrow().clone();
                    let n = numeric(&raw, "n", 0.0) + 100.0;
                    if let PlainData::Object(fields) = &mut raw {
                        fields.insert("n".into(), PlainData::Number(n));
                    }
                    state(raw, true)
                }
                Some(current) => current,
                None => state(
                    object([
                        ("type", PlainData::String("state".into())),
                        ("n", PlainData::Number(0.0)),
                        ("value", PlainData::Null),
                    ]),
                    true,
                ),
            };
            Step::new(next, vec![])
        }),
        update: Update::RawReducer(row),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Arc<State>| {
            subscriptions
                .hooks
                .borrow_mut()
                .push(json!({"op":"subs","state":normalized(&state.value.borrow())}));
            vec![]
        }),
    }
}
type Events = EventSourcedStore<'static, State, Msg, (), Sub, (), ControlledStorage, Issue>;
fn event_store(shared: &Rc<Shared>, config: &EventConfig) -> Result<Events, Failure> {
    let parse_context = Rc::clone(shared);
    let parse_mode = config.parse;
    let event_context = Rc::clone(shared);
    let event_mode = config.parse_event;
    let model_context = Rc::clone(shared);
    let message_context = Rc::clone(shared);
    let ready_context = Rc::clone(shared);
    let mut options = EventSourcedOptions::new(
        move |input: SnapshotInput<State>| {
            let (value, existing) = match input {
                SnapshotInput::Stored(value) => (value, None),
                SnapshotInput::Recovered(state) => {
                    let value = state.value.borrow().clone();
                    (value, Some(state))
                }
            };
            if !matches!(parse_mode, ParseMode::Default) {
                parse_context
                    .hooks
                    .borrow_mut()
                    .push(json!({"op":"parse","value":normalized(&value)}));
            }
            let accepts = match parse_mode {
                ParseMode::Default => matches!(value, PlainData::Object(_)),
                ParseMode::Schema => {
                    matches!((&value,field(&value,"type"),field(&value,"n")),(PlainData::Object(_),PlainData::String(kind),PlainData::Number(_))if kind.as_utf8()==Some("state"))
                }
                ParseMode::Drop => false,
            };
            accepts.then(|| existing.unwrap_or_else(|| state(value, false)))
        },
        move |value| {
            if !matches!(event_mode, ParseMode::Default) {
                event_context
                    .hooks
                    .borrow_mut()
                    .push(json!({"op":"parseEvent","value":normalized(&value)}));
            }
            let kind = field(&value, "type");
            let accepts = matches!(
                (&value, &kind),
                (PlainData::Object(_), PlainData::String(_))
            ) && match event_mode {
                ParseMode::Default => true,
                ParseMode::Schema => {
                    matches!(kind,PlainData::String(kind)if matches!(kind.as_utf8(),Some("set"|"add"|"clear")))
                }
                ParseMode::Drop => false,
            };
            accepts.then(|| Msg {
                tag: tag(&value),
                value: RefCell::new(value),
                watched: false,
            })
        },
        move |current: &State| {
            let value = current.value.borrow();
            if current.watched {
                model_context.codec("encodeState", &value)
            } else {
                Ok(value.clone())
            }
        },
        move |msg: &Msg| {
            let value = msg.value.borrow();
            if msg.watched {
                message_context.codec("encodeEvent", &value)
            } else {
                Ok(value.clone())
            }
        },
    );
    options.snapshot_every = config.every.map(Number::value);
    options.keys = EventSourcedKeys {
        snapshot: config.snapshot.clone().map(Into::into),
        meta: config.meta.clone().map(Into::into),
        event_prefix: config.prefix.clone().map(Into::into),
    };
    options.on_ready = Some(Box::new(move |state| {
        ready_context
            .hooks
            .borrow_mut()
            .push(json!({"op":"ready","state":normalized(&state.value.borrow())}));
        ready_context.fault("ready")
    }));
    observe!(
        &shared.calls,
        durable_object::do_event_sourced_store,
        Rc::clone(&shared.storage),
        Rc::new(machine(Rc::clone(shared), config.active_init)),
        Rc::new(()),
        options
    )
    .map_err(|error| {
        Failure::new(json!({"kind":"error","name":"Error","message":error.to_string()}))
    })
}
async fn execute_events(
    config: EventConfig,
    models: Vec<InputRecord>,
    messages: Vec<InputRecord>,
    cells: Vec<Seed>,
    actions: Vec<Action<EventAction>>,
) -> Value {
    let shared = Shared::new(models, messages, cells, true);
    let mut rows = Vec::new();
    let mut last = None;
    let mut store = match event_store(&shared, &config) {
        Ok(store) => store,
        Err(error) => {
            return json!({"comparison":[shared.row(Err(error))],"diagnostics":*shared.diagnostics.borrow(),"observedRustCalls":*shared.calls.borrow()});
        }
    };
    for action in actions {
        let result = match action {
            Action::Common(action) => shared.common(action),
            Action::Specific(action) => match action {
                EventAction::Load => match observe!(&shared.calls, Store::load, &store.store).await
                {
                    Ok(SnapshotInput::Recovered(value)) => {
                        let result = normalized(&value.value.borrow());
                        last = Some(value);
                        Ok(result)
                    }
                    Ok(SnapshotInput::Stored(_)) => unreachable!(),
                    Err(error) => Err(failed(&error, issue)),
                },
                EventAction::MigrateLoaded => {
                    let current = Arc::clone(last.as_ref().expect("load before migrateLoaded"));
                    let migrated = observe!(
                        &shared.calls,
                        Store::migrate,
                        &store.store,
                        SnapshotInput::Recovered(Arc::clone(&current))
                    );
                    Ok(match migrated {
                        Migrated::Fresh => json!({"kind":"fresh"}),
                        Migrated::State(value) => {
                            json!({"kind":"state","value":normalized(&value.value.borrow()),"same":Arc::ptr_eq(&value,&current)})
                        }
                        Migrated::Refused(value) => json!({"kind":"refused","reason":value.reason}),
                    })
                }
                EventAction::Migrate { value } => Ok(
                    match observe!(
                        &shared.calls,
                        Store::migrate,
                        &store.store,
                        SnapshotInput::Stored(data(&value))
                    ) {
                        Migrated::Fresh => json!({"kind":"fresh"}),
                        Migrated::State(value) => {
                            json!({"kind":"state","value":normalized(&value.value.borrow())})
                        }
                        Migrated::Refused(value) => json!({"kind":"refused","reason":value.reason}),
                    },
                ),
                EventAction::Save { model } => observe!(
                    &shared.calls,
                    Store::save,
                    &store.store,
                    &shared.models[&model]
                )
                .await
                .map(|()| Value::Null)
                .map_err(|error| failed(&error, issue)),
                EventAction::Append { message } => observe!(
                    &shared.calls,
                    EventSourcedStore::append,
                    &store,
                    Arc::clone(&shared.messages[&message])
                )
                .await
                .map(|()| Value::Null)
                .map_err(|error| failed(&error, issue)),
                EventAction::SnapshotNow => {
                    observe!(&shared.calls, EventSourcedStore::snapshot_now, &store)
                        .await
                        .map(Value::Bool)
                        .map_err(|error| failed(&error, issue))
                }
                EventAction::Read { from, to, limit } => {
                    let mut reader = observe!(
                        &shared.calls,
                        EventSourcedStore::read_events,
                        &store,
                        EventLogRange {
                            from_seq: from.map(Number::value),
                            to_seq: to.map(Number::value)
                        }
                    );
                    let mut result = Ok(Vec::new());
                    while result
                        .as_ref()
                        .is_ok_and(|rows| limit.is_none_or(|limit| rows.len() < limit))
                    {
                        match observe!(&shared.calls,durable_object::ReadEvents::next,&mut reader).await{None=>break,Some(Ok(row))=>result.as_mut().unwrap().push(json!({"seq":number(row.seq),"event":normalized(&row.event.value.borrow())})),Some(Err(error))=>{let partial=std::mem::take(result.as_mut().unwrap());let mut failure=failed(&error,issue);failure.comparison=json!({"partial":partial,"cause":failure.comparison});result=Err(failure);}}
                    }
                    result.map(|rows| json!(rows))
                }
                EventAction::Restart => {
                    last = None;
                    match event_store(&shared, &config) {
                        Ok(value) => {
                            store = value;
                            Ok(Value::Null)
                        }
                        Err(error) => Err(error),
                    }
                }
                EventAction::Mutate {
                    model,
                    field,
                    value,
                } => {
                    let mut raw = shared.models[&model].value.borrow_mut();
                    let PlainData::Object(fields) = &mut *raw else {
                        panic!("model mutation requires object")
                    };
                    fields.insert(field.into(), data(&value));
                    Ok(Value::Null)
                }
                EventAction::MutateMessage {
                    message,
                    field,
                    value,
                } => {
                    let mut raw = shared.messages[&message].value.borrow_mut();
                    let PlainData::Object(fields) = &mut *raw else {
                        panic!("message mutation requires object")
                    };
                    fields.insert(field.into(), data(&value));
                    Ok(Value::Null)
                }
                EventAction::Parallel { messages } => {
                    let receipts = messages
                        .into_iter()
                        .map(|id| {
                            observe!(
                                &shared.calls,
                                EventSourcedStore::append,
                                &store,
                                Arc::clone(&shared.messages[&id])
                            )
                        })
                        .collect::<Vec<_>>();
                    let mut results = Vec::new();
                    for receipt in receipts {
                        results.push(match receipt.await {
                            Ok(()) => json!({"ok":true}),
                            Err(error) => {
                                let error = failed(&error, issue);
                                shared.diagnostics.borrow_mut().push(*error.diagnostic);
                                json!({"ok":false,"error":error.comparison})
                            }
                        });
                    }
                    Ok(json!(results))
                }
                EventAction::Delayed {
                    message,
                    model,
                    field,
                    value,
                } => {
                    let append = observe!(
                        &shared.calls,
                        EventSourcedStore::append,
                        &store,
                        Arc::clone(&shared.messages[&message])
                    );
                    let manual = observe!(&shared.calls, EventSourcedStore::snapshot_now, &store);
                    let prefix = shared.trace();
                    drop(observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&model]
                    ));
                    if let PlainData::Object(fields) =
                        &mut *shared.models[&model].value.borrow_mut()
                    {
                        fields.insert(field.into(), data(&value));
                    }
                    let appended = append.await.map_err(|error| failed(&error, issue));
                    let snapshot = manual.await.map_err(|error| failed(&error, issue));
                    match (appended, snapshot) {
                        (Ok(()), Ok(value)) => Ok(json!({"prefix":prefix,"manual":value})),
                        (Err(error), _) | (_, Err(error)) => Err(error),
                    }
                }
                EventAction::Forget {
                    message,
                    model,
                    wait,
                } => {
                    observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&model]
                    )
                    .await
                    .unwrap();
                    drop(observe!(
                        &shared.calls,
                        EventSourcedStore::append,
                        &store,
                        Arc::clone(&shared.messages[&message])
                    ));
                    shared
                        .storage
                        .inner
                        .wait_for_cell(JsText::from(wait), |raw| {
                            matches!(raw, PlainData::String(_))
                        })
                        .await;
                    match observe!(&shared.calls, Store::load, &store.store).await {
                        Ok(SnapshotInput::Recovered(value)) => {
                            Ok(normalized(&value.value.borrow()))
                        }
                        Ok(SnapshotInput::Stored(_)) => unreachable!(),
                        Err(error) => Err(failed(&error, issue)),
                    }
                }
                EventAction::HeldAppend {
                    message,
                    model,
                    replacement,
                    at,
                    key,
                    stage,
                } => {
                    observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&model]
                    )
                    .await
                    .unwrap();
                    let gate = Rc::new(Gate::new("append"));
                    shared.storage.rule(Rule {
                        operation: at,
                        key: key.map(Into::into),
                        stage,
                        remaining: 1,
                        behavior: Behavior::Hold(Rc::clone(&gate)),
                    });
                    let receipt = observe!(
                        &shared.calls,
                        EventSourcedStore::append,
                        &store,
                        Arc::clone(&shared.messages[&message])
                    );
                    gate.wait(1).await;
                    let held = shared.cells();
                    drop(observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&replacement]
                    ));
                    gate.release();
                    receipt
                        .await
                        .map(|()| json!({"held":held}))
                        .map_err(|error| failed(&error, issue))
                }
                EventAction::HeldSnapshot {
                    model,
                    replacement,
                    at,
                    key,
                    stage,
                } => {
                    observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&model]
                    )
                    .await
                    .unwrap();
                    let gate = Rc::new(Gate::new("snapshot"));
                    shared.storage.rule(Rule {
                        operation: at,
                        key: key.map(Into::into),
                        stage,
                        remaining: 1,
                        behavior: Behavior::Hold(Rc::clone(&gate)),
                    });
                    let receipt = observe!(&shared.calls, EventSourcedStore::snapshot_now, &store);
                    gate.wait(1).await;
                    let held = shared.cells();
                    drop(observe!(
                        &shared.calls,
                        Store::save,
                        &store.store,
                        &shared.models[&replacement]
                    ));
                    gate.release();
                    receipt
                        .await
                        .map(|value| json!({"held":held,"written":value}))
                        .map_err(|error| failed(&error, issue))
                }
            },
        };
        rows.push(shared.row(result));
    }
    json!({"comparison":rows,"diagnostics":*shared.diagnostics.borrow(),"observedRustCalls":*shared.calls.borrow()})
}

#[derive(serde::Serialize)]
#[serde(transparent)]
struct SnapshotModel(PlainData);
fn snapshot_parse(
    shared: Rc<Shared>,
    mode: ParseMode,
) -> impl Fn(PlainData) -> Migrated<SnapshotModel> {
    move |value| {
        shared
            .hooks
            .borrow_mut()
            .push(json!({"op":"migrate","value":normalized(&value)}));
        if matches!(value, PlainData::Null) || matches!(mode, ParseMode::Drop) {
            return Migrated::Fresh;
        }
        if matches!(mode, ParseMode::Schema)
            && !matches!((&value,field(&value,"type"),field(&value,"n")),(PlainData::Object(_),PlainData::String(kind),PlainData::Number(_))if kind.as_utf8()==Some("state"))
        {
            return Migrated::Refused(refuse("expected state record"));
        }
        Migrated::State(SnapshotModel(value))
    }
}
async fn snapshot_action<P, C>(
    store: Rc<P>,
    shared: Rc<Shared>,
    action: SnapshotAction,
    codec: fn(&C) -> Failure,
) -> Result<Value, Failure>
where
    P: Store<SnapshotModel, Raw = PlainData, Error = DoStoreError<StorageFailure, C>>
        + DeletableStore<SnapshotModel>
        + 'static,
    C: 'static,
{
    match action {
        SnapshotAction::Load => observe!(&shared.calls, Store::load, &*store)
            .await
            .map(|value| normalized(&value))
            .map_err(|error| failed(&error, codec)),
        SnapshotAction::Save { model } => {
            let value = SnapshotModel(shared.models[&model].value.borrow().clone());
            observe!(&shared.calls, Store::save, &*store, &value)
                .await
                .map(|()| Value::Null)
                .map_err(|error| failed(&error, codec))
        }
        SnapshotAction::Migrate { value } => Ok(
            match observe!(&shared.calls, Store::migrate, &*store, data(&value)) {
                Migrated::Fresh => json!({"kind":"fresh"}),
                Migrated::State(value) => json!({"kind":"state","value":normalized(&value.0)}),
                Migrated::Refused(value) => json!({"kind":"refused","reason":value.reason}),
            },
        ),
        SnapshotAction::Delete => observe!(&shared.calls, DeletableStore::delete, &*store)
            .await
            .map(|()| Value::Null)
            .map_err(|error| failed(&error, codec)),
        SnapshotAction::LoadFenced => {
            let fenced = store.fencing().expect("fenced script");
            observe!(
                &shared.calls,
                demlik_tea::storage::Fencing::load_fenced,
                fenced
            )
            .await
            .map(|value| json!({"raw":normalized(&value.raw),"version":number(value.version)}))
            .map_err(|error| failed(&error, codec))
        }
        SnapshotAction::SaveFenced { model, expected } => {
            let value = SnapshotModel(shared.models[&model].value.borrow().clone());
            let fenced = store.fencing().expect("fenced script");
            observe!(
                &shared.calls,
                demlik_tea::storage::Fencing::save_fenced,
                fenced,
                &value,
                expected.value()
            )
            .await
            .map(number)
            .map_err(|error| failed(&error, codec))
        }
        SnapshotAction::HeldSave { .. } => {
            unreachable!("compound held action handled at its host boundary")
        }
    }
}
async fn snapshot_loop<P, C>(
    store: P,
    shared: Rc<Shared>,
    config: SnapshotConfig,
    actions: Vec<Action<SnapshotAction>>,
    codec: fn(&C) -> Failure,
) -> Value
where
    P: Store<SnapshotModel, Raw = PlainData, Error = DoStoreError<StorageFailure, C>>
        + DeletableStore<SnapshotModel>
        + 'static,
    C: 'static,
{
    let store = Rc::new(store);
    let mut rows = Vec::new();
    for action in actions {
        let result = match action {
            Action::Common(action) => shared.common(action),
            Action::Specific(SnapshotAction::HeldSave {
                model,
                other,
                expected,
                at,
                key,
                stage,
            }) => {
                let gate = Rc::new(Gate::new("save"));
                shared.storage.rule(Rule {
                    operation: at,
                    key: key.map(Into::into),
                    stage,
                    remaining: 1,
                    behavior: Behavior::Hold(Rc::clone(&gate)),
                });
                let first = if config.fenced {
                    SnapshotAction::SaveFenced { model, expected }
                } else {
                    SnapshotAction::Save { model }
                };
                let first = submit(snapshot_action(
                    Rc::clone(&store),
                    Rc::clone(&shared),
                    first,
                    codec,
                ));
                gate.wait(1).await;
                let held = shared.cells();
                let second = if config.fenced {
                    SnapshotAction::SaveFenced {
                        model: other,
                        expected,
                    }
                } else {
                    SnapshotAction::Save { model: other }
                };
                let second = submit(snapshot_action(
                    Rc::clone(&store),
                    Rc::clone(&shared),
                    second,
                    codec,
                ));
                if config.fenced {
                    let waiting = shared.storage.transaction_requests();
                    let while_held = shared.cells();
                    gate.release();
                    let first = first.await;
                    let second = second.await;
                    Ok(
                        json!({"held":held,"whileHeld":while_held,"requested":waiting,"first":nested(&shared,first),"second":nested(&shared,second)}),
                    )
                } else {
                    let second = second.await;
                    let while_held = shared.cells();
                    gate.release();
                    let first = first.await;
                    Ok(
                        json!({"held":held,"whileHeld":while_held,"first":nested(&shared,first),"second":nested(&shared,second)}),
                    )
                }
            }
            Action::Specific(action) => {
                snapshot_action(Rc::clone(&store), Rc::clone(&shared), action, codec).await
            }
        };
        rows.push(shared.row(result));
    }
    json!({"comparison":rows,"diagnostics":*shared.diagnostics.borrow(),"observedRustCalls":*shared.calls.borrow()})
}
fn nested(shared: &Shared, result: Result<Value, Failure>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => {
            shared.diagnostics.borrow_mut().push(*error.diagnostic);
            json!({"ok":false,"error":error.comparison})
        }
    }
}
async fn execute(script: Script) -> Value {
    match script {
        Script::Events {
            config,
            models,
            messages,
            cells,
            actions,
        } => execute_events(config, models, messages, cells, actions).await,
        Script::Snapshot {
            config,
            models,
            cells,
            actions,
        } => {
            let shared = Shared::new(models, vec![], cells, false);
            let parse = snapshot_parse(Rc::clone(&shared), config.parse);
            let options = DoStoreOptions {
                key: config.key.clone().map(Into::into),
            };
            match config.serialize {
                SerializeMode::Default => {
                    let store = observe!(
                        &shared.calls,
                        durable_object::do_store,
                        Rc::clone(&shared.storage),
                        parse,
                        options
                    );
                    if config.fenced {
                        let store = observe!(&shared.calls, durable_object::DoStore::fenced, store);
                        snapshot_loop(store, shared, config, actions, dependency).await
                    } else {
                        snapshot_loop(store, shared, config, actions, dependency).await
                    }
                }
                SerializeMode::Watch | SerializeMode::Undefined => {
                    let context = Rc::clone(&shared);
                    let mode = config.serialize;
                    let encode = move |model: &SnapshotModel| {
                        let value = context.codec("serialize", &model.0)?;
                        Ok::<_, Issue>(if matches!(mode, SerializeMode::Undefined) {
                            PlainData::Undefined
                        } else {
                            value
                        })
                    };
                    let store = observe!(
                        &shared.calls,
                        durable_object::do_store_with,
                        Rc::clone(&shared.storage),
                        parse,
                        encode,
                        options
                    );
                    if config.fenced {
                        let store = observe!(&shared.calls, durable_object::DoStore::fenced, store);
                        snapshot_loop(store, shared, config, actions, issue).await
                    } else {
                        snapshot_loop(store, shared, config, actions, issue).await
                    }
                }
            }
        }
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let script: Script =
            serde_json::from_str(&line).expect("validated durable storage action script");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::task::LocalSet::new().run_until(execute(script)),
        )
        .await
        .expect("controlled storage handshake completes");
        println!("{output}");
    }
}
