//! Application-owned cause codec, actual FileStore and fresh-process invoice resume.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        Agent, AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, GuardedSchema,
        PlainCalls, PlainToolCall, StateOf, StructuredOutputError, create_agent,
        model::{Llm, MessageLoader, Messages, ModelFactory},
        types::{AGENT_TURN_SCHEMA, AgentFailure, AgentField, Awaiting, Conversation, ToolOutcome},
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, JsonData, stringify_json},
    file_store::{FileStore, FileStoreError},
    llm_call::{self, LlmCall, LlmCause, Request, Schema},
    resilience::resilient_call::CallValue,
    runtime::{
        self, CommandContext, CommandWork, ErrorPhase, Interpreter, Options, Profile, RuntimeError,
    },
    storage::{Migrated, Store, refuse},
    timing::{Timer, TimerCallback, TimerError},
};
use serde::{Deserialize, Serialize, ser::SerializeMap};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    io::{self, Read},
    ops::AsyncFn,
    path::PathBuf,
    rc::{Rc, Weak},
};
macro_rules! observe {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));value}};}
macro_rules! observe_async {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*).await;$ctx.calls.borrow_mut().push(stringify!($f));value}};}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Writer,
    Reader,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Checkpoint {
    Brain,
    Tools,
    ToolError,
    Done,
    ModelError,
    GuardError,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    id: String,
    profile: SelectedProfile,
    mode: Mode,
    checkpoint: Checkpoint,
    directory: PathBuf,
}
#[derive(Serialize, Deserialize)]
struct InvoiceResult {
    value: f64,
}
#[derive(Serialize, Deserialize)]
struct Payload {
    conversation: Rc<Conversation<InvoiceResult, PlainData, PlainData, PlainData, PlainCalls>>,
}
struct OpaqueError(Cell<u32>);
enum AppCause {
    Model(Rc<OpaqueError>),
    Guard(Rc<StructuredOutputError>),
    Data(Rc<PlainData>),
}
// This is the application's ordinary-Error wire policy, not a library Error codec.
impl Serialize for AppCause {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Model(_) | Self::Guard(_) => s.serialize_map(Some(0))?.end(),
            Self::Data(v) => JsonData(v).serialize(s),
        }
    }
}
impl<'de> Deserialize<'de> for AppCause {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        PlainData::deserialize(d).map(|v| Self::Data(Rc::new(v)))
    }
}
type State = StateOf<
    JsText,
    JsText,
    Payload,
    Parser,
    InvoiceResult,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
>;
type Msg = AgentMachineMsg<JsText, Payload, Rc<PlainData>, AppCause, AgentToolMsg<InvoiceResult>>;
type Knob = Agent<
    'static,
    JsText,
    JsText,
    Payload,
    Parser,
    InvoiceResult,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    Tool,
    PlainCalls,
