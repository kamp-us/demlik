use demlik_tea::{
    Machine, PlainData, Tagged,
    agent::{
        Agent, AgentCommand, AgentConfig, AgentMachineError, AgentMachineMsg, AgentToolMsg,
        AgentWired, AgentWorkError, GuardedSchema, PlainCalls, PlainToolCall, StateOf,
        StructuredOutputError,
        compaction::{
            COMPACTION_SUMMARY_SCHEMA, CompactMessage, CompactOk, CompactRun, CompactionPolicy,
            CompactionPurpose, WithCompaction,
        },
        create_agent,
        model::{MessageLoader, Messages, ModelFactory, plain_model},
        snapshot::AgentSnapshotWrite,
        types::{AGENT_TURN_SCHEMA, Conversation},
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, JsonData, plain_data},
    file_store::{FileStoreError, file_store},
    llm_call::{self, LlmCall, LlmOk, Request, Schema},
    resilience::{deadline::DeadlinesSub, resilient_call::CallValue},
    runtime::{
        self, CommandContext, CommandWork, Interpreter, Options, Profile, RuntimeError,
        Subscriptions,
    },
    storage::{Migrated, Store},
    timing::{Timer, TimerCallback, TimerError},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
    rc::{Rc, Weak},
};
use tokio::sync::Notify;

macro_rules! observe {($calls:expr,$f:path $(,$a:expr)*$(,)?)=>{{let value=$f($($a),*);$calls.borrow_mut().push(stringify!($f).to_owned());value}};}
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum Number {
    Number(f64),
    Special(String),
}
impl Number {
    fn value(&self) -> f64 {
        match self {
            Self::Number(v) => *v,
            Self::Special(v) => match v.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                _ => panic!("unknown test number"),
            },
        }
    }
}
fn every() -> Number {
    Number::Number(2.0)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Input {
    id: String,
    mode: String,
    profile: String,
    snapshot: bool,
    compaction: bool,
    #[serde(default = "every")]
    every: Number,
    scenario: String,
    path: PathBuf,
    #[serde(default)]
    anchors: bool,
}
type Conv = Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls>;
#[derive(Serialize, Deserialize)]
struct Payload {
    stage: JsText,
    conversation: Rc<Conv>,
}
#[derive(Serialize, Deserialize)]
struct CompactPayload {
    conversation: Rc<Conv>,
    folding: demlik_tea::agent::types::AgentNumber,
}
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<PlainData>;
    type Completion = Vec<Self::Msg>;
    fn settle(self, m: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(m)
    }
}
type OffState = StateOf<
    JsText,
    JsText,
    Payload,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
>;
type OnState = StateOf<
    JsText,
    JsText,
    Payload,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
    WithCompaction<CompactPayload, Rc<PlainData>, StructuredOutputError>,
>;
type Config = AgentConfig<
    'static,
    JsText,
    JsText,
    Payload,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    Tool,
    PlainCalls,
