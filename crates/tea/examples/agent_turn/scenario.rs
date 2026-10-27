use demlik_tea::{
    PlainData, Tagged,
    agent::{
        Agent, AgentConfig, AgentMachineError, AgentMachineMsg, AgentToolMsg, AgentWorkError,
        GuardedSchema, PlainCalls, PlainToolCall, StateOf, StructuredOutputError, create_agent,
        model::{Llm, MessageLoader, Messages, ModelFactory},
        types::{
            AGENT_TURN_SCHEMA, AgentFailure, AgentField, Awaiting, Conversation, ToolRecordOf,
        },
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, JsonData},
    llm_call::{self, LlmCall, LlmCause, Request, Schema},
    resilience::resilient_call::{CallPhase, CallValue},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{
        self, CommandContext, CommandWork, ErrorPhase, Interpreter, Options, Profile, RuntimeError,
    },
    storage::{Migrated, Store},
    timing::{Timer, TimerCallback, TimerError},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    ops::AsyncFn,
    path::PathBuf,
    rc::{Rc, Weak},
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

macro_rules! observe {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));value}};}
macro_rules! observe_async {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*).await;$ctx.calls.borrow_mut().push(stringify!($f));value}};}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    ProjectionError,
    Normal,
    Duplicate,
    StaleSettlements,
    FreshBoot,
    TerminalBoot,
    BadTotal,
    ToolIoError,
    ModelError,
    ParseError,
    RetryOnce,
    RetryExhaust,
    RestartBrain,
    RestartTool,
    RestartToolIoError,
    Cancel,
    LateToolFail,
    Deadline,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Input {
    #[serde(default)]
    pub id: Option<String>,
    pub profile: SelectedProfile,
    pub scenario: Scenario,
    #[serde(default = "total")]
    pub total: f64,
    #[serde(default)]
    pub turn_mode: TurnMode,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TurnMode {
    #[default]
    Extras,
    ArrayArgs,
    Presence,
    UsageMissing,
    UsageUndefined,
    UsageTotals,
    Bare,
}
fn total() -> f64 {
    15.0
}

#[derive(Serialize, Deserialize)]
pub struct InvoiceResult {
    pub value: f64,
}
pub struct ModelCause {
    pub marker: Cell<u32>,
}
pub struct Payload {
    pub conversation: Rc<Conversation<InvoiceResult, Turn, PlainData, PlainData, PlainCalls>>,
}
pub type Turn = PlainData;
pub enum Cause {
    Model(Rc<ModelCause>),
    Guard(Rc<StructuredOutputError>),
}
pub type State =
    StateOf<JsText, JsText, Payload, Parser, InvoiceResult, PlainData, PlainData, Turn, PlainCalls>;
pub type HostMsg = AgentMachineMsg<JsText, Payload, Rc<Turn>, Cause, AgentToolMsg<InvoiceResult>>;
type Knob = Agent<
    'static,
    JsText,
    JsText,
    Payload,
    Parser,
    InvoiceResult,
    PlainData,
    PlainData,
    Turn,
    PlainData,
    Tool,
    PlainCalls,
>;
pub struct Message(Rc<Request<JsText, Payload>>);
pub struct Context {
    input: Input,
    path: PathBuf,
    clock: Rc<Cell<f64>>,
    trace: RefCell<Vec<String>>,
    calls: RefCell<Vec<&'static str>>,
    schemas: RefCell<Vec<Rc<Parser>>>,
    cause: Rc<ModelCause>,
    guard_errors: RefCell<Vec<Rc<StructuredOutputError>>>,
    roots: RefCell<Vec<Weak<PlainData>>>,
    seen_views: RefCell<Vec<Weak<PlainToolCall>>>,
    record_handles: RefCell<Vec<Weak<Record>>>,
    raw_turns: RefCell<Vec<Value>>,
    usage_readings: RefCell<Vec<Value>>,
    codecs: RefCell<Vec<Value>>,
    selections: RefCell<Vec<Value>>,
    parsed_original: Cell<bool>,
    call_original: Cell<bool>,
    args_original: Cell<bool>,
    views_retained: Cell<bool>,
    records_original: Cell<bool>,
    first_wins: Cell<bool>,
    requests: RefCell<Vec<Rc<Request<JsText, Payload>>>>,
    model_calls: Cell<usize>,
    tool_calls: Cell<usize>,
    schema_same: Cell<bool>,
    validated: Cell<bool>,
    results: RefCell<Vec<Rc<InvoiceResult>>>,
    entered: Notify,
    released: Notify,
    cancelled: Notify,
    deadlined: Notify,
    io: RefCell<Option<Rc<std::io::Error>>>,
}
impl Context {
    fn log(&self, event: impl Into<String>) {
        self.trace.borrow_mut().push(event.into());
    }
}
fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text_field<'a>(value: &'a PlainData, key: &str) -> &'a JsText {
    let PlainData::Object(fields) = value else {
        panic!("object field {key}")
    };
    let PlainData::String(text) = &fields[key] else {
        panic!("string field {key}")
    };
    text
}
fn call_nodes(turn: &PlainData) -> &[PlainData] {
    let PlainData::Object(fields) = turn else {
        panic!("turn object")
    };
    let PlainData::Array(calls) = &fields["toolCalls"] else {
        panic!("turn calls")
    };
    calls
}
fn arg_node(call: &PlainData) -> &PlainData {
    let PlainData::Object(fields) = call else {
        panic!("call object")
    };
    &fields["args"]
}
fn args_info(args: &PlainData) -> (&JsText, &JsText) {
    match args {
        PlainData::Object(fields) => {
            let PlainData::String(file) = &fields["file"] else {
                panic!("file")
            };
            let PlainData::String(label) = &fields["label"] else {
                panic!("label")
            };
            (file, label)
        }
        PlainData::Array(fields) => {
            let PlainData::String(file) = &fields[0] else {
                panic!("file")
            };
            let PlainData::String(label) = &fields[1] else {
                panic!("label")
            };
            (file, label)
        }
        _ => panic!("invoice args representation"),
    }
}
fn presence(value: &PlainData, key: &str) -> &'static str {
    match value {
        PlainData::Object(fields) => match fields.get(key) {
            None => "missing",
            Some(PlainData::Undefined) => "undefined",
            Some(PlainData::Null) => "null",
            Some(_) => "value",
        },
        _ => "not-object",
    }
}
fn wire(value: &impl Serialize) -> Value {
    serde_json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}