>;
struct Context {
    input: Input,
    clock: Rc<Cell<f64>>,
    trace: RefCell<Vec<String>>,
    calls: RefCell<Vec<&'static str>>,
    schemas: RefCell<Vec<Rc<Parser>>>,
    cause: Rc<OpaqueError>,
    guard_errors: RefCell<Vec<Rc<StructuredOutputError>>>,
    model_calls: Cell<usize>,
    tool_calls: Cell<usize>,
    schema_same: Cell<bool>,
    validated: Cell<bool>,
    loaded: RefCell<Option<Weak<State>>>,
    saved: RefCell<Option<Weak<State>>>,
    cut: Cell<bool>,
    decoded: RefCell<Option<Weak<PlainToolCall>>>,
    decoded_command: Cell<Option<bool>>,
    decoded_record: Cell<Option<bool>>,
}
impl Context {
    fn log(&self, v: impl Into<String>) {
        self.trace.borrow_mut().push(v.into());
    }
    fn inspect_record(&self, s: &State) {
        if let Some(call) = self.decoded.borrow().as_ref().and_then(Weak::upgrade)
            && let Some(conv) = &s.conversation
        {
            for record in conv.tool_records.iter() {
                if record.call.call_id() == call.call_id() {
                    self.decoded_record
                        .set(Some(Rc::ptr_eq(&call, &record.call)));
                }
            }
        }
    }
    fn turn(&self, request: &Request<JsText, Payload>) -> Rc<PlainData> {
        let purpose = request.purpose.as_utf8().unwrap();
        let count = request.payload.conversation.tool_records.len();
        if request
            .payload
            .conversation
            .tool_records
            .iter()
            .any(|r| matches!(&*r.outcome, ToolOutcome::Error(_)))
        {
            self.validated.set(false);
        }
        let ordinal = match purpose {
            "collect" => 1 + count,
            "check" => 3 + count,
            _ => 5,
        };
        let calls = if purpose != "summarize" && count == 0 {
            vec![object([
                ("callId", PlainData::String(format!("{purpose}-17").into())),
                ("name", text(purpose)),
                (
                    "args",
                    object([
                        ("file", text("invoice.json")),
                        ("unknownArg", text("kept")),
                        ("unknownUndefined", PlainData::Undefined),
                        ("__proto__", object([("args", PlainData::Bool(true))])),
                    ]),
                ),
                (
                    "unknownCall",
                    object([("ordinal", PlainData::Number(ordinal as f64))]),
                ),
                ("unknownUndefined", PlainData::Undefined),
            ])]
        } else {
            vec![]
        };
        Rc::new(object([
            (
                "content",
                if self.input.checkpoint == Checkpoint::GuardError {
                    PlainData::Number(0.0)
                } else {
                    text(if purpose == "summarize" {
                        if self.validated.get() {
                            "Invoice total confirmed: 15"
                        } else {
                            "Invoice requires review"
                        }
                    } else {
                        purpose
                    })
                },
            ),
            ("toolCalls", PlainData::Array(calls)),
            ("unknownTurn", PlainData::Number(ordinal as f64)),
            ("unknownUndefined", PlainData::Undefined),
            ("provider", object([("opaque", text("kept"))])),
        ]))
    }
}
fn object<const N: usize>(fields: [(&str, PlainData); N]) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(value: &str) -> PlainData {
    PlainData::String(value.into())
}
struct Parser {
    purpose: JsText,
    guard: Rc<GuardedSchema>,
    ctx: Weak<Context>,
}
impl Schema for Parser {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = AppCause;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        let ctx = self.ctx.upgrade().unwrap();
        ctx.log(format!("parse:{}", self.purpose.as_utf8().unwrap()));
        match observe!(
            &ctx,
            demlik_tea::llm_call::Schema::parse,
            self.guard.as_ref(),
            raw
        ) {
            Ok(value) => Ok(value),
            Err(CallValue::Shared(e)) => {
                ctx.guard_errors.borrow_mut().push(Rc::clone(&e));
                Err(CallValue::value(AppCause::Guard(e)))
            }
            Err(CallValue::Undefined) => Err(CallValue::Undefined),
            Err(CallValue::Missing) => Err(CallValue::Missing),
        }
    }
}
struct Message(Rc<Request<JsText, Payload>>);
struct Loader(Rc<Context>);
impl MessageLoader<JsText, Payload, Message, AppCause> for Loader {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload>>,
    ) -> Result<Messages<'a, Message>, CallValue<AppCause>>
    where
        Message: 'a,
    {
        self.0
            .log(format!("load:{}", call.purpose.as_utf8().unwrap()));
        Ok(Messages::Shared(Rc::new(vec![Message(Rc::clone(call))])))
    }
}
struct Factory(Rc<Context>);
struct Client(Rc<Context>);
impl ModelFactory<Message, Parser> for Factory {
    fn model_of(
        &self,
        _: Option<&JsText>,
    ) -> Result<impl Llm<Message, Parser>, CallValue<AppCause>> {
        self.0.log("factory");
        Ok(Client(Rc::clone(&self.0)))
    }
}
impl Llm<Message, Parser> for Client {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a Parser,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, Message>) -> Result<Rc<PlainData>, CallValue<AppCause>> + 'a,
        CallValue<AppCause>,
    > {
        self.0.schema_same.set(
            self.0.schema_same.get()
                && self
                    .0
                    .schemas
                    .borrow()
                    .iter()
                    .any(|s| std::ptr::eq(s.as_ref(), schema)),
        );
        self.0
            .log(format!("bind:{}", schema.purpose.as_utf8().unwrap()));
        Ok(async move |messages: Messages<'_, Message>| {
            let call = &messages.as_ref()[0].0;
            self.0.model_calls.set(self.0.model_calls.get() + 1);
            self.0
                .log(format!("model:{}", call.purpose.as_utf8().unwrap()));
            if self.0.input.checkpoint == Checkpoint::ModelError {
                return Err(CallValue::value(AppCause::Model(Rc::clone(&self.0.cause))));
            }
            schema.parse(self.0.turn(call))
        })
    }
}
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<InvoiceResult>;
    type Completion = Vec<Self::Msg>;
    fn settle(self, v: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(v)
    }
}
struct Tools(Rc<Context>);
impl Interpreter<Tool, Msg> for Tools {
    type Error = AgentWorkError<std::io::Error>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<InvoiceResult>>, Self::Error>> {
        Some(CommandWork::new(async move {
            let ctx = &self.0;
            if let Some(expected) = ctx.decoded.borrow().as_ref().and_then(Weak::upgrade)
                && expected.call_id() == cmd.0.call_id()
            {
                ctx.decoded_command.set(Some(Rc::ptr_eq(&expected, &cmd.0)));
            }
            ctx.tool_calls.set(ctx.tool_calls.get() + 1);
            ctx.log(format!("tool:{}", cmd.0.name().as_utf8().unwrap()));
            let PlainData::Object(args) = cmd.0.args() else {
                panic!("invoice args")
            };
            let PlainData::String(file) = &args["file"] else {
                panic!("invoice file")
            };
            assert!(
                matches!(&args["unknownArg"],PlainData::String(s) if s.as_utf8()==Some("kept")),
                "decoded args retain unknown field"
            );
            let bytes =
                tokio::fs::read_to_string(ctx.input.directory.join(file.as_utf8().unwrap()))
                    .await
                    .map_err(AgentWorkError::Tool)?;
            let invoice: Value = serde_json::from_str(&bytes).expect("invoice JSON");
            let sum = invoice["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .sum::<f64>();
            if sum != invoice["total"].as_f64().unwrap() {
                ctx.validated.set(false);
                return Ok(vec![AgentToolMsg::Err {
                    call_id: cmd.0.call_id().clone(),
                    reason: "invoice total mismatch".into(),
                    at: ctx.clock.get(),
                }]);
            }
            Ok(vec![AgentToolMsg::Ok {
                call_id: cmd.0.call_id().clone(),
                result: Rc::new(InvoiceResult { value: sum }),
                at: ctx.clock.get(),
            }])
        }))
    }
}
struct HostTimer {
    clock: Rc<Cell<f64>>,
    rows: RefCell<Vec<(f64, Option<TimerCallback>)>>,
    events: RefCell<Vec<Value>>,
}
impl Timer for HostTimer {
    type Handle = usize;
    fn now_ms(&self) -> f64 {
        self.clock.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<usize, TimerError> {
        let at = self.now_ms() + ms;
        let mut rows = self.rows.borrow_mut();
        let id = rows.len();
        rows.push((at, Some(callback)));
        self.events.borrow_mut().push(json!(["arm", at]));
        Ok(id)
    }
    fn clear_timeout(&self, id: &usize) {
        if let Some((at, c)) = self.rows.borrow_mut().get_mut(*id) {
            c.take();
            self.events.borrow_mut().push(json!(["cancel", *at]));
        }
    }
}
#[derive(Debug)]
enum SaveError {
    Cut,
    File(FileStoreError),
}
impl fmt::Display for SaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cut => f.write_str("persisted-before-effect"),
            Self::File(e) => e.fmt(f),
        }
    }
}
fn decode_state(raw: PlainData) -> Migrated<Rc<State>> {
    if matches!(&raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    match serde_json::from_str(&stringify_json(&raw).expect("JSON store returns JSON data")) {
        Ok(state) => Migrated::State(Rc::new(state)),
        Err(e) => Migrated::Refused(refuse(format!("invoice checkpoint: {e}"))),
    }
}
type BaseStore = FileStore<Rc<State>, fn(PlainData) -> Migrated<Rc<State>>>;
struct Saved {
    base: BaseStore,
    ctx: Rc<Context>,
}
impl Store<Rc<State>> for Saved {
    type Raw = PlainData;
    type Error = SaveError;
    async fn load(&self) -> Result<PlainData, SaveError> {
        observe_async!(&self.ctx, demlik_tea::storage::Store::load, &self.base)
            .map_err(SaveError::File)
    }
    async fn save(&self, s: &Rc<State>) -> Result<(), SaveError> {
        self.ctx
            .log(format!("save:{}:{}", s.run.phase.as_str(), stage(s)));
        observe_async!(&self.ctx, demlik_tea::storage::Store::save, &self.base, s)
            .map_err(SaveError::File)?;
        self.ctx.saved.replace(Some(Rc::downgrade(s)));
        let first_stage = stage(s) == "collect";
        let target = self.ctx.input.mode == Mode::Writer
            && first_stage
            && match self.ctx.input.checkpoint {
                Checkpoint::Brain => {
                    s.conversation
                        .as_ref()
                        .is_some_and(|c| matches!(c.awaiting, Awaiting::Llm))
                        && self.ctx.model_calls.get() == 0
                }
                Checkpoint::Tools => s
                    .conversation
                    .as_ref()
                    .is_some_and(|c| matches!(c.awaiting, Awaiting::Tools { .. })),
                Checkpoint::ToolError => s.conversation.as_ref().is_some_and(|c| {
                    matches!(c.awaiting, Awaiting::Llm) && !c.tool_records.is_empty()
                }),
                _ => false,
            };
        if target && !self.ctx.cut.replace(true) {
            self.ctx.log("crash-window");
            return Err(SaveError::Cut);
        }
        Ok(())
    }
    fn migrate(&self, raw: PlainData) -> Migrated<Rc<State>> {
        let parsed = observe!(
            &self.ctx,
            demlik_tea::storage::Store::migrate,
            &self.base,
            raw
        );
        if let Migrated::State(s) = &parsed {
            self.ctx.loaded.replace(Some(Rc::downgrade(s)));
        }
        parsed
    }
}
fn stage(s: &State) -> String {
    s.current_stage()
        .map_or("-".into(), |s| s.as_utf8().unwrap().into())
}
fn failure_kind(
    e: &RuntimeError<
        SaveError,
        AgentWorkError<std::io::Error>,
        demlik_tea::agent::AgentMachineError,
    >,
) -> &'static str {
    match e {
        RuntimeError::Save(SaveError::Cut) => "save",
        RuntimeError::Save(SaveError::File(_)) => "file",
        _ => e.name(),
    }
}
fn cause_view(s: &State, ctx: &Context) -> Value {
    let AgentField::Value(Some(failure)) = &s.failure else {
        return Value::Null;
    };
    let AgentFailure::Llm {
        error: AgentField::Value(error),
        ..
    } = failure.as_ref()
    else {
        return Value::Null;
    };
    let (kind, same, value) = match &error.error {
        LlmCause::Value(cause) => match cause.as_ref() {
            AppCause::Model(e) => ("live-model", Rc::ptr_eq(e, &ctx.cause), json!({})),
            AppCause::Guard(e) => (
                "live-guard",
                ctx.guard_errors.borrow().iter().any(|v| Rc::ptr_eq(v, e)),
                json!({}),
            ),
            AppCause::Data(v) => (
                "plain-data",
                false,
                serde_json::from_str(&stringify_json(v).unwrap()).unwrap(),
            ),
        },
        _ => ("other", false, Value::Null),
    };
    json!({"kind":kind,"originalSame":same,"value":value,"reason":error.reason})
}
async fn execute(input: Input) -> Value {
    if input.mode == Mode::Writer {
        std::fs::create_dir_all(&input.directory).unwrap();
        std::fs::write(input.directory.join("invoice.json"),json!({"invoiceId":"inv-17","lines":[4.5,10.5],"total":if input.checkpoint==Checkpoint::ToolError{16}else{15}}).to_string()).unwrap();
    }
    let clock = Rc::new(Cell::new(if input.mode == Mode::Writer {
        17.25
    } else {
        50.0
    }));
    let ctx = Rc::new(Context {
        input,
        clock: Rc::clone(&clock),
        trace: RefCell::new(vec![]),
        calls: RefCell::new(vec![]),
        schemas: RefCell::new(vec![]),
        cause: Rc::new(OpaqueError(Cell::new(71))),
        guard_errors: RefCell::new(vec![]),
        model_calls: Cell::new(0),
        tool_calls: Cell::new(0),
        schema_same: Cell::new(true),
        validated: Cell::new(true),
        loaded: RefCell::new(None),
        saved: RefCell::new(None),
        cut: Cell::new(false),
        decoded: RefCell::new(None),
        decoded_command: Cell::new(None),
        decoded_record: Cell::new(None),
    });
    let guard = Rc::new(AGENT_TURN_SCHEMA);
    for p in ["collect", "check", "summarize"] {
        ctx.schemas.borrow_mut().push(Rc::new(Parser {
            purpose: p.into(),
            guard: Rc::clone(&guard),
            ctx: Rc::downgrade(&ctx),
        }));
    }
    let select = Rc::clone(&ctx);
    let describe = Rc::clone(&ctx);
    let llm = Rc::new(
        LlmCall::new(
            llm_call::Config::new(move |p: &JsText| {
                Rc::clone(
                    select
                        .schemas
                        .borrow()
                        .iter()
                        .find(|s| s.purpose == *p)
                        .unwrap(),
                )
            }),
            move |e: &AppCause| match e {
                AppCause::Model(v) => {
                    assert!(Rc::ptr_eq(v, &describe.cause));
                    assert_eq!(v.0.get(), 71);
                    Ok("invoice model rejected".into())
                }
                AppCause::Guard(v) => v.describe(),
                AppCause::Data(v) => demlik_tea::describe_error::describe_error(
                    demlik_tea::describe_error::ErrorView::Value(v),
                ),
            },
        )
        .with_rng(|| 0.0),
    );
    let agent: Rc<Knob> = Rc::new(create_agent(
        AgentConfig::from_plain_turns(
            llm,
            ["collect", "check", "summarize"]
                .into_iter()
                .map(|s| Rc::<JsText>::new(s.into()))
                .collect(),
            |s| s.unwrap().as_ref().clone(),
            |call| Tool(Rc::clone(call)),
            |_, conversation, _| Payload {
                conversation: Rc::clone(conversation),
            },
        )
        .deadline_ms(100.0),
    ));
    let timer = Rc::new(HostTimer {
        clock: Rc::clone(&clock),
        rows: RefCell::new(vec![]),
        events: RefCell::new(vec![]),
    });
    let wired = observe!(
        &ctx,
        demlik_tea::agent::Agent::to_machine,
        Rc::clone(&agent),
        Factory(Rc::clone(&ctx)),
        Loader(Rc::clone(&ctx)),
        Tools(Rc::clone(&ctx)),
        Rc::clone(&timer)
    );
    let base = observe!(
        &ctx,
        demlik_tea::file_store::file_store,
        ctx.input.directory.join("state.json"),
        decode_state as fn(PlainData) -> Migrated<Rc<State>>
    );
    let profile = match ctx.input.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options = Options::new(profile);
    let now = Rc::clone(&clock);
    options.clock = Rc::new(move || now.get());
    options.store = Some(runtime::Persistence::new(Saved {
        base,
        ctx: Rc::clone(&ctx),
    }));
    options.terminal = Some(Rc::new(|s: &Rc<State>| s.is_settled()));
    let reports = Rc::new(RefCell::new(vec![]));
    let report = Rc::clone(&reports);
    options.on_error = Some(Rc::new(move |e, p| {
        report.borrow_mut().push(json!([
            match p {
                ErrorPhase::FollowUp => "follow-up".to_owned(),
                _ => format!("{p:?}").to_lowercase(),
            },
            failure_kind(e)
        ]));
    }));
    let committed = Rc::clone(&ctx);
    options.on_commit.push(Rc::new(move |m: Option<&Msg>, s| {
        committed.inspect_record(s);
        committed.log(format!(
            "commit:{}:{}:{}",
            m.map_or("boot", Tagged::tag),
            s.run.phase.as_str(),
            stage(s)
        ));
    }));
    let run = observe!(
        &ctx,
        demlik_tea::runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        options
    );
    observe_async!(&ctx, demlik_tea::runtime::Runtime::ready, &run).unwrap();
    let ready = run.get_state().unwrap();
    if ctx.input.mode == Mode::Reader
        && let Some(call) = ready.tools.running.first()
    {
        ctx.decoded.replace(Some(Rc::downgrade(call)));
    }
    let ready_view = json!({"loadedSame":if ctx.input.mode==Mode::Reader{Some(ctx.loaded.borrow().as_ref().and_then(Weak::upgrade).is_some_and(|v|Rc::ptr_eq(&v,ready.as_ref())))}else{None},"modelCalls":ctx.model_calls.get(),"toolCalls":ctx.tool_calls.get(),"wire":serde_json::to_value(ready.as_ref()).unwrap(),"cause":cause_view(&ready,&ctx)});
    let msg = if ctx.input.mode == Mode::Writer {
        AgentMachineMsg::Start {
            run_id: "invoice-17".into(),
            at: 0.0,
        }
    } else {
        observe!(&ctx, demlik_tea::agent::agent_boot_msg, clock.get())
    };
    let dispatched = observe_async!(&ctx, demlik_tea::runtime::Runtime::dispatch, &run, msg);
    let dispatch_failure = dispatched.err().map(|e| failure_kind(&e));
    let state = run.get_state().unwrap();
    let cause = cause_view(&state, &ctx);
    let settled = state.is_settled();
    if settled {
        observe_async!(&ctx, demlik_tea::runtime::Runtime::done, &run).unwrap();
    }
    observe_async!(&ctx, demlik_tea::runtime::Runtime::stop, &run);
    let bytes = std::fs::read_to_string(ctx.input.directory.join("state.json")).unwrap();
    let wire: Value = serde_json::from_str(&bytes).unwrap();
    json!({"id":ctx.input.id,"view":{"ready":ready_view,"wire":wire,"modelCalls":ctx.model_calls.get(),"toolCalls":ctx.tool_calls.get(),"settled":settled,"savedSame":ctx.saved.borrow().as_ref().and_then(Weak::upgrade).is_some_and(|v|Rc::ptr_eq(&v,state.as_ref())),"cause":cause,"schemaSame":ctx.schema_same.get(),"dispatchFailure":dispatch_failure,"cut":ctx.cut.get(),"decodedCommandSame":ctx.decoded_command.get(),"decodedRecordSame":ctx.decoded_record.get(),"trace":ctx.trace.borrow().clone(),"reports":reports.borrow().clone(),"timers":timer.events.borrow().clone()},"wireText":bytes,"calls":ctx.calls.borrow().clone()})
}
fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).unwrap();
    let input: Input = serde_json::from_str(&text).expect("precise cold JSON phase");
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let result = tokio::task::LocalSet::new().block_on(&host, execute(input));
    println!("{result}");
}