>;
fn plain(v: Value) -> PlainData {
    demlik_tea::data::decode_json(&v.to_string()).unwrap()
}
fn wire(v: &impl Serialize) -> Value {
    serde_json::to_value(JsonData(&plain_data(v).unwrap())).unwrap()
}
fn turn(name: &str) -> Rc<PlainData> {
    Rc::new(plain(if name == "done" {
        json!({"content":"invoice verified:15","toolCalls":[],"unknownTurn":{"final":true}})
    } else {
        json!({"content":name,"toolCalls":[{"callId":format!("{name}-1"),"name":name,"args":{"path":"invoice.json","unknownArg":[1,null]},"unknownCall":{"kept":true}}],"usage":{"inputTokens":7,"outputTokens":2},"unknownTurn":{"kept":true}})
    }))
}
struct Context {
    directory: PathBuf,
    mode: String,
    scenario: String,
    now: f64,
    calls: RefCell<Vec<String>>,
    trace: RefCell<Vec<Value>>,
    reports: RefCell<Vec<Value>>,
    raw_reports: RefCell<Vec<Value>>,
    models: Cell<usize>,
    tools: Cell<usize>,
    compact: Cell<usize>,
    snapshots: Cell<usize>,
    per_stage: RefCell<HashMap<JsText, usize>>,
    fail_next: Cell<bool>,
    cause: Rc<PlainData>,
    entered: Notify,
    entered_flag: Cell<bool>,
    release: Notify,
}
impl Context {
    fn note(&self, v: Value) {
        self.trace.borrow_mut().push(v);
    }
    fn counts(&self) -> Value {
        json!([
            self.models.get(),
            self.tools.get(),
            self.compact.get(),
            self.snapshots.get()
        ])
    }
    async fn bytes(&self, name: &str) -> Option<String> {
        tokio::fs::read_to_string(self.directory.join(name))
            .await
            .ok()
    }
}
fn config() -> Config {
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
        StructuredOutputError::describe,
    ));
    AgentConfig::from_plain_turns(
        llm,
        vec![Rc::new("collect".into()), Rc::new("report".into())],
        |_| "invoice".into(),
        |call| Tool(Rc::clone(call)),
        |stage, conversation, _| Payload {
            stage: stage.unwrap().as_ref().clone(),
            conversation: Rc::clone(conversation),
        },
    )
}
fn policy()
-> CompactionPolicy<'static, Conv, PlainData, CompactPayload, Rc<PlainData>, StructuredOutputError>
{
    CompactionPolicy::from_plain(
        |c| if c.turns.len() >= 2 { 2.0 } else { 0.0 },
        |c, n| CompactPayload {
            conversation: Rc::clone(c),
            folding: n,
        },
    )
}
struct Message(Rc<Request<JsText, Payload>>);
struct Loader(Rc<Context>);
impl MessageLoader<JsText, Payload, Message, StructuredOutputError> for Loader {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload>>,
    ) -> Result<Messages<'a, Message>, CallValue<StructuredOutputError>>
    where
        Message: 'a,
    {
        self.0.note(json!([
            "load",
            call.payload.stage,
            call.payload.conversation.turns.len()
        ]));
        Ok(vec![Message(Rc::clone(call))].into())
    }
}
fn model(ctx: Rc<Context>) -> impl ModelFactory<Message, GuardedSchema> {
    plain_model(async move |messages: Messages<'_, Message>| {
        let stage = &messages.as_ref()[0].0.payload.stage;
        let n = {
            let mut counts = ctx.per_stage.borrow_mut();
            let n = *counts.get(stage).unwrap_or(&0);
            counts.insert(stage.clone(), n + 1);
            n
        };
        ctx.models.set(ctx.models.get() + 1);
        ctx.note(json!(["model", stage, n]));
        let name = if stage.as_utf8() == Some("report") || n >= 2 {
            "done"
        } else if n == 0 {
            "collect"
        } else {
            "check"
        };
        if ctx.scenario == "save-fail" && stage.as_utf8() == Some("collect") && name == "done" {
            ctx.fail_next.set(true);
        }
        Ok(turn(name))
    })
}
struct Tools(Rc<Context>);
impl<M> Interpreter<Tool, M> for Tools {
    type Error = AgentWorkError<Rc<PlainData>>;
    fn interpret<'a>(
        &'a self,
        c: &'a Tool,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<PlainData>>, Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.tools.set(self.0.tools.get() + 1);
            let name = c.0.name().as_utf8().unwrap();
            self.0.note(json!(["tool", name]));
            let invoice: Value = serde_json::from_str(
                &tokio::fs::read_to_string(self.0.directory.join("invoice.json"))
                    .await
                    .unwrap(),
            )
            .unwrap();
            let value = if name == "collect" {
                invoice
            } else {
                let total: f64 = invoice["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_f64().unwrap())
                    .sum();
                assert_eq!(total, 15.0);
                let value = json!({"valid":true,"total":total});
                tokio::fs::write(self.0.directory.join("validated.json"), value.to_string())
                    .await
                    .unwrap();
                value
            };
            Ok(vec![AgentToolMsg::Ok {
                call_id: c.0.call_id().clone(),
                result: Rc::new(plain(value)),
                at: self.0.now,
            }])
        }))
    }
}
struct Compact(Rc<Context>);
impl<M> Interpreter<CompactRun<CompactPayload, Rc<PlainData>, StructuredOutputError>, M>
    for Compact
{
    type Error = AgentWorkError<Rc<PlainData>>;
    fn interpret<'a>(
        &'a self,
        c: &'a CompactRun<CompactPayload, Rc<PlainData>, StructuredOutputError>,
        _: CommandContext<M, Self::Error>,
    ) -> Option<
        CommandWork<'a, Vec<CompactMessage<Rc<PlainData>, StructuredOutputError>>, Self::Error>,
    > {
        Some(CommandWork::new(async move {
            self.0.compact.set(self.0.compact.get() + 1);
            self.0.note(json!(["compact", wire(&c.input)]));
            let raw = Rc::new(plain(
                json!({"summary":"invoice inv-17 total=15 checked","unknownSummary":{"kept":true}}),
            ));
            let output = observe!(
                self.0.calls,
                Schema::parse,
                &COMPACTION_SUMMARY_SCHEMA,
                Rc::clone(&raw)
            )
            .unwrap_or_else(|_| panic!("fixture compaction summary must be valid"));
            assert!(Rc::ptr_eq(&output, &raw));
            Ok(vec![CompactMessage::Ok(CompactOk {
                key: c.key.clone(),
                result: Rc::new(LlmOk {
                    key: c.key.clone(),
                    purpose: CompactionPurpose::Compact,
                    output,
                }),
                at: self.0.now,
            })])
        }))
    }
}
struct Writer(Rc<Context>);
impl<M> Interpreter<AgentSnapshotWrite, M> for Writer {
    type Error = AgentWorkError<Rc<PlainData>>;
    fn interpret<'a>(
        &'a self,
        c: &'a AgentSnapshotWrite,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'a, (), Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.snapshots.set(self.0.snapshots.get() + 1);
            let bytes = self
                .0
                .bytes("state.json")
                .await
                .expect("actual Store save before checkpoint IO");
            self.0.note(json!(["snapshot",wire(c),{"ownPayload":true,"payloadKind":if matches!(c.command().input().payload.as_ref(),PlainData::Undefined){"undefined"}else{"other"}},serde_json::from_str::<Value>(&bytes).unwrap()]));
            if self.0.scenario == "writer-fail" {
                return Err(AgentWorkError::Tool(Rc::clone(&self.0.cause)));
            }
            tokio::fs::write(self.0.directory.join("named.json"), bytes)
                .await
                .unwrap();
            if self.0.mode == "writer" || self.0.scenario == "held" {
                self.0.entered_flag.set(true);
                self.0.entered.notify_waiters();
                if self.0.mode == "writer" {
                    std::future::pending::<()>().await;
                } else {
                    self.0.release.notified().await;
                }
            }
            Ok(())
        }))
    }
}
struct ManualTimer;
impl Timer for ManualTimer {
    type Handle = ();
    fn now_ms(&self) -> f64 {
        17.25
    }
    fn set_timeout(&self, _: f64, _: TimerCallback) -> Result<(), TimerError> {
        panic!("no deadlines configured")
    }
    fn clear_timeout(&self, _: &()) {}
}
#[derive(Debug)]
enum PersistError {
    File(FileStoreError),
    Host(Rc<PlainData>),
}
impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File(e) => e.fmt(f),
            Self::Host(_) => f.write_str("store fixture cause"),
        }
    }
}
struct CheckedStore<I> {
    inner: I,
    ctx: Rc<Context>,
}
impl<S: Serialize, I: Store<Rc<S>, Raw = PlainData, Error = FileStoreError>> Store<Rc<S>>
    for CheckedStore<I>
{
    type Raw = PlainData;
    type Error = PersistError;
    async fn load(&self) -> Result<PlainData, PersistError> {
        self.inner.load().await.map_err(PersistError::File)
    }
    async fn save(&self, state: &Rc<S>) -> Result<(), PersistError> {
        let value = wire(state);
        self.ctx.note(json!([
            "save",
            value["run"]["phase"],
            value["run"]["snapshot"]
        ]));
        if self.ctx.fail_next.replace(false) {
            return Err(PersistError::Host(Rc::clone(&self.ctx.cause)));
        }
        self.inner.save(state).await.map_err(PersistError::File)
    }
    fn migrate(&self, raw: PlainData) -> Migrated<Rc<S>> {
        self.inner.migrate(raw)
    }
}
type TestMachine<S, M, C> = Machine<'static, Rc<S>, M, C, DeadlinesSub, (), AgentMachineError>;
async fn drive<S, M, C, I, U>(
    wired: AgentWired<TestMachine<S, M, C>, I, U>,
    ctx: Rc<Context>,
    input: &Input,
    start: impl FnOnce(f64) -> M,
    boot: impl FnOnce(f64) -> M,
    terminal: fn(&S) -> bool,
) -> Value
where
    S: Serialize + DeserializeOwned + 'static,
    M: Tagged + 'static,
    C: CommandFamily<Msg = M> + 'static,
    I: Interpreter<C, Error = AgentWorkError<Rc<PlainData>>> + 'static,
    U: Subscriptions<DeadlinesSub, M, Error = AgentWorkError<Rc<PlainData>>> + 'static,
{
    let loaded = Rc::new(RefCell::new(None::<Weak<S>>));
    let tracker = Rc::clone(&loaded);
    if input.mode == "reader" {
        tokio::fs::copy(
            ctx.directory.join("named.json"),
            ctx.directory.join("state.json"),
        )
        .await
        .unwrap();
    }
    let store = file_store(
        ctx.directory.join("state.json"),
        move |raw| match serde_json::from_str::<S>(&demlik_tea::data::stringify_json(&raw).unwrap())
        {
            Ok(s) => {
                let s = Rc::new(s);
                tracker.replace(Some(Rc::downgrade(&s)));
                Migrated::State(s)
            }
            Err(error) => {
                if matches!(raw, PlainData::Null) {
                    Migrated::Fresh
                } else {
                    Migrated::Refused(demlik_tea::storage::refuse(error.to_string()))
                }
            }
        },
    );
    let mut opts = Options::new(if input.profile == "effect" {
        Profile::Effect
    } else {
        Profile::Promise
    });
    opts.store = Some(runtime::Persistence::new(CheckedStore {
        inner: store,
        ctx: Rc::clone(&ctx),
    }));
    let clock = Rc::clone(&ctx);
    opts.clock = Rc::new(move || clock.now);
    opts.terminal = Some(Rc::new(move |s: &Rc<S>| terminal(s)));
    let errors = Rc::clone(&ctx);
    opts.on_error = Some(Rc::new(
        move |error: &RuntimeError<
            PersistError,
            AgentWorkError<Rc<PlainData>>,
            AgentMachineError,
        >,
              phase| {
            let (cause, same) = match error {
                RuntimeError::Handler(AgentWorkError::Tool(cause))
                | RuntimeError::Save(PersistError::Host(cause)) => {
                    (wire(cause), Rc::ptr_eq(cause, &errors.cause))
                }
                _ => (Value::Null, false),
            };
            errors
                .reports
                .borrow_mut()
                .push(json!({"phase":phase,"cause":cause,"same":same}));
            errors
                .raw_reports
                .borrow_mut()
                .push(json!({"phase":phase,"debug":format!("{error:?}")}));
        },
    ));
    let run = observe!(
        ctx.calls,
        runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        opts
    );
    observe!(ctx.calls, runtime::Runtime::ready, &run)
        .await
        .unwrap();
    let ready = run.get_state().unwrap();
    let ready_view = wire(ready.as_ref());
    let tracked = loaded.borrow().is_some();
    let ready_same = loaded.borrow().as_ref().is_none_or(|w| {
        w.upgrade()
            .is_some_and(|original| Rc::ptr_eq(&original, ready.as_ref()))
    });
    let ready_counts = ctx.counts();
    let seen = Rc::clone(&ctx);
    let _off = run.observe(move |msg, state| {
        let v = wire(state);
        seen.note(json!([
            "commit",
            msg.tag(),
            v["run"]["phase"],
            v["run"]["snapshot"]
        ]));
    });
    let mut early_done = Box::pin(run.done());
    if input.scenario == "held" {
        assert!(futures::poll!(early_done.as_mut()).is_pending());
    }
    let message = if input.mode == "reader" {
        boot(ctx.now)
    } else {
        start(ctx.now)
    };
    let dispatch = run.dispatch(message);
    tokio::pin!(dispatch);
    let mut held = Value::Null;
    if input.mode == "writer" || input.scenario == "held" {
        while !ctx.entered_flag.get() {
            let notified = ctx.entered.notified();
            tokio::select! {r=&mut dispatch=>panic!("checkpoint hold not reached: {r:?}"),_=notified=>{}}
        }
        if input.mode == "writer" {
            return json!({"view":{"ready":ready_view,"readyCounts":ready_counts,"loaded":{"status":if tracked{"tracked"}else{"not-applicable"},"checks":usize::from(tracked),"same":ready_same},"state":wire(run.get_state().unwrap().as_ref()),"counts":ctx.counts(),"trace":ctx.trace.borrow().clone(),"held":null,"failure":null,"reports":ctx.reports.borrow().clone()},"storeBytes":ctx.bytes("state.json").await,"namedBytes":ctx.bytes("named.json").await});
        }
        let state = run.get_state().unwrap();
        let late = run.done().await.unwrap();
        held = json!({"state":wire(state.as_ref()),"counts":ctx.counts(),"trace":ctx.trace.borrow().clone(),"earlyDonePending":futures::poll!(early_done.as_mut()).is_pending(),"lateDoneSame":std::sync::Arc::ptr_eq(&late,&state),"resultSame":run.result().is_some_and(|s|std::sync::Arc::ptr_eq(&s,&state)),"storeBytes":ctx.bytes("state.json").await,"namedBytes":ctx.bytes("named.json").await});
        ctx.release.notify_waiters();
    }
    let response = dispatch.await;
    let failure = response.as_ref().err().map(|error| match error.as_ref() {
        RuntimeError::Handler(AgentWorkError::Tool(cause)) => {
            json!({"phase":"handler","cause":wire(cause),"same":Rc::ptr_eq(cause,&ctx.cause)})
        }
        RuntimeError::Save(PersistError::Host(cause)) => {
            json!({"phase":"save","cause":wire(cause),"same":Rc::ptr_eq(cause,&ctx.cause)})
        }
        other => panic!("unexpected failure: {other:?}"),
    });
    let final_state = run.get_state().unwrap();
    let done_same = if terminal(final_state.as_ref()) && response.is_ok() {
        let done = run.done().await.unwrap();
        std::sync::Arc::ptr_eq(&done, &final_state)
    } else {
        false
    };
    let before_stop = json!({"storeBytes":ctx.bytes("state.json").await,"namedBytes":ctx.bytes("named.json").await});
    observe!(ctx.calls, runtime::Runtime::stop, &run).await;
    json!({"view":{"ready":ready_view,"readyCounts":ready_counts,"loaded":{"status":if tracked{"tracked"}else{"not-applicable"},"checks":usize::from(tracked),"same":ready_same},"state":wire(final_state.as_ref()),"counts":ctx.counts(),"trace":ctx.trace.borrow().clone(),"held":held,"failure":failure,"doneSame":done_same,"reports":ctx.reports.borrow().clone(),"beforeStop":before_stop},"storeBytes":ctx.bytes("state.json").await,"namedBytes":ctx.bytes("named.json").await})
}
fn anchors(calls: &RefCell<Vec<String>>) -> Value {
    let mut rows = vec![];
    for (label, every) in [
        ("zero", 0.0),
        ("fractional", 2.5),
        ("nan", f64::NAN),
        ("infinity", f64::INFINITY),
    ] {
        let knob = create_agent(config().with_snapshots(every));
        let mut state = knob.start(&knob.init(), "anchor", 0.0).unwrap().state;
        let mut emitted = vec![];
        for name in ["collect", "check", "done", "done"] {
            let step = observe!(calls, Agent::turn, &knob, &state, turn(name), 1.0);
            let step = step.unwrap();
            state = step.state;
            for command in step.commands {
                if let AgentCommand::Snapshot(c) = command {
                    emitted.push(wire(&c));
                }
            }
            if name != "done" {
                state = observe!(
                    calls,
                    Agent::tool_ok,
                    &knob,
                    &state,
                    format!("{name}-1"),
                    Rc::new(plain(json!({"ok":true}))),
                    1.0
                )
                .unwrap()
                .state;
            }
        }
        rows.push(json!({"id":label,"snapshot":wire(&state.run.snapshot),"commands":emitted}));
    }
    Value::Array(rows)
}
pub async fn execute(input: Input) -> Value {
    tokio::fs::create_dir_all(&input.path).await.unwrap();
    if input.mode != "reader" {
        tokio::fs::write(
            input.path.join("invoice.json"),
            r#"{"id":"inv-17","lines":[4.5,10.5],"total":15}"#,
        )
        .await
        .unwrap();
    }
    let ctx = Rc::new(Context {
        directory: input.path.clone(),
        mode: input.mode.clone(),
        scenario: input.scenario.clone(),
        now: if input.mode == "reader" { 57.25 } else { 17.25 },
        calls: RefCell::new(vec![]),
        trace: RefCell::new(vec![]),
        reports: RefCell::new(vec![]),
        raw_reports: RefCell::new(vec![]),
        models: Cell::new(0),
        tools: Cell::new(0),
        compact: Cell::new(0),
        snapshots: Cell::new(0),
        per_stage: RefCell::new(HashMap::new()),
        fail_next: Cell::new(false),
        cause: Rc::new(plain(json!({"source":"snapshot-fixture","token":17}))),
        entered: Notify::new(),
        entered_flag: Cell::new(false),
        release: Notify::new(),
    });
    macro_rules! run {($config:expr,$method:path,$state:ty $(,$extra:expr)*)=>{{let knob=Rc::new(create_agent($config));let wired=observe!(ctx.calls,$method,Rc::clone(&knob),model(Rc::clone(&ctx)),Loader(Rc::clone(&ctx)),Tools(Rc::clone(&ctx)) $(,$extra)*,Rc::new(ManualTimer));drive(wired,Rc::clone(&ctx),&input,|at|AgentMachineMsg::Start{run_id:"invoice-run".into(),at},AgentMachineMsg::boot,|s:&$state|s.is_settled()).await}};}
    let mut value = match (input.snapshot, input.compaction) {
        (false, false) => run!(config(), Agent::to_machine, OffState),
        (false, true) => run!(
            config().with_compaction(policy()).unwrap(),
            Agent::to_machine_with_compaction,
            OnState,
            Compact(Rc::clone(&ctx))
        ),
        (true, false) => run!(
            config().with_snapshots(input.every.value()),
            Agent::to_machine_with_snapshot,
            OffState,
            Writer(Rc::clone(&ctx))
        ),
        (true, true) => run!(
            config()
                .with_snapshots(input.every.value())
                .with_compaction(policy())
                .unwrap(),
            Agent::to_machine_with_snapshot_and_compaction,
            OnState,
            Writer(Rc::clone(&ctx)),
            Compact(Rc::clone(&ctx))
        ),
    };
    value["id"] = json!(input.id);
    value["rawReports"] = json!(ctx.raw_reports.borrow().clone());
    value["observedCalls"] = json!(ctx.calls.borrow().clone());
    if input.anchors {
        value["view"]["anchors"] = anchors(&ctx.calls);
        value["observedCalls"] = json!(ctx.calls.borrow().clone());
    }
    value
}