type Record = ToolRecordOf<InvoiceResult, PlainData, PlainData, PlainCalls>;
impl Context {
    fn same_cause(&self, cause: &Cause) -> bool {
        match cause {
            Cause::Model(value) => Rc::ptr_eq(value, &self.cause),
            Cause::Guard(value) => self
                .guard_errors
                .borrow()
                .iter()
                .any(|v| Rc::ptr_eq(v, value)),
        }
    }
    fn observe_call(&self, call: &Rc<PlainToolCall>) {
        let roots = self.roots.borrow();
        let original = roots
            .iter()
            .filter_map(Weak::upgrade)
            .find(|root| Rc::ptr_eq(root, call.owner()));
        let Some(root) = original else {
            self.call_original.set(false);
            self.args_original.set(false);
            return;
        };
        let nodes = call_nodes(&root);
        let node = call.index().and_then(|i| nodes.get(i));
        self.call_original.set(
            self.call_original.get() && node.is_some_and(|v| std::ptr::eq(v, call.raw_call())),
        );
        self.args_original.set(
            self.args_original.get()
                && node.is_some_and(|v| std::ptr::eq(arg_node(v), call.args())),
        );
        let first = nodes
            .iter()
            .find(|v| text_field(v, "callId") == call.call_id());
        self.first_wins
            .set(self.first_wins.get() && first.is_some_and(|v| std::ptr::eq(v, call.raw_call())));
        drop(roots);
        let mut views = self.seen_views.borrow_mut();
        if let Some(prior) = views
            .iter()
            .filter_map(Weak::upgrade)
            .find(|v| std::ptr::eq(v.raw_call(), call.raw_call()))
        {
            self.views_retained
                .set(self.views_retained.get() && Rc::ptr_eq(&prior, call));
        } else {
            views.push(Rc::downgrade(call));
        }
    }
    fn inspect_state(&self, state: &State) {
        for call in &state.tools.running {
            self.observe_call(call);
        }
        let awaiting = state.conversation.as_ref().map(|c| match c.awaiting {
            Awaiting::Llm => "llm",
            Awaiting::Tools { .. } => "tools",
            Awaiting::Compacting { .. } => "compacting",
        });
        let context = state
            .conversation
            .as_ref()
            .and_then(|c| c.context_tokens.value())
            .and_then(|v| v.number());
        self.usage_readings.borrow_mut().push(json!([
            state.run.phase.as_str(),
            stage(state),
            awaiting,
            wire(&state.usage.value().and_then(Option::as_ref)),
            context
        ]));
        if let Some(conversation) = &state.conversation {
            for record in conversation.tool_records.iter() {
                self.observe_call(&record.call);
                let same = self
                    .seen_views
                    .borrow()
                    .iter()
                    .filter_map(Weak::upgrade)
                    .any(|v| Rc::ptr_eq(&v, &record.call));
                self.records_original
                    .set(self.records_original.get() && same);
                if self
                    .record_handles
                    .borrow()
                    .iter()
                    .filter_map(Weak::upgrade)
                    .any(|v| Rc::ptr_eq(&v, record))
                {
                    continue;
                }
                self.record_handles.borrow_mut().push(Rc::downgrade(record));
                let record_text = serde_json::to_string(record).unwrap();
                let decoded: Record = serde_json::from_str(&record_text).unwrap();
                let conversation_text = serde_json::to_string(conversation).unwrap();
                let decoded_conversation: Conversation<
                    InvoiceResult,
                    PlainData,
                    PlainData,
                    PlainData,
                    PlainCalls,
                > = serde_json::from_str(&conversation_text).unwrap();
                self.codecs.borrow_mut().push(json!({"record":serde_json::from_str::<Value>(&record_text).unwrap(),"recordRoundTrip":wire(&decoded)==serde_json::from_str::<Value>(&record_text).unwrap(),"conversation":serde_json::from_str::<Value>(&conversation_text).unwrap(),"conversationRoundTrip":wire(&decoded_conversation)==serde_json::from_str::<Value>(&conversation_text).unwrap(),"decodedCallUndefined":presence(decoded.call.raw_call(),"unknownUndefined")}));
            }
        }
    }
    fn prepare_turn(&self, call: &Request<JsText, Payload>) -> Rc<PlainData> {
        let purpose = call.purpose.as_utf8().unwrap();
        let count = call.payload.conversation.tool_records.len();
        let more = purpose == "collect"
            && matches!(
                self.input.turn_mode,
                TurnMode::UsageMissing | TurnMode::UsageUndefined
            );
        let needs = purpose != "summarize" && count < if more { 2 } else { 1 };
        let id = if more {
            format!("{purpose}-17-{count}")
        } else {
            format!("{purpose}-17")
        };
        let ordinal = self.roots.borrow().len() + 1;
        let bare = self.input.turn_mode == TurnMode::Bare;
        let make_call = |label: &str, file: &str| {
            let args = if self.input.turn_mode == TurnMode::ArrayArgs {
                PlainData::Array(vec![
                    PlainData::String(file.into()),
                    PlainData::String(label.into()),
                    object([
                        ("unknownArg", PlainData::String("kept".into())),
                        ("unknownUndefined", PlainData::Undefined),
                    ]),
                ])
            } else {
                let mut fields = vec![
                    ("file", PlainData::String(file.into())),
                    ("label", PlainData::String(label.into())),
                ];
                if !bare {
                    fields.extend([
                        ("unknownArg", PlainData::String("kept".into())),
                        ("unknownUndefined", PlainData::Undefined),
                        ("__proto__", object([("args", PlainData::Bool(true))])),
                    ]);
                }
                object(fields)
            };
            let mut fields = vec![
                ("callId", PlainData::String(id.clone().into())),
                ("name", PlainData::String(purpose.into())),
                ("args", args),
            ];
            if !bare {
                fields.extend([
                    (
                        "unknownCall",
                        object([
                            ("label", PlainData::String(label.into())),
                            ("ordinal", PlainData::Number(ordinal as f64)),
                        ]),
                    ),
                    ("unknownUndefined", PlainData::Undefined),
                    ("__proto__", object([("call", PlainData::Bool(true))])),
                ]);
            }
            object(fields)
        };
        let mut calls = if needs {
            vec![make_call("first", "invoice.json")]
        } else {
            vec![]
        };
        if needs && self.input.scenario == Scenario::Duplicate {
            calls.push(make_call("second", "duplicate.json"));
        }
        let content = if self.input.scenario == Scenario::ParseError {
            PlainData::Number(0.0)
        } else {
            PlainData::String(
                if purpose == "summarize" {
                    if self.validated.get() {
                        "Invoice total confirmed: 15"
                    } else {
                        "Invoice requires review"
                    }
                } else {
                    purpose
                }
                .into(),
            )
        };
        let mut fields = vec![("content", content), ("toolCalls", PlainData::Array(calls))];
        if !bare {
            fields.extend([
                (
                    "unknownTurn",
                    PlainData::Array(vec![
                        PlainData::String(purpose.into()),
                        PlainData::Number(ordinal as f64),
                    ]),
                ),
                ("unknownUndefined", PlainData::Undefined),
                ("__proto__", object([("turn", PlainData::Bool(true))])),
            ]);
            match (self.input.turn_mode, ordinal % 3) {
                (TurnMode::Presence, 1) => {}
                (TurnMode::Presence, 2) => fields.push(("provider", PlainData::Undefined)),
                (TurnMode::Presence, _) => fields.push(("provider", PlainData::Null)),
                _ => fields.push((
                    "provider",
                    object([
                        ("opaque", PlainData::String("kept".into())),
                        ("ordinal", PlainData::Number(ordinal as f64)),
                    ]),
                )),
            }
        }
        if matches!(
            self.input.turn_mode,
            TurnMode::UsageMissing | TurnMode::UsageUndefined | TurnMode::UsageTotals
        ) {
            let undefined = more && count == 1 && self.input.turn_mode == TurnMode::UsageUndefined;
            let missing = more && count == 1 && self.input.turn_mode == TurnMode::UsageMissing;
            if undefined {
                fields.push(("usage", PlainData::Undefined));
            } else if !missing {
                let usage = if purpose == "collect" && count == 0 {
                    Some(object([
                        ("inputTokens", PlainData::Number(7.0)),
                        ("outputTokens", PlainData::Number(2.0)),
                        ("reasoningTokens", PlainData::Number(3.0)),
                        ("cachedInputTokens", PlainData::Undefined),
                        ("usageUnknown", PlainData::String("kept".into())),
                    ]))
                } else if purpose == "collect" {
                    Some(object([
                        ("inputTokens", PlainData::Number(2.0)),
                        ("outputTokens", PlainData::Number(1.0)),
                        ("cachedInputTokens", PlainData::Number(4.0)),
                        ("reasoningTokens", PlainData::Undefined),
                    ]))
                } else if purpose == "check" && count == 0 {
                    Some(object([
                        ("inputTokens", PlainData::Number(5.0)),
                        ("outputTokens", PlainData::Number(1.0)),
                        ("reasoningTokens", PlainData::Undefined),
                    ]))
                } else if purpose == "summarize" {
                    Some(object([
                        ("inputTokens", PlainData::Number(1.0)),
                        ("outputTokens", PlainData::Number(1.0)),
                        ("reasoningTokens", PlainData::Number(0.0)),
                    ]))
                } else {
                    None
                };
                if let Some(usage) = usage {
                    fields.push(("usage", usage));
                }
            }
        }
        let raw = Rc::new(object(fields));
        self.raw_turns.borrow_mut().push(json!({"raw":wire(&JsonData(&raw)),"provider":presence(&raw,"provider"),"usage":presence(&raw,"usage"),"unknownUndefined":presence(&raw,"unknownUndefined")}));
        self.roots.borrow_mut().push(Rc::downgrade(&raw));
        raw
    }
}

