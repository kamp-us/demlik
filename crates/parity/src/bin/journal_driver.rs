use demlik_tea::journal::{
    self, ChangeListener, FileBackend, FileJournalError, Journal, JournalEntry, JournalError,
    MemoryBackend,
};
use demlik_tea::storage::PanicCause;
use demlik_tea::{PlainData, data::JsText};
use std::pin::Pin;
type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    convert::Infallible,
    future::Future,
    io::{self, BufRead},
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{data, normalized, text};
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
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Outcome {
    Ok,
    Error { value: Value },
}
#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    On { listener: String, handle: String },
    Off { handle: String },
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum FailureMode {
    None,
    Throw { error: Value },
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Listener {
    id: String,
    first: Vec<Change>,
    failure: FailureMode,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Parser {
    Identity,
    Wrap,
    RefuseNull { issue: Value },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Append {
        stream: Text,
        record: String,
        receipt: String,
    },
    PeerAppend {
        stream: Text,
        record: String,
        receipt: String,
    },
    Submit {
        stream: Text,
        record: String,
        receipt: String,
    },
    Await {
        receipt: String,
    },
    Forget {
        receipt: String,
    },
    List {
        stream: Text,
    },
    Prefix {
        stream: Text,
        record: String,
    },
    Batch {
        stream: Text,
        records: Vec<String>,
    },
    Push {
        record: String,
        value: Value,
    },
    On {
        listener: String,
        handle: String,
    },
    Off {
        handle: String,
    },
    Restart,
    Seed {
        filename: String,
        contents: String,
    },
    Bytes {
        filename: String,
    },
    Held {
        stream: Text,
        peer: bool,
        nested: bool,
        first: String,
        second: String,
        outcome: Outcome,
    },
    LockError {
        stream: Text,
        error: Value,
    },
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Adapter {
    Memory,
    File,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    adapter: Adapter,
    parse: Parser,
    records: Vec<Record>,
    listeners: Vec<Listener>,
    actions: Vec<Action>,
}
type Payload = RefCell<PlainData>;
type ParserFn = Box<dyn Fn(PlainData) -> Result<Payload, PlainData>>;
#[derive(Clone)]
enum Handle {
    Memory(Journal<Payload, MemoryBackend<Payload>>),
    File(Journal<Payload, FileBackend<Payload, ParserFn>>),
}
#[derive(Debug)]
struct Failure {
    value: Value,
    diagnostic: Value,
}
impl Failure {
    fn raw(value: Value) -> Self {
        Self {
            diagnostic: value.clone(),
            value,
        }
    }
}
fn panic_failure(cause: PanicCause) -> Failure {
    let value = cause.with_payload(|payload| {
        if let Some(value) = payload.downcast_ref::<PlainData>() {
            normalized(value)
        } else {
            json!({"kind":"error","name":"Error","message":cause.summary})
        }
    });
    Failure::raw(value)
}
fn file_failure(error: FileJournalError<PlainData>) -> Failure {
    match error {
        FileJournalError::Parse { cause, .. } => Failure::raw(normalized(&cause)),
        FileJournalError::StreamEncoding { .. } => {
            Failure::raw(json!({"kind":"uri","message":"URI malformed"}))
        }
        FileJournalError::NullEnvelope { .. } => Failure::raw(
            json!({"kind":"error","name":"TypeError","message":"Cannot read properties of null (reading 'seq')"}),
        ),
        FileJournalError::File(error) => {
            let value = if error.name() == "SyntaxError" {
                json!({"kind":"syntax"})
            } else if let Some(code) = error.code() {
                json!({"kind":"io","code":code})
            } else {
                json!({"kind":"error","name":error.name(),"message":error.to_string()})
            };
            Failure {
                value,
                diagnostic: serde_json::to_value(error).unwrap(),
            }
        }
    }
}
fn core_failure<E, F>(
    error: JournalError<E, F>,
    backend: impl FnOnce(E) -> Failure,
    effect: impl FnOnce(F) -> Failure,
) -> Failure {
    match error {
        JournalError::Backend(error) => backend(error),
        JournalError::Effect(error) => effect(error),
        JournalError::Panic(cause) => panic_failure(cause),
        JournalError::HostClosed => Failure::raw(
            json!({"kind":"error","name":"JournalHostClosed","message":"journal host closed before the operation settled"}),
        ),
    }
}
fn impossible(value: Infallible) -> Failure {
    match value {}
}
fn memory_failure<F>(
    error: JournalError<Infallible, F>,
    effect: impl FnOnce(F) -> Failure,
) -> Failure {
    core_failure(error, impossible, effect)
}
impl Handle {
    fn append(
        &self,
        stream: JsText,
        record: Rc<Payload>,
        calls: &Calls,
    ) -> LocalBoxFuture<'static, Result<Value, Failure>> {
        match self {
            Self::Memory(journal) => {
                let receipt = observe!(calls, Journal::append, journal, stream, record);
                Box::pin(async move {
                    receipt
                        .await
                        .map(|value| json!({"seq":normalized(value.seq.raw())}))
                        .map_err(|error| memory_failure(error, impossible))
                })
            }
            Self::File(journal) => {
                let receipt = observe!(calls, Journal::append, journal, stream, record);
                Box::pin(async move {
                    receipt
                        .await
                        .map(|value| json!({"seq":normalized(value.seq.raw())}))
                        .map_err(|error| core_failure(error, file_failure, impossible))
                })
            }
        }
    }
    fn list(
        &self,
        stream: JsText,
        calls: &Calls,
    ) -> LocalBoxFuture<'static, Result<Value, Failure>> {
        let encode = |entries: Vec<Rc<JournalEntry<Payload>>>| {
            Value::Array(entries.iter().map(|entry|json!({"stream":text(&entry.stream),"seq":normalized(entry.seq.raw()),"record":wire::snapshot(&*entry.record.borrow())})).collect())
        };
        match self {
            Self::Memory(journal) => {
                let receipt = observe!(calls, Journal::list, journal, stream);
                Box::pin(async move {
                    receipt
                        .await
                        .map(encode)
                        .map_err(|error| memory_failure(error, impossible))
                })
            }
            Self::File(journal) => {
                let receipt = observe!(calls, Journal::list, journal, stream);
                Box::pin(async move {
                    receipt
                        .await
                        .map(encode)
                        .map_err(|error| core_failure(error, file_failure, impossible))
                })
            }
        }
    }
    fn changes(
        &self,
        listener: Rc<ChangeListener<Payload>>,
        calls: &Calls,
    ) -> demlik_tea::runtime::Unsubscribe {
        match self {
            Self::Memory(journal) => observe!(calls, Journal::changes, journal, listener),
            Self::File(journal) => observe!(calls, Journal::changes, journal, listener),
        }
    }
    fn with_lock<Fut: Future<Output = Result<Value, Value>> + 'static>(
        &self,
        stream: JsText,
        effect: impl FnOnce() -> Fut + 'static,
        calls: &Calls,
    ) -> LocalBoxFuture<'static, Result<Value, Failure>> {
        match self {
            Self::Memory(journal) => {
                let receipt = observe!(calls, Journal::with_lock, journal, stream, effect);
                Box::pin(async move {
                    receipt
                        .await
                        .map_err(|error| memory_failure(error, Failure::raw))
                })
            }
            Self::File(journal) => {
                let receipt = observe!(calls, Journal::with_lock, journal, stream, effect);
                Box::pin(async move {
                    receipt
                        .await
                        .map_err(|error| core_failure(error, file_failure, Failure::raw))
                })
            }
        }
    }
}
struct Context {
    adapter: Adapter,
    parser: Parser,
    directory: PathBuf,
    calls: Calls,
    current: RefCell<Option<Handle>>,
    records: std::collections::BTreeMap<String, Rc<Payload>>,
    callbacks: RefCell<std::collections::BTreeMap<String, Rc<ChangeListener<Payload>>>>,
    handles: RefCell<std::collections::BTreeMap<String, demlik_tea::runtime::Unsubscribe>>,
    counts: RefCell<std::collections::BTreeMap<String, usize>>,
    events: RefCell<Vec<Value>>,
    parses: Rc<RefCell<Vec<Value>>>,
    diagnostics: Rc<RefCell<Vec<Value>>>,
}
impl Context {
    fn make(&self) -> Handle {
        match self.adapter {
            Adapter::Memory => Handle::Memory(observe!(self.calls, journal::memory_journal)),
            Adapter::File => {
                let mode = self.parser.clone();
                let parses = Rc::clone(&self.parses);
                let parse: ParserFn = Box::new(move |raw| {
                    parses.borrow_mut().push(normalized(&raw));
                    let parsed = match &mode {
                        Parser::Identity => raw,
                        Parser::Wrap => {
                            PlainData::Object([("wrapped".into(), raw)].into_iter().collect())
                        }
                        Parser::RefuseNull { issue } => {
                            if matches!(raw, PlainData::Null | PlainData::Undefined) {
                                return Err(data(issue));
                            }
                            raw
                        }
                    };
                    Ok(RefCell::new(parsed))
                });
                Handle::File(observe!(
                    self.calls,
                    journal::file_journal,
                    self.directory.clone(),
                    parse
                ))
            }
        }
    }
    fn journal(&self) -> Handle {
        self.current.borrow().as_ref().unwrap().clone()
    }
    fn record(&self, id: &str) -> Rc<Payload> {
        Rc::clone(self.records.get(id).expect("validated record reference"))
    }
    fn on(&self, listener: &str, handle: String) {
        let callback = Rc::clone(
            self.callbacks
                .borrow()
                .get(listener)
                .expect("validated listener reference"),
        );
        let unsubscribe = self.journal().changes(callback, &self.calls);
        self.handles.borrow_mut().insert(handle, unsubscribe);
    }
    fn off(&self, handle: &str) {
        self.handles
            .borrow()
            .get(handle)
            .expect("validated handle reference")();
    }
    fn settled(
        &self,
        task: LocalBoxFuture<'static, Result<Value, Failure>>,
    ) -> LocalBoxFuture<'static, Value> {
        let diagnostics = Rc::clone(&self.diagnostics);
        Box::pin(async move {
            match task.await {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => {
                    diagnostics.borrow_mut().push(error.diagnostic);
                    json!({"ok":false,"error":error.value})
                }
            }
        })
    }
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "demlik-journal-trace-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn undefined() -> Value {
    json!({"$undefined":true})
}
async fn execute(script: Script) -> Value {
    let directory = Directory::new();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let context = Rc::new(Context {
        adapter: script.adapter,
        parser: script.parse,
        directory: directory.0.clone(),
        calls: Rc::clone(&calls),
        current: RefCell::new(None),
        records: script
            .records
            .into_iter()
            .map(|record| (record.id, Rc::new(RefCell::new(data(&record.value)))))
            .collect(),
        callbacks: RefCell::new(std::collections::BTreeMap::new()),
        handles: RefCell::new(std::collections::BTreeMap::new()),
        counts: RefCell::new(std::collections::BTreeMap::new()),
        events: RefCell::new(Vec::new()),
        parses: Rc::new(RefCell::new(Vec::new())),
        diagnostics: Rc::new(RefCell::new(Vec::new())),
    });
    *context.current.borrow_mut() = Some(context.make());
    for cfg in script.listeners {
        let weak = Rc::downgrade(&context);
        let id = cfg.id.clone();
        let callback: Rc<ChangeListener<Payload>> = Rc::new(move |entry| {
            let context = weak.upgrade().unwrap();
            let count = {
                let mut counts = context.counts.borrow_mut();
                let count = counts.entry(cfg.id.clone()).or_default();
                *count += 1;
                *count
            };
            context.events.borrow_mut().push(json!({"listener":cfg.id,"call":count,"stream":text(&entry.stream),"seq":normalized(entry.seq.raw()),"record":wire::snapshot(&*entry.record.borrow())}));
            if count == 1 {
                for action in &cfg.first {
                    match action {
                        Change::On { listener, handle } => context.on(listener, handle.clone()),
                        Change::Off { handle } => context.off(handle),
                    }
                }
            }
            if let FailureMode::Throw { error } = &cfg.failure {
                std::panic::panic_any(data(error));
            }
        });
        context.callbacks.borrow_mut().insert(id, callback);
    }
    let mut rows = Vec::new();
    let mut pending = std::collections::BTreeMap::<String, LocalBoxFuture<'static, Value>>::new();
    for action in script.actions {
        let op = match &action {
            Action::Append { .. } => "append",
            Action::PeerAppend { .. } => "peerAppend",
            Action::Submit { .. } => "submit",
            Action::Await { .. } => "await",
            Action::Forget { .. } => "forget",
            Action::List { .. } => "list",
            Action::Prefix { .. } => "prefix",
            Action::Batch { .. } => "batch",
            Action::Push { .. } => "push",
            Action::On { .. } => "on",
            Action::Off { .. } => "off",
            Action::Restart => "restart",
            Action::Seed { .. } => "seed",
            Action::Bytes { .. } => "bytes",
            Action::Held { .. } => "held",
            Action::LockError { .. } => "lockError",
        };
        let result: Result<Value, Failure> = match action {
            Action::Append {
                stream,
                record,
                receipt,
            }
            | Action::PeerAppend {
                stream,
                record,
                receipt,
            } => {
                let _ = receipt;
                let journal = if op == "peerAppend" {
                    context.make()
                } else {
                    context.journal()
                };
                journal
                    .append(stream.into(), context.record(&record), &calls)
                    .await
            }
            Action::Submit {
                stream,
                record,
                receipt,
            } => {
                pending.insert(
                    receipt,
                    context.settled(context.journal().append(
                        stream.into(),
                        context.record(&record),
                        &calls,
                    )),
                );
                Ok(undefined())
            }
            Action::Await { receipt } => Ok(pending
                .remove(&receipt)
                .expect("validated receipt reference")
                .await),
            Action::Forget { receipt } => {
                drop(pending.remove(&receipt));
                Ok(undefined())
            }
            Action::List { stream } => context.journal().list(stream.into(), &calls).await,
            Action::Prefix { stream, record } => {
                let stream: JsText = stream.into();
                let journal = context.journal();
                let receipt = context.settled(journal.append(
                    stream.clone(),
                    context.record(&record),
                    &calls,
                ));
                let old = journal.list(stream.clone(), &calls).await.unwrap();
                let after_old = context.events.borrow().clone();
                let fresh = journal.list(stream, &calls).await.unwrap();
                let after_fresh = context.events.borrow().clone();
                Ok(
                    json!({"old":old,"afterOld":after_old,"fresh":fresh,"afterFresh":after_fresh,"receipt":receipt.await}),
                )
            }
            Action::Batch { stream, records } => {
                let stream: JsText = stream.into();
                let journal = context.journal();
                let tasks = records
                    .iter()
                    .map(|id| journal.append(stream.clone(), context.record(id), &calls))
                    .collect::<Vec<_>>();
                let mut values = Vec::new();
                let mut error = None;
                for task in tasks {
                    match task.await {
                        Ok(value) => values.push(value),
                        Err(value) => {
                            error = Some(value);
                            break;
                        }
                    }
                }
                match error {
                    Some(error) => Err(error),
                    None => Ok(Value::Array(values)),
                }
            }
            Action::Push { record, value } => {
                let record = context.record(&record);
                let mut value_ref = record.borrow_mut();
                let PlainData::Array(values) = &mut *value_ref else {
                    panic!("validated array record")
                };
                values.push(data(&value));
                Ok(undefined())
            }
            Action::On { listener, handle } => {
                context.on(&listener, handle);
                Ok(undefined())
            }
            Action::Off { handle } => {
                context.off(&handle);
                Ok(undefined())
            }
            Action::Restart => {
                *context.current.borrow_mut() = Some(context.make());
                Ok(undefined())
            }
            Action::Seed { filename, contents } => {
                tokio::fs::write(context.directory.join(filename), contents)
                    .await
                    .unwrap();
                Ok(undefined())
            }
            Action::Bytes { filename } => Ok(json!(
                tokio::fs::read_to_string(context.directory.join(filename))
                    .await
                    .unwrap()
            )),
            Action::LockError { stream, error } => {
                context
                    .journal()
                    .with_lock(
                        stream.into(),
                        move || async move { Err(normalized(&data(&error))) },
                        &calls,
                    )
                    .await
            }
            Action::Held {
                stream,
                peer,
                nested,
                first,
                second,
                outcome,
            } => {
                let stream: JsText = stream.into();
                let inside = context.journal();
                let other = if peer { context.make() } else { inside.clone() };
                let (entered, held) = tokio::sync::oneshot::channel();
                let (release, released) = tokio::sync::oneshot::channel();
                let body = inside.clone();
                let nested_stream = stream.clone();
                let first_record = context.record(&first);
                let nested_calls = Rc::clone(&calls);
                let first = context.settled(inside.with_lock(
                    stream.clone(),
                    move || async move {
                        entered.send(()).unwrap();
                        released.await.unwrap();
                        let command = body.clone();
                        let record = first_record;
                        let action_calls = Rc::clone(&nested_calls);
                        let action_stream = nested_stream.clone();
                        let write = move || async move {
                            command
                                .append(action_stream, record, &action_calls)
                                .await
                                .map_err(|error| error.value)
                        };
                        let result = if nested {
                            body.with_lock(nested_stream, write, &nested_calls)
                                .await
                                .map_err(|error| error.value)?
                        } else {
                            write().await?
                        };
                        match outcome {
                            Outcome::Ok => Ok(result),
                            Outcome::Error { value } => Err(normalized(&data(&value))),
                        }
                    },
                    &calls,
                ));
                held.await.unwrap();
                let second =
                    context.settled(other.append(stream.clone(), context.record(&second), &calls));
                let before = inside.list(stream.clone(), &calls).await.unwrap();
                let again = inside.list(stream, &calls).await.unwrap();
                release.send(()).unwrap();
                Ok(json!({"before":before,"again":again,"first":first.await,"second":second.await}))
            }
        };
        let result = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                context.diagnostics.borrow_mut().push(error.diagnostic);
                json!({"ok":false,"error":error.value})
            }
        };
        rows.push(json!({"op":op,"result":result,"events":*context.events.borrow(),"parses":*context.parses.borrow()}));
    }
    for (_, receipt) in pending {
        let _ = receipt.await;
    }
    json!({"comparison":rows,"diagnostics":*context.diagnostics.borrow(),"observedRustCalls":*calls.borrow()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !info.payload().is::<PlainData>() {
            default(info);
        }
    }));
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let script: Script = serde_json::from_str(&line).expect("validated journal script");
        let output = tokio::task::LocalSet::new()
            .run_until(execute(script))
            .await;
        println!("{output}");
    }
}
