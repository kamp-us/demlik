use demlik_tea::{
    PlainData,
    data::JsText,
    journal::{
        Appended, Journal, JournalEntry, JournalError, MemoryBackend, memory_journal,
        remote::{
            self, AuthoredRecord, CursorStore, LocalJournal, LocalWork, MemoryCursorStore,
            MemoryError, MemoryRemote, PullRequest, PullResult, PushRequest, PushResult,
            RemoteEntry, RemoteJournal, SyncClient, SyncClientOptions, SyncFailure,
        },
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io::{self, BufRead},
    rc::Rc,
};
#[allow(dead_code)]
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, normalized, number, text};
type Payload = RefCell<PlainData>;
type Calls = Rc<RefCell<Vec<&'static str>>>;
type Local = Journal<Payload, MemoryBackend<Payload>>;
type Client = SyncClient<Payload, Host, PlainData, Host, Host>;
type ClientError = remote::ClientError<Payload, Host, PlainData, Host, Host>;
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
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "camelCase")]
enum Point {
    LocalAppend,
    LocalList,
    Push,
    Pull,
    CursorGet,
    CursorSet,
}
impl Point {
    fn name(self) -> &'static str {
        match self {
            Self::LocalAppend => "localAppend",
            Self::LocalList => "localList",
            Self::Push => "push",
            Self::Pull => "pull",
            Self::CursorGet => "cursorGet",
            Self::CursorSet => "cursorSet",
        }
    }
}
#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Before,
    After,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordInput {
    id: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientInput {
    id: String,
    author: Text,
    token: Value,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryInput {
    stream: Text,
    seq: Number,
    author: Text,
    record: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    stream: Text,
    author: Text,
    records: Vec<String>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Append {
        client: String,
        stream: Text,
        record: String,
    },
    Pending {
        client: String,
        stream: Text,
    },
    Sync {
        client: String,
        stream: Text,
    },
    Log {
        client: String,
        stream: Text,
    },
    CursorGet {
        client: String,
        stream: Text,
    },
    CursorSet {
        client: String,
        stream: Text,
        seq: Number,
    },
    LocalList {
        client: String,
        stream: Text,
    },
    Restart {
        client: String,
        keep_local: bool,
        keep_cursors: bool,
    },
    Fault {
        client: String,
        at: Point,
        stage: Stage,
        error: Value,
    },
    Mutate {
        record: String,
        value: Value,
    },
    Snapshot {
        client: String,
        stream: Text,
        name: String,
    },
    CheckSnapshot {
        client: String,
        stream: Text,
        name: String,
    },
    ClearSnapshot {
        client: String,
        stream: Text,
        name: String,
    },
    BatchPush {
        batches: Vec<Batch>,
    },
    Pull {
        stream: Text,
        since: Number,
    },
    PullTwice {
        stream: Text,
        since: Number,
    },
    PushReply {
        client: String,
        seqs: Vec<Number>,
    },
    PullReply {
        client: String,
        entries: Vec<EntryInput>,
    },
    HeldSync {
        first: String,
        second: String,
        stream: Text,
        at: Point,
        stage: Stage,
    },
    HeldPair {
        first: String,
        second: String,
        stream: Text,
        at: Point,
        stage: Stage,
        reverse: bool,
    },
    Overlap {
        client: String,
        stream: Text,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    records: Vec<RecordInput>,
    clients: Vec<ClientInput>,
    actions: Vec<Action>,
}
struct Gate {
    arrived: Cell<usize>,
    changed: tokio::sync::Notify,
    released: Cell<bool>,
    release: tokio::sync::Notify,
}
impl Gate {
    fn new() -> Self {
        Self {
            arrived: Cell::new(0),
            changed: tokio::sync::Notify::new(),
            released: Cell::new(false),
            release: tokio::sync::Notify::new(),
        }
    }
    async fn arrive(&self) {
        self.arrived.set(self.arrived.get() + 1);
        self.changed.notify_waiters();
        loop {
            let notified = self.release.notified();
            if self.released.get() {
                break;
            }
            notified.await;
        }
    }
    async fn wait(&self, count: usize) {
        loop {
            let changed = self.changed.notified();
            if self.arrived.get() >= count {
                break;
            }
            changed.await;
        }
    }
    fn release(&self) {
        self.released.set(true);
        self.release.notify_waiters();
    }
}
#[derive(Clone)]
enum Behavior {
    Fail(Rc<PlainData>),
    Hold(Rc<Gate>),
}
#[derive(Clone)]
struct Rule {
    stage: Stage,
    remaining: usize,
    behavior: Behavior,
}
enum Problem {
    Journal(MemoryError),
    Raw(Rc<PlainData>),
}
struct Shared {
    remote: Rc<MemoryRemote<Payload>>,
    records: BTreeMap<String, Rc<Payload>>,
    events: RefCell<Vec<Value>>,
    calls: Calls,
    rules: RefCell<BTreeMap<(String, Point), Rule>>,
    push_replies: RefCell<BTreeMap<String, Vec<f64>>>,
    pull_replies: RefCell<BTreeMap<String, Vec<Rc<RemoteEntry<Payload>>>>>,
}
impl Shared {
    fn record(&self, record: &Rc<Payload>) -> Value {
        let id = self
            .records
            .iter()
            .find(|(_, item)| Rc::ptr_eq(item, record))
            .map(|(id, _)| id);
        json!({"id":id,"value":normalized(&record.borrow())})
    }
    fn authored(&self, records: &[Rc<AuthoredRecord<Payload>>]) -> Value {
        json!(records.iter().map(|entry|json!({"author":text(&entry.author),"record":self.record(&entry.record)})).collect::<Vec<_>>())
    }
    fn entries(&self, entries: &[Rc<RemoteEntry<Payload>>]) -> Value {
        json!(entries.iter().map(|entry|json!({"stream":text(&entry.stream),"seq":number(entry.seq),"author":text(&entry.author),"record":self.record(&entry.record)})).collect::<Vec<_>>())
    }
}
struct Host {
    id: String,
    token: Rc<PlainData>,
    local: Rc<Local>,
    cursors: MemoryCursorStore,
    shared: Rc<Shared>,
}
impl Host {
    fn begin(&self, point: Point, stream: &JsText, extra: Value) -> Option<Rule> {
        self.shared
            .events
            .borrow_mut()
            .push(json!({"client":self.id,"op":point.name(),"stream":text(stream),"data":extra}));
        let mut rules = self.shared.rules.borrow_mut();
        let key = (self.id.clone(), point);
        let rule = rules.get(&key).cloned()?;
        if rule.remaining == 1 {
            rules.remove(&key);
        } else {
            rules.get_mut(&key).unwrap().remaining -= 1;
        }
        Some(rule)
    }
    async fn boundary(
        &self,
        rule: &Option<Rule>,
        point: Point,
        stage: Stage,
    ) -> Result<(), Problem> {
        let Some(rule) = rule.as_ref().filter(|rule| rule.stage == stage) else {
            return Ok(());
        };
        match &rule.behavior {
            Behavior::Fail(value) => {
                self.shared.events.borrow_mut().push(json!({"client":self.id,"op":"fail","at":point.name(),"stage":stage.name(),"value":normalized(value)}));
                Err(Problem::Raw(Rc::clone(value)))
            }
            Behavior::Hold(gate) => {
                self.shared.events.borrow_mut().push(
                    json!({"client":self.id,"op":"held","at":point.name(),"stage":stage.name()}),
                );
                gate.arrive().await;
                self.shared.events.borrow_mut().push(json!({"client":self.id,"op":"released","at":point.name(),"stage":stage.name()}));
                // The paired transport awaits this helper before resuming its operation.
                tokio::task::yield_now().await;
                Ok(())
            }
        }
    }
    fn owned(&self) -> Self {
        Self {
            id: self.id.clone(),
            token: Rc::clone(&self.token),
            local: Rc::clone(&self.local),
            cursors: self.cursors.clone(),
            shared: Rc::clone(&self.shared),
        }
    }
}
impl LocalJournal<Payload> for Host {
    type Error = Problem;
    fn append(&self, stream: JsText, record: Rc<Payload>) -> LocalWork<Appended, Self::Error> {
        let rule = self.begin(Point::LocalAppend, &stream, self.shared.record(&record));
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::LocalAppend, Stage::Before)
                .await?;
            let result = observe!(
                &host.shared.calls,
                Journal::append,
                &host.local,
                stream,
                record
            )
            .await
            .map_err(Problem::Journal)?;
            host.boundary(&rule, Point::LocalAppend, Stage::After)
                .await?;
            Ok(result)
        })
    }
    fn list(&self, stream: JsText) -> LocalWork<Vec<Rc<JournalEntry<Payload>>>, Self::Error> {
        let rule = self.begin(Point::LocalList, &stream, Value::Null);
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::LocalList, Stage::Before)
                .await?;
            let result = observe!(&host.shared.calls, Journal::list, &host.local, stream)
                .await
                .map_err(Problem::Journal)?;
            host.boundary(&rule, Point::LocalList, Stage::After).await?;
            Ok(result)
        })
    }
}
impl CursorStore for Host {
    type Error = Problem;
    fn get(&self, stream: JsText) -> LocalWork<f64, Self::Error> {
        let rule = self.begin(Point::CursorGet, &stream, Value::Null);
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::CursorGet, Stage::Before)
                .await?;
            let result = observe!(
                &host.shared.calls,
                MemoryCursorStore::get,
                &host.cursors,
                stream
            )
            .await
            .map_err(Problem::Journal)?;
            host.boundary(&rule, Point::CursorGet, Stage::After).await?;
            Ok(result)
        })
    }
    fn set(&self, stream: JsText, seq: f64) -> LocalWork<(), Self::Error> {
        let rule = self.begin(Point::CursorSet, &stream, number(seq));
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::CursorSet, Stage::Before)
                .await?;
            observe!(
                &host.shared.calls,
                MemoryCursorStore::set,
                &host.cursors,
                stream,
                seq
            )
            .await
            .map_err(Problem::Journal)?;
            host.boundary(&rule, Point::CursorSet, Stage::After).await?;
            Ok(())
        })
    }
}
impl RemoteJournal<Payload> for Host {
    type Error = Problem;
    fn push(&self, request: PushRequest<Payload>) -> LocalWork<PushResult, Self::Error> {
        let extra = json!({"tokenSame":request.token.as_ref().is_some_and(|token|Rc::ptr_eq(token,&self.token)),"records":self.shared.authored(&request.records)});
        let rule = self.begin(Point::Push, &request.stream, extra);
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::Push, Stage::Before).await?;
            let mut result = observe!(
                &host.shared.calls,
                MemoryRemote::push,
                &host.shared.remote,
                request
            )
            .await
            .map_err(Problem::Journal)?;
            if let Some(seqs) = host.shared.push_replies.borrow_mut().remove(&host.id) {
                result.seqs = seqs;
            }
            host.boundary(&rule, Point::Push, Stage::After).await?;
            Ok(result)
        })
    }
    fn pull(&self, request: PullRequest) -> LocalWork<PullResult<Payload>, Self::Error> {
        let extra = json!({"tokenSame":request.token.as_ref().is_some_and(|token|Rc::ptr_eq(token,&self.token)),"since":number(request.since)});
        let rule = self.begin(Point::Pull, &request.stream, extra);
        let host = self.owned();
        Box::pin(async move {
            host.boundary(&rule, Point::Pull, Stage::Before).await?;
            let mut result = observe!(
                &host.shared.calls,
                MemoryRemote::pull,
                &host.shared.remote,
                request
            )
            .await
            .map_err(Problem::Journal)?;
            if let Some(entries) = host.shared.pull_replies.borrow_mut().remove(&host.id) {
                result.entries = entries;
            }
            host.boundary(&rule, Point::Pull, Stage::After).await?;
            Ok(result)
        })
    }
}
fn memory_error(error: MemoryError) -> Value {
    match error {
        JournalError::Backend(value) | JournalError::Effect(value) => match value {},
        JournalError::Panic(cause) => json!({"panic":format!("{cause:?}")}),
        JournalError::HostClosed => json!({"hostClosed":true}),
    }
}
fn problem(error: Problem, phase: &str) -> Value {
    let error = match error {
        Problem::Raw(value) => normalized(&value),
        Problem::Journal(error) => memory_error(error),
    };
    json!({"ok":false,"phase":phase,"error":error})
}
fn client_error(error: ClientError) -> Value {
    match error {
        JournalError::Backend(error) => match error {
            SyncFailure::Local(error) => problem(error, "local"),
            SyncFailure::Push(error) => problem(error, "push"),
            SyncFailure::CursorGet(error) => problem(error, "cursorGet"),
            SyncFailure::Pull(error) => problem(error, "pull"),
            SyncFailure::CursorSet(error) => problem(error, "cursorSet"),
        },
        JournalError::Effect(value) => match value {},
        JournalError::Panic(cause) => json!({"ok":false,"panic":format!("{cause:?}")}),
        JournalError::HostClosed => json!({"ok":false,"hostClosed":true}),
    }
}
fn ok(value: Value) -> Value {
    json!({"ok":true,"value":value})
}
fn build_client(host: Rc<Host>, author: JsText) -> Client {
    let options = SyncClientOptions::new(Rc::clone(&host), author)
        .with_token(Rc::clone(&host.token))
        .with_local(Rc::clone(&host))
        .with_cursors(Rc::clone(&host));
    observe!(&host.shared.calls, remote::make_sync_client, options)
}
struct Running {
    host: Rc<Host>,
    author: JsText,
    client: Client,
}
async fn execute(script: Script) -> Value {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let shared = Rc::new(Shared {
        remote: Rc::new(observe!(&calls, remote::memory_remote_journal)),
        records: script
            .records
            .into_iter()
            .map(|record| (record.id, Rc::new(RefCell::new(data(&record.value)))))
            .collect(),
        events: RefCell::new(Vec::new()),
        calls: Rc::clone(&calls),
        rules: RefCell::new(BTreeMap::new()),
        push_replies: RefCell::new(BTreeMap::new()),
        pull_replies: RefCell::new(BTreeMap::new()),
    });
    let mut clients = BTreeMap::new();
    for input in script.clients {
        let author: JsText = input.author.into();
        let host = Rc::new(Host {
            id: input.id.clone(),
            token: Rc::new(data(&input.token)),
            local: Rc::new(observe!(&calls, memory_journal)),
            cursors: observe!(&calls, remote::memory_cursor_store),
            shared: Rc::clone(&shared),
        });
        clients.insert(
            input.id,
            Running {
                client: build_client(Rc::clone(&host), author.clone()),
                host,
                author,
            },
        );
    }
    let mut snapshots: BTreeMap<String, Vec<Rc<RemoteEntry<Payload>>>> = BTreeMap::new();
    let mut rows = Vec::new();
    for action in script.actions {
        let result = match action {
            Action::Append {
                client,
                stream,
                record,
            } => observe!(
                &calls,
                SyncClient::append,
                &clients[&client].client,
                JsText::from(stream),
                Rc::clone(&shared.records[&record])
            )
            .await
            .map(|()| ok(Value::Null))
            .unwrap_or_else(client_error),
            Action::Sync { client, stream } => observe!(
                &calls,
                SyncClient::sync,
                &clients[&client].client,
                JsText::from(stream)
            )
            .await
            .map(|()| ok(Value::Null))
            .unwrap_or_else(client_error),
            Action::Pending { client, stream } => observe!(
                &calls,
                SyncClient::pending,
                &clients[&client].client,
                JsText::from(stream)
            )
            .await
            .map(|entries| ok(shared.authored(&entries)))
            .unwrap_or_else(client_error),
            Action::Log { client, stream } => ok(shared.entries(&observe!(
                &calls,
                SyncClient::log,
                &clients[&client].client,
                JsText::from(stream)
            ))),
            Action::CursorGet { client, stream } => observe!(
                &calls,
                MemoryCursorStore::get,
                &clients[&client].host.cursors,
                JsText::from(stream)
            )
            .await
            .map(|seq| ok(number(seq)))
            .unwrap_or_else(|error| problem(Problem::Journal(error), "cursorGet")),
            Action::CursorSet {
                client,
                stream,
                seq,
            } => observe!(
                &calls,
                MemoryCursorStore::set,
                &clients[&client].host.cursors,
                JsText::from(stream),
                seq.value()
            )
            .await
            .map(|()| ok(Value::Null))
            .unwrap_or_else(|error| problem(Problem::Journal(error), "cursorSet")),
            Action::LocalList { client, stream } => {
                let entries = observe!(
                    &calls,
                    Journal::list,
                    &clients[&client].host.local,
                    JsText::from(stream)
                )
                .await
                .unwrap();
                ok(json!(entries.iter().map(|entry|json!({"stream":text(&entry.stream),"seq":normalized(entry.seq.raw()),"record":shared.record(&entry.record)})).collect::<Vec<_>>()))
            }
            Action::Restart {
                client,
                keep_local,
                keep_cursors,
            } => {
                let previous = &clients[&client];
                let host = Rc::new(Host {
                    id: client.clone(),
                    token: Rc::clone(&previous.host.token),
                    local: if keep_local {
                        Rc::clone(&previous.host.local)
                    } else {
                        Rc::new(observe!(&calls, memory_journal))
                    },
                    cursors: if keep_cursors {
                        previous.host.cursors.clone()
                    } else {
                        observe!(&calls, remote::memory_cursor_store)
                    },
                    shared: Rc::clone(&shared),
                });
                let author = previous.author.clone();
                let running = Running {
                    client: build_client(Rc::clone(&host), author.clone()),
                    host,
                    author,
                };
                clients.insert(client, running);
                ok(Value::Null)
            }
            Action::Fault {
                client,
                at,
                stage,
                error,
            } => {
                shared.rules.borrow_mut().insert(
                    (client, at),
                    Rule {
                        stage,
                        remaining: 1,
                        behavior: Behavior::Fail(Rc::new(data(&error))),
                    },
                );
                ok(Value::Null)
            }
            Action::Mutate { record, value } => {
                *shared.records[&record].borrow_mut() = data(&value);
                ok(Value::Null)
            }
            Action::Snapshot {
                client,
                stream,
                name,
            } => {
                let entries = observe!(
                    &calls,
                    SyncClient::log,
                    &clients[&client].client,
                    JsText::from(stream)
                );
                let result = ok(shared.entries(&entries));
                snapshots.insert(name, entries);
                result
            }
            Action::CheckSnapshot {
                client,
                stream,
                name,
            } => {
                let entries = observe!(
                    &calls,
                    SyncClient::log,
                    &clients[&client].client,
                    JsText::from(stream)
                );
                let snapshot = &snapshots[&name];
                ok(
                    json!({"snapshot":shared.entries(snapshot),"current":shared.entries(&entries),"sameEntries":snapshot.iter().enumerate().map(|(index,entry)|entries.get(index).is_some_and(|other|Rc::ptr_eq(entry,other))).collect::<Vec<_>>()}),
                )
            }
            Action::ClearSnapshot {
                client,
                stream,
                name,
            } => {
                snapshots.get_mut(&name).unwrap().clear();
                ok(
                    json!({"length":observe!(&calls,SyncClient::log,&clients[&client].client,JsText::from(stream)).len()}),
                )
            }
            Action::BatchPush { batches } => {
                let receipts = batches
                    .into_iter()
                    .map(|batch| {
                        let author: JsText = batch.author.into();
                        let records = batch
                            .records
                            .into_iter()
                            .map(|id| {
                                Rc::new(AuthoredRecord {
                                    author: author.clone(),
                                    record: Rc::clone(&shared.records[&id]),
                                })
                            })
                            .collect();
                        observe!(
                            &calls,
                            MemoryRemote::push,
                            &shared.remote,
                            PushRequest::<Payload> {
                                token: None,
                                stream: batch.stream.into(),
                                records
                            }
                        )
                    })
                    .collect::<Vec<_>>();
                let mut seqs = Vec::new();
                for receipt in receipts {
                    seqs.push(
                        receipt
                            .await
                            .unwrap()
                            .seqs
                            .into_iter()
                            .map(number)
                            .collect::<Vec<_>>(),
                    );
                }
                ok(json!(seqs))
            }
            Action::Pull { stream, since } => {
                let result = observe!(
                    &calls,
                    MemoryRemote::pull,
                    &shared.remote,
                    PullRequest::<PlainData> {
                        token: None,
                        stream: stream.into(),
                        since: since.value()
                    }
                )
                .await
                .unwrap();
                ok(shared.entries(&result.entries))
            }
            Action::PullTwice { stream, since } => {
                let stream: JsText = stream.into();
                let first = observe!(
                    &calls,
                    MemoryRemote::pull,
                    &shared.remote,
                    PullRequest::<PlainData> {
                        token: None,
                        stream: stream.clone(),
                        since: since.value()
                    }
                )
                .await
                .unwrap()
                .entries;
                let second = observe!(
                    &calls,
                    MemoryRemote::pull,
                    &shared.remote,
                    PullRequest::<PlainData> {
                        token: None,
                        stream,
                        since: since.value()
                    }
                )
                .await
                .unwrap()
                .entries;
                ok(
                    json!({"first":shared.entries(&first),"second":shared.entries(&second),"sameEntries":first.iter().zip(&second).map(|(a,b)|Rc::ptr_eq(a,b)).collect::<Vec<_>>(),"sameRecords":first.iter().zip(&second).map(|(a,b)|Rc::ptr_eq(&a.record,&b.record)).collect::<Vec<_>>()}),
                )
            }
            Action::PushReply { client, seqs } => {
                shared
                    .push_replies
                    .borrow_mut()
                    .insert(client, seqs.into_iter().map(Number::value).collect());
                ok(Value::Null)
            }
            Action::PullReply { client, entries } => {
                shared.pull_replies.borrow_mut().insert(
                    client,
                    entries
                        .into_iter()
                        .map(|entry| {
                            Rc::new(RemoteEntry {
                                stream: entry.stream.into(),
                                seq: entry.seq.value(),
                                author: entry.author.into(),
                                record: Rc::clone(&shared.records[&entry.record]),
                            })
                        })
                        .collect(),
                );
                ok(Value::Null)
            }
            Action::HeldSync {
                first,
                second,
                stream,
                at,
                stage,
            } => {
                let stream: JsText = stream.into();
                let gate = Rc::new(Gate::new());
                shared.rules.borrow_mut().insert(
                    (first.clone(), at),
                    Rule {
                        stage,
                        remaining: 1,
                        behavior: Behavior::Hold(Rc::clone(&gate)),
                    },
                );
                let first_receipt = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&first].client,
                    stream.clone()
                );
                gate.wait(1).await;
                let held = json!({"first":shared.entries(&observe!(&calls,SyncClient::log,&clients[&first].client,stream.clone())),"second":shared.entries(&observe!(&calls,SyncClient::log,&clients[&second].client,stream.clone()))});
                let second_result = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&second].client,
                    stream.clone()
                )
                .await
                .map(|()| ok(Value::Null))
                .unwrap_or_else(client_error);
                let while_held = json!({"first":shared.entries(&observe!(&calls,SyncClient::log,&clients[&first].client,stream.clone())),"second":shared.entries(&observe!(&calls,SyncClient::log,&clients[&second].client,stream.clone()))});
                gate.release();
                let first_result = first_receipt
                    .await
                    .map(|()| ok(Value::Null))
                    .unwrap_or_else(client_error);
                ok(
                    json!({"held":held,"whileHeld":while_held,"first":first_result,"second":second_result}),
                )
            }
            Action::HeldPair {
                first,
                second,
                stream,
                at,
                stage,
                reverse,
            } => {
                let stream: JsText = stream.into();
                let a = Rc::new(Gate::new());
                let b = Rc::new(Gate::new());
                shared.rules.borrow_mut().insert(
                    (first.clone(), at),
                    Rule {
                        stage,
                        remaining: 1,
                        behavior: Behavior::Hold(Rc::clone(&a)),
                    },
                );
                shared.rules.borrow_mut().insert(
                    (second.clone(), at),
                    Rule {
                        stage,
                        remaining: 1,
                        behavior: Behavior::Hold(Rc::clone(&b)),
                    },
                );
                let first_receipt = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&first].client,
                    stream.clone()
                );
                a.wait(1).await;
                let second_receipt = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&second].client,
                    stream.clone()
                );
                b.wait(1).await;
                let state = || json!({"first":shared.entries(&observe!(&calls,SyncClient::log,&clients[&first].client,stream.clone())),"second":shared.entries(&observe!(&calls,SyncClient::log,&clients[&second].client,stream.clone()))});
                let held = state();
                let (first_result, second_result, after_one) = if reverse {
                    b.release();
                    let second_result = second_receipt
                        .await
                        .map(|()| ok(Value::Null))
                        .unwrap_or_else(client_error);
                    let after_one = state();
                    a.release();
                    (
                        first_receipt
                            .await
                            .map(|()| ok(Value::Null))
                            .unwrap_or_else(client_error),
                        second_result,
                        after_one,
                    )
                } else {
                    a.release();
                    let first_result = first_receipt
                        .await
                        .map(|()| ok(Value::Null))
                        .unwrap_or_else(client_error);
                    let after_one = state();
                    b.release();
                    (
                        first_result,
                        second_receipt
                            .await
                            .map(|()| ok(Value::Null))
                            .unwrap_or_else(client_error),
                        after_one,
                    )
                };
                ok(
                    json!({"held":held,"afterOne":after_one,"first":first_result,"second":second_result}),
                )
            }
            Action::Overlap { client, stream } => {
                let stream: JsText = stream.into();
                let gate = Rc::new(Gate::new());
                shared.rules.borrow_mut().insert(
                    (client.clone(), Point::CursorGet),
                    Rule {
                        stage: Stage::After,
                        remaining: 2,
                        behavior: Behavior::Hold(Rc::clone(&gate)),
                    },
                );
                let first = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&client].client,
                    stream.clone()
                );
                let second = observe!(
                    &calls,
                    SyncClient::sync,
                    &clients[&client].client,
                    stream.clone()
                );
                gate.wait(2).await;
                let held = shared.entries(&observe!(
                    &calls,
                    SyncClient::log,
                    &clients[&client].client,
                    stream
                ));
                gate.release();
                let first = first
                    .await
                    .map(|()| ok(Value::Null))
                    .unwrap_or_else(client_error);
                let second = second
                    .await
                    .map(|()| ok(Value::Null))
                    .unwrap_or_else(client_error);
                ok(json!({"held":held,"results":[first,second]}))
            }
        };
        rows.push(
            json!({"result":result,"events":std::mem::take(&mut *shared.events.borrow_mut())}),
        );
    }
    json!({"comparison":rows,"observedRustCalls":*calls.borrow()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let script: Script = serde_json::from_str(&line).expect("validated remote journal script");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::task::LocalSet::new().run_until(execute(script)),
        )
        .await
        .expect("held action handshake completes");
        println!("{output}");
    }
}