pub struct Parser {
    purpose: JsText,
    ctx: Weak<Context>,
    guard: Rc<GuardedSchema>,
}
impl Schema for Parser {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = Cause;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Cause>> {
        let ctx = self.ctx.upgrade().unwrap();
        ctx.log(format!("parse:{}", self.purpose.as_utf8().unwrap()));
        let original = Rc::clone(&raw);
        let result = observe!(
            &ctx,
            demlik_tea::llm_call::Schema::parse,
            self.guard.as_ref(),
            raw
        );
        match result {
            Ok(parsed) => {
                ctx.parsed_original
                    .set(ctx.parsed_original.get() && Rc::ptr_eq(&original, &parsed));
                Ok(parsed)
            }
            Err(CallValue::Shared(error)) => {
                ctx.guard_errors.borrow_mut().push(Rc::clone(&error));
                Err(CallValue::value(Cause::Guard(error)))
            }
            Err(CallValue::Undefined) => Err(CallValue::Undefined),
            Err(CallValue::Missing) => Err(CallValue::Missing),
        }
    }
}

struct Factory(Rc<Context>);
struct Client(Rc<Context>);
impl ModelFactory<Message, Parser> for Factory {
    fn model_of(&self, _: Option<&JsText>) -> Result<impl Llm<Message, Parser>, CallValue<Cause>> {
        self.0.log("factory");
        Ok(Client(Rc::clone(&self.0)))
    }
}
impl Llm<Message, Parser> for Client {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a Parser,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, Message>) -> Result<Rc<Turn>, CallValue<Cause>> + 'a,
        CallValue<Cause>,
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
            assert_eq!(call.purpose, schema.purpose);
            self.0.model_calls.set(self.0.model_calls.get() + 1);
            self.0
                .log(format!("model:{}", call.purpose.as_utf8().unwrap()));
            if matches!(
                self.0.input.scenario,
                Scenario::ModelError | Scenario::RetryExhaust
            ) || (self.0.input.scenario == Scenario::RetryOnce && self.0.model_calls.get() == 1)
            {
                return Err(CallValue::value(Cause::Model(Rc::clone(&self.0.cause))));
            }
            let raw = self.0.prepare_turn(call);
            schema.parse(raw)
        })
    }
}
struct Loader(Rc<Context>);
impl MessageLoader<JsText, Payload, Message, Cause> for Loader {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload>>,
    ) -> Result<Messages<'a, Message>, CallValue<Cause>>
    where
        Message: 'a,
    {
        self.0
            .log(format!("load:{}", call.purpose.as_utf8().unwrap()));
        self.0.requests.borrow_mut().push(Rc::clone(call));
        Ok(Messages::Shared(Rc::new(vec![Message(Rc::clone(call))])))
    }
}
pub struct Tool(Rc<PlainToolCall>);
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
pub enum IoFailure {
    Read(Rc<std::io::Error>),
}
fn io_failure(ctx: &Context, error: std::io::Error) -> AgentWorkError<IoFailure> {
    let error = Rc::new(error);
    ctx.io.replace(Some(Rc::clone(&error)));
    AgentWorkError::Tool(IoFailure::Read(error))
}
struct Tools(Rc<Context>);
impl Interpreter<Tool, HostMsg> for Tools {
    type Error = AgentWorkError<IoFailure>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        context: CommandContext<HostMsg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<InvoiceResult>>, Self::Error>> {
        Some(CommandWork::new(async move {
            let ctx = &self.0;
            ctx.observe_call(&cmd.0);
            ctx.tool_calls.set(ctx.tool_calls.get() + 1);
            let (file, label) = args_info(cmd.0.args());
            ctx.selections
                .borrow_mut()
                .push(json!([cmd.0.call_id(), label, file]));
            ctx.log(format!("tool:{}", cmd.0.name().as_utf8().unwrap()));
            if matches!(
                ctx.input.scenario,
                Scenario::Cancel | Scenario::LateToolFail
            ) {
                let owned = Rc::clone(ctx);
                let id = cmd.0.call_id().clone();
                let _invoice = tokio::fs::read_to_string(ctx.path.join(file.as_utf8().unwrap()))
                    .await
                    .map_err(|e| io_failure(ctx, e))?;
                ctx.clock.set(30.0);
                context
                    .dispatch(observe!(ctx, demlik_tea::agent::agent_cancel_msg, 30.0))
                    .unwrap();
                context.clone().wait_until(async move {
                    owned.entered.notify_one();
                    owned.released.notified().await;
                    owned.log("late-tool");
                    let msg = if owned.input.scenario == Scenario::LateToolFail {
                        AgentToolMsg::Err {
                            call_id: id,
                            reason: "late validator rejection".into(),
                            at: owned.clock.get(),
                        }
                    } else {
                        AgentToolMsg::Ok {
                            call_id: id,
                            result: Rc::new(InvoiceResult { value: 15.0 }),
                            at: owned.clock.get(),
                        }
                    };
                    context.dispatch(AgentMachineMsg::Tool(msg)).unwrap();
                    Ok(())
                });
                return Ok(vec![]);
            }
            let path = if ctx.input.scenario == Scenario::ToolIoError {
                ctx.path.join("absent.json")
            } else {
                ctx.path.join(file.as_utf8().unwrap())
            };
            let bytes = tokio::fs::read_to_string(path)
                .await
                .map_err(|e| io_failure(ctx, e))?;
            let invoice: Value = serde_json::from_str(&bytes).expect("fixture invoice JSON");
            let sum = invoice["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .sum::<f64>();
            if ctx.input.scenario == Scenario::Deadline {
                return Ok(vec![]);
            }
            if cmd.0.name().as_utf8() == Some("check") && sum != invoice["total"].as_f64().unwrap()
            {
                ctx.validated.set(false);
                return Ok(vec![AgentToolMsg::Err {
                    call_id: cmd.0.call_id().clone(),
                    reason: "invoice total mismatch".into(),
                    at: ctx.clock.get(),
                }]);
            }
            let result = Rc::new(InvoiceResult { value: sum });
            ctx.results.borrow_mut().push(Rc::clone(&result));
            let mut messages = vec![AgentToolMsg::Ok {
                call_id: cmd.0.call_id().clone(),
                result,
                at: ctx.clock.get(),
            }];
            if ctx.input.scenario == Scenario::StaleSettlements {
                messages.push(AgentToolMsg::Err {
                    call_id: cmd.0.call_id().clone(),
                    reason: "already completed".into(),
                    at: ctx.clock.get() + 1.0,
                });
            }
            Ok(messages)
        }))
    }
}
struct ManualTimer {
    clock: Rc<Cell<f64>>,
    rows: RefCell<Vec<(f64, Option<TimerCallback>)>>,
    events: RefCell<Vec<Value>>,
}
impl Timer for ManualTimer {
    type Handle = usize;
    fn now_ms(&self) -> f64 {
        self.clock.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<usize, TimerError> {
        let at = self.now_ms() + ms;
        let mut rows = self.rows.borrow_mut();
        let id = rows.len();
        rows.push((at, Some(callback)));
        drop(rows);
        self.events.borrow_mut().push(json!(["arm", at]));
        Ok(id)
    }
    fn clear_timeout(&self, handle: &usize) {
        if let Some((at, callback)) = self.rows.borrow_mut().get_mut(*handle) {
            callback.take();
            self.events.borrow_mut().push(json!(["cancel", *at]));
        }
    }
}
impl ManualTimer {
    fn fire_next(&self) -> bool {
        let chosen = self
            .rows
            .borrow()
            .iter()
            .enumerate()
            .filter(|(_, (_, cb))| cb.is_some())
            .min_by(|a, b| a.1.0.total_cmp(&b.1.0))
            .map(|(id, (at, _))| (id, *at));
        let Some((id, at)) = chosen else { return false };
        let cb = self.rows.borrow_mut()[id].1.take().unwrap();
        self.clock.set(at);
        self.events.borrow_mut().push(json!(["fire", at]));
        cb().unwrap();
        true
    }
}
struct Saved {
    cell: Rc<RefCell<Option<Rc<State>>>>,
    ctx: Rc<Context>,
    crashed: Rc<Cell<bool>>,
}
#[derive(Debug)]
struct Crash;
impl fmt::Display for Crash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("persisted-before-effect")
    }
}
impl Store<Rc<State>> for Saved {
    type Raw = Option<Rc<State>>;
    type Error = Crash;
    async fn load(&self) -> Result<Self::Raw, Crash> {
        Ok(self.cell.borrow().clone())
    }
    async fn save(&self, s: &Rc<State>) -> Result<(), Crash> {
        self.ctx
            .log(format!("save:{}:{}", s.run.phase.as_str(), stage(s)));
        self.cell.replace(Some(Rc::clone(s)));
        let target = match self.ctx.input.scenario {
            Scenario::RestartBrain => s
                .conversation
                .as_ref()
                .is_some_and(|c| matches!(c.awaiting, Awaiting::Llm)),
            Scenario::RestartTool | Scenario::RestartToolIoError => s
                .conversation
                .as_ref()
                .is_some_and(|c| matches!(c.awaiting, Awaiting::Tools { .. })),
            _ => false,
        };
        if target && !self.crashed.replace(true) {
            self.ctx.log("crash-window");
            return Err(Crash);
        }
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Rc<State>> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
}
fn stage(s: &State) -> String {
    s.current_stage()
        .map_or("-".into(), |s| s.as_utf8().unwrap().into())
}
fn state_view(s: &State, ctx: &Context) -> Value {
    let failure_reason = match &s.failure {
        AgentField::Value(Some(f)) => match f.as_ref() {
            AgentFailure::Llm {
                error: AgentField::Value(error),
                ..
            } => Some(&error.reason),
            _ => None,
        },
        _ => None,
    };
    let (failure, cause_same) = match &s.failure {
        AgentField::Value(Some(f)) => match f.as_ref() {
            AgentFailure::Llm {
                error: AgentField::Value(error),
                ..
            } => (
                Some("llm"),
                Some(matches!(&error.error,LlmCause::Value(value) if ctx.same_cause(value))),
            ),
            _ => (Some("limit"), None),
        },
        _ => (None, None),
    };
    let output = match &s.output {
        AgentField::Value(Some(turn)) => Some(text_field(turn, "content").as_utf8().unwrap()),
        _ => None,
    };
    let records = s
        .conversation
        .as_ref()
        .map(|c| {
            c.tool_records
                .iter()
                .map(|r| {
                    json!([
                        r.call.call_id(),
                        match r.outcome.as_ref() {
                            demlik_tea::agent::types::ToolOutcome::Ok(result) =>
                                json!({"ok":result.value}),
                            demlik_tea::agent::types::ToolOutcome::Error(_) =>
                                json!({"error":true}),
                        }
                    ])
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let calls = ["collect", "check", "summarize"]
        .into_iter()
        .filter_map(|key| {
            s.resilience.call(key).map(|phase| {
                let phase = match phase {
                    CallPhase::Idle => "idle",
                    CallPhase::Running { .. } => "running",
                    CallPhase::WaitingRetry { .. } => "waiting_retry",
                    CallPhase::CircuitOpen => "circuit_open",
                    CallPhase::Succeeded { .. } => "succeeded",
                    CallPhase::Failed { .. } => "failed",
                };
                (key.to_owned(), json!(phase))
            })
        })
        .collect::<serde_json::Map<_, _>>();
    json!({"usage":serde_json::to_value(s.usage.value().and_then(Option::as_ref)).unwrap(),"contextTokens":s.conversation.as_ref().and_then(|c|c.context_tokens.value().copied()).map(|v|v.number()),"phase":s.run.phase.as_str(),"stage":stage(s),"settled":s.is_settled(),"failure":failure,"failureReason":failure_reason,"causeSame":cause_same,"output":output,"awaiting":s.conversation.as_ref().map(|c|match c.awaiting{Awaiting::Llm=>"llm",Awaiting::Tools{..}=>"tools",Awaiting::Compacting{..}=>"compacting"}),"records":records,"calls":calls,"retryKeys":s.resilience.snapshot().retry.own_entries().map(|(k,_)|k.clone()).collect::<Vec<_>>()})
}
fn failure_kind(
    error: &RuntimeError<Crash, AgentWorkError<IoFailure>, AgentMachineError>,
    ctx: &Context,
) -> &'static str {
    match error {
        RuntimeError::Save(_) => "save",
        RuntimeError::Handler(AgentWorkError::Tool(IoFailure::Read(error))) => {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
            assert!(Rc::ptr_eq(error, ctx.io.borrow().as_ref().unwrap()));
            "tool-io"
        }
        RuntimeError::Projection { .. } => "projection",
        RuntimeError::Contract(_) => "contract",
        _ => error.name(),
    }
}
fn report(
    error: &RuntimeError<Crash, AgentWorkError<IoFailure>, AgentMachineError>,
    phase: ErrorPhase,
    ctx: &Context,
) -> Value {
    let kind = failure_kind(error, ctx);
    json!([
        match phase {
            ErrorPhase::FollowUp => "follow-up".to_owned(),
            ErrorPhase::StopSave => "stop-save".to_owned(),
            _ => format!("{phase:?}").to_lowercase(),
        },
        kind
    ])
}
pub async fn execute(input: Input) -> Value {
    static SERIAL: AtomicUsize = AtomicUsize::new(0);
    let path = PathBuf::from("target/parity/agent-turn-io").join(format!(
        "{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    let declared = if input.scenario == Scenario::BadTotal {
        16.0
    } else {
        input.total
    };
    std::fs::write(
        path.join("invoice.json"),
        json!({"invoiceId":"inv-17","lines":[4.5,10.5],"total":declared}).to_string(),
    )
    .unwrap();
    std::fs::write(
        path.join("duplicate.json"),
        json!({"invoiceId":"inv-17","lines":[100.0],"total":100.0}).to_string(),
    )
    .unwrap();
    let clock = Rc::new(Cell::new(17.25));
    let ctx = Rc::new(Context {
        input: input.clone(),
        path: path.clone(),
        clock: Rc::clone(&clock),
        trace: RefCell::new(vec![]),
        calls: RefCell::new(vec![]),
        schemas: RefCell::new(vec![]),
        cause: Rc::new(ModelCause {
            marker: Cell::new(71),
        }),
        guard_errors: RefCell::new(vec![]),
        roots: RefCell::new(vec![]),
        seen_views: RefCell::new(vec![]),
        record_handles: RefCell::new(vec![]),
        raw_turns: RefCell::new(vec![]),
        usage_readings: RefCell::new(vec![]),
        codecs: RefCell::new(vec![]),
        selections: RefCell::new(vec![]),
        parsed_original: Cell::new(true),
        call_original: Cell::new(true),
        args_original: Cell::new(true),
        views_retained: Cell::new(true),
        records_original: Cell::new(true),
        first_wins: Cell::new(true),
        requests: RefCell::new(vec![]),
        model_calls: Cell::new(0),
        tool_calls: Cell::new(0),
        schema_same: Cell::new(true),
        validated: Cell::new(true),
        results: RefCell::new(vec![]),
        entered: Notify::new(),
        released: Notify::new(),
        cancelled: Notify::new(),
        deadlined: Notify::new(),
        io: RefCell::new(None),
    });
    let guard = Rc::new(AGENT_TURN_SCHEMA);
    for purpose in ["collect", "check", "summarize"] {
        ctx.schemas.borrow_mut().push(Rc::new(Parser {
            purpose: purpose.into(),
            ctx: Rc::downgrade(&ctx),
            guard: Rc::clone(&guard),
        }));
    }
    let config_ctx = Rc::clone(&ctx);
    let mut config = llm_call::Config::new(move |p: &JsText| {
        Rc::clone(
            config_ctx
                .schemas
                .borrow()
                .iter()
                .find(|s| s.purpose == *p)
                .unwrap(),
        )
    });
    if matches!(input.scenario, Scenario::RetryOnce | Scenario::RetryExhaust) {
        config.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 5.0,
                factor: 1.0,
                cap_ms: 5.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 2.0 },
        });
    }
    let describe = Rc::clone(&ctx);
    let llm = Rc::new(
        LlmCall::new(config, move |error: &Cause| {
            Ok(match error {
                Cause::Model(value) => {
                    assert!(Rc::ptr_eq(value, &describe.cause));
                    assert_eq!(value.marker.get(), 71);
                    "invoice model rejected".into()
                }
                Cause::Guard(value) => {
                    assert!(
                        describe
                            .guard_errors
                            .borrow()
                            .iter()
                            .any(|e| Rc::ptr_eq(e, value))
                    );
                    value.message().into()
                }
            })
        })
        .with_rng(|| 0.0),
    );
    let tool_ctx = Rc::clone(&ctx);
    let agent: Rc<Knob> = Rc::new(create_agent(
        AgentConfig::from_plain_turns(
            llm,
            ["collect", "check", "summarize"]
                .into_iter()
                .map(|v| Rc::<JsText>::new(v.into()))
                .collect(),
            |stage| stage.unwrap().as_ref().clone(),
            move |call| {
                tool_ctx.observe_call(call);
                Tool(Rc::clone(call))
            },
            |_, conversation, _| Payload {
                conversation: Rc::clone(conversation),
            },
        )
        .deadline_ms(100.0),
    ));
    let timer = Rc::new(ManualTimer {
        clock: Rc::clone(&clock),
        rows: RefCell::new(vec![]),
        events: RefCell::new(vec![]),
    });
    let seed = if input.scenario == Scenario::ProjectionError {
        let mut s = agent.init().as_ref().clone();
        s.compaction = AgentField::Absent;
        Some(Rc::new(s))
    } else {
        None
    };
    let saved = Rc::new(RefCell::new(seed));
    let crashed = Rc::new(Cell::new(false));
    let reports = Rc::new(RefCell::new(vec![]));
    let mut restart_observation = Value::Null;
    let profile = match input.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut final_state = None;
    let mut dispatch_failures = vec![];
    let mut done_same = None;
    let mut projection_failure = Value::Null;
    for round in 0..if matches!(
        input.scenario,
        Scenario::RestartBrain
            | Scenario::RestartTool
            | Scenario::RestartToolIoError
            | Scenario::TerminalBoot
    ) {
        2
    } else {
        1
    } {
        let wired = observe!(
            &ctx,
            demlik_tea::agent::Agent::to_machine,
            Rc::clone(&agent),
            Factory(Rc::clone(&ctx)),
            Loader(Rc::clone(&ctx)),
            Tools(Rc::clone(&ctx)),
            Rc::clone(&timer)
        );
        let mut options = Options::new(profile);
        options.clock = {
            let clock = Rc::clone(&clock);
            Rc::new(move || clock.get())
        };
        options.store = Some(runtime::Persistence::new(Saved {
            cell: Rc::clone(&saved),
            ctx: Rc::clone(&ctx),
            crashed: Rc::clone(&crashed),
        }));
        let report_list = Rc::clone(&reports);
        let report_ctx = Rc::clone(&ctx);
        options.on_error = Some(Rc::new(move |e, p| {
            report_list.borrow_mut().push(report(e, p, &report_ctx))
        }));
        options.terminal = Some(Rc::new(|s: &Rc<State>| s.is_settled()));
        let commit_ctx = Rc::clone(&ctx);
        options
            .on_commit
            .push(Rc::new(move |m: Option<&HostMsg>, s| {
                commit_ctx.inspect_state(s);
                commit_ctx.log(format!(
                    "commit:{}:{}:{}",
                    m.map_or("boot", Tagged::tag),
                    s.run.phase.as_str(),
                    stage(s)
                ));
                if s.run.phase.as_str() == "cancelled" {
                    commit_ctx.cancelled.notify_one();
                }
                if m.is_some_and(|m| m.tag() == "deadline_exceeded") {
                    commit_ctx.deadlined.notify_one();
                }
            }));
        let loaded = saved.borrow().clone();
        let calls_before = ctx.model_calls.get();
        let tools_before = ctx.tool_calls.get();
        let run = observe!(
            &ctx,
            demlik_tea::runtime::try_launch,
            wired.machine,
            (),
            wired.interpret,
            wired.subscribe,
            options
        );
        let ready = observe_async!(&ctx, demlik_tea::runtime::Runtime::ready, &run);
        if input.scenario == Scenario::ProjectionError {
            let failure = ready.err().expect("projection fails ready");
            let RuntimeError::Projection { failures } = failure.as_ref() else {
                panic!("projection failure")
            };
            let evidence = failures.first().unwrap();
            assert_eq!(evidence.kind.as_deref(), Some("deadline"));
            assert!(
                matches!(&evidence.cause,demlik_tea::core::ProjectionError::Declared(AgentMachineError::Agent(demlik_tea::agent::AgentError::UnsupportedRestoredProfile{profile:demlik_tea::agent::OptionalProfile::MissingCompaction,keys}))if keys.is_empty())
            );
            projection_failure =
                json!({"kind":evidence.kind,"cause":"declared","profile":"missing compaction"});
            final_state = run.get_state();
            observe_async!(&ctx, demlik_tea::runtime::Runtime::stop, &run);
            break;
        }
        ready.unwrap();
        if round == 1 {
            if input.scenario == Scenario::RestartToolIoError {
                std::fs::remove_file(ctx.path.join("invoice.json")).unwrap();
            }
            restart_observation = json!({"loadedSame":Rc::ptr_eq(run.get_state().unwrap().as_ref(),loaded.as_ref().unwrap()),"newModelCallsAtReady":ctx.model_calls.get()-calls_before,"newToolCallsAtReady":ctx.tool_calls.get()-tools_before,"stateAtReady":state_view(run.get_state().unwrap().as_ref(),&ctx)});
        }
        let msg = if round == 0 && input.scenario == Scenario::FreshBoot {
            observe!(&ctx, demlik_tea::agent::agent_boot_msg, clock.get())
        } else if round == 0 {
            AgentMachineMsg::Start {
                run_id: "invoice-17".into(),
                at: 0.0,
            }
        } else {
            observe!(&ctx, demlik_tea::agent::agent_boot_msg, clock.get())
        };
        if matches!(input.scenario, Scenario::Cancel | Scenario::LateToolFail) {
            let control = async {
                ctx.cancelled.notified().await;
                clock.set(35.0);
                ctx.released.notify_one();
            };
            let (result, ()) = tokio::join!(run.dispatch(msg), control);
            dispatch_failures.push(result.err().map(|e| failure_kind(&e, &ctx)));
        } else {
            let result = observe_async!(&ctx, demlik_tea::runtime::Runtime::dispatch, &run, msg);
            dispatch_failures.push(result.err().map(|e| failure_kind(&e, &ctx)));
        }
        for _ in 0..5 {
            if agent.is_settled(run.get_state().unwrap().as_ref())
                || !matches!(
                    input.scenario,
                    Scenario::RetryOnce | Scenario::RetryExhaust | Scenario::Deadline
                )
            {
                break;
            }
            if !timer.fire_next() {
                break;
            }
            ctx.deadlined.notified().await;
            let _ = observe_async!(&ctx, demlik_tea::runtime::Runtime::idle, &run);
        }
        final_state = run.get_state();
        if agent.is_settled(final_state.as_ref().unwrap().as_ref()) {
            let done = observe_async!(&ctx, demlik_tea::runtime::Runtime::done, &run).unwrap();
            let result = observe!(&ctx, demlik_tea::runtime::Runtime::result, &run).unwrap();
            done_same = Some(
                std::sync::Arc::ptr_eq(&done, &result)
                    && std::sync::Arc::ptr_eq(&done, final_state.as_ref().unwrap()),
            );
        }
        observe_async!(&ctx, demlik_tea::runtime::Runtime::stop, &run);
        if round == 0
            && matches!(
                input.scenario,
                Scenario::RestartBrain
                    | Scenario::RestartTool
                    | Scenario::RestartToolIoError
                    | Scenario::TerminalBoot
            )
        {
            ctx.log("restart");
        }
    }
    let state = final_state.unwrap();
    let view = state_view(&state, &ctx);
    let requests = ctx.requests.borrow();
    let request_reused = if matches!(input.scenario, Scenario::RetryOnce | Scenario::RetryExhaust) {
        Some(requests.len() > 1 && Rc::ptr_eq(&requests[0], &requests[1]))
    } else {
        None
    };
    drop(requests);
    let out = json!({"id":input.id,"view":{"state":view,"savedSame":Rc::ptr_eq(state.as_ref(),saved.borrow().as_ref().unwrap()),"modelCalls":ctx.model_calls.get(),"toolCalls":ctx.tool_calls.get(),"schemaSame":ctx.schema_same.get(),"requestReused":request_reused,"dispatchFailures":dispatch_failures,"doneSame":done_same,"restart":restart_observation,"trace":ctx.trace.borrow().clone(),"timers":timer.events.borrow().clone(),"reports":reports.borrow().clone(),"ownership":{"parsedOriginal":ctx.parsed_original.get(),"callOriginal":ctx.call_original.get(),"argsOriginal":ctx.args_original.get(),"viewsRetained":ctx.views_retained.get(),"recordsOriginal":ctx.records_original.get(),"firstWins":ctx.first_wins.get()},"rawTurns":ctx.raw_turns.borrow().clone(),"usageReadings":ctx.usage_readings.borrow().clone(),"codecs":ctx.codecs.borrow().clone(),"selections":ctx.selections.borrow().clone()},"calls":ctx.calls.borrow().clone(),"projectionFailure":projection_failure,"guardDiagnostics":ctx.guard_errors.borrow().iter().map(|e|json!({"name":e.name(),"message":e.message(),"value":wire(&JsonData(e.value()))})).collect::<Vec<_>>()});
    std::fs::remove_dir_all(path).unwrap();
    out
}
