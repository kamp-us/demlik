use demlik_tea::{
    PlainData, Tagged,
    agent::{
        Agent, AgentConfig, AgentError, AgentMachineError, AgentMachineMsg, AgentWorkError,
        StateOf,
        model::{Llm, MessageLoader, Messages, ModelFactory},
        tool::{self, ErrorFamily, Raised, ToolContext, ToolDef, ToolSignature, ToolSpec},
        types::{AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    command::{Issue, Outcome, SchemaError},
    data::{JsText, JsonData, stringify_json},
    file_store::{FileStoreError, file_store},
    llm_call::{self, LlmCall, Request, Schema},
    ports::{Port, define_port},
    resilience::resilient_call::CallValue,
    runtime::{self, ErrorPhase, Options, Profile, RuntimeError},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    convert::Infallible,
    fmt,
    io::{self, BufRead},
    ops::AsyncFn,
    path::PathBuf,
    rc::Rc,
};
use tokio::sync::Notify;
macro_rules! observe {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));value}};}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    profile: String,
    scenario: String,
    directory: PathBuf,
    mode: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
enum Never {}
struct TurnSchema;
type Turn = AgentTurn<PlainData>;
impl Schema for TurnSchema {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = Never;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<Never>> {
        Ok(value)
    }
}
struct Declared {
    fields: PlainData,
    token: Rc<Cell<u32>>,
}
impl Tagged for Declared {
    fn tag(&self) -> &str {
        "denied"
    }
}
impl Serialize for Declared {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.fields.serialize(s)
    }
}
struct Thrown(Rc<Cell<u32>>);
struct InputSchema;
impl Schema for InputSchema {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = SchemaError;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        if matches!(value.as_ref(),PlainData::Object(fields) if matches!(fields.get("invoice"),Some(PlainData::String(v))if v.as_utf8()==Some("inv-17")))
        {
            Ok(value)
        } else {
            Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "",
                "Invalid invoice args",
            )])))
        }
    }
}
struct OutputSchema {
    reject: bool,
}
impl Schema for OutputSchema {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = SchemaError;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        if !self.reject
            && matches!(value.as_ref(),PlainData::Object(f)if matches!(f.get("total"),Some(PlainData::Number(n))if *n>=0.))
        {
            Ok(value)
        } else {
            Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "",
                "Invalid invoice result",
            )])))
        }
    }
}
struct Host(Rc<Context>);
type Def = ToolDef<
    'static,
    PlainData,
    PlainData,
    PlainData,
    InputSchema,
    OutputSchema,
    Declared,
    Thrown,
    Host,
    Infallible,
>;
type Sig = ToolSignature<PlainData, Rc<PlainData>, PlainData, Declared, Thrown>;
demlik_tea::tool_router! {mod invoices{Read(read),Check(check)}}
type Results = invoices::Results<Sig, Sig>;
type Errors = invoices::Errors<Sig, Sig>;
// This boundary accepts pending-only checkpoints and refuses any settled union value.
impl<'de> Deserialize<'de> for Results {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let _ = serde::de::IgnoredAny::deserialize(d)?;
        Err(serde::de::Error::custom("pending-only routed result"))
    }
}
impl<'de> Deserialize<'de> for Errors {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let _ = serde::de::IgnoredAny::deserialize(d)?;
        Err(serde::de::Error::custom("pending-only routed failure"))
    }
}
#[derive(Serialize, Deserialize)]
struct Payload {
    conversation: Rc<Conversation<Results, Turn, Errors, PlainData>>,
}
type State = StateOf<JsText, JsText, Payload, TurnSchema, Results, Errors, PlainData, Turn>;
type ToolCommands = invoices::Commands<Def, Def>;
type HostMsg = AgentMachineMsg<JsText, Payload, Rc<Turn>, Never, invoices::Messages<Sig, Sig>>;
type Knob = Agent<
    'static,
    JsText,
    JsText,
    Payload,
    TurnSchema,
    Results,
    Errors,
    PlainData,
    Turn,
    PlainData,
    ToolCommands,
>;
struct Message(Rc<Request<JsText, Payload>>);
struct Context {
    input: Input,
    now: Cell<f64>,
    models: Cell<usize>,
    tools: Cell<usize>,
    maps: Cell<usize>,
    cut: Cell<bool>,
    returned: RefCell<Vec<Rc<PlainData>>>,
    ownership_checks: Cell<usize>,
    trace: RefCell<Vec<Value>>,
    ports: RefCell<Vec<Value>>,
    commits: RefCell<Vec<Value>>,
    saves: RefCell<Vec<Value>>,
    reports: RefCell<Vec<Value>>,
    diagnostics: RefCell<Vec<Value>>,
    rejections: RefCell<Vec<Value>>,
    calls: RefCell<Vec<&'static str>>,
    owners: RefCell<HashMap<JsText, Rc<ToolCall<PlainData>>>>,
    schema: Rc<TurnSchema>,
    port: Port<Value>,
    entered: Notify,
    release: Notify,
    map_cause: Rc<tool::ToolError>,
    crash: Rc<Cell<u32>>,
    declared: Rc<Declared>,
    thrown: Rc<Thrown>,
}
fn data(value: Value) -> PlainData {
    serde_json::from_str(&value.to_string()).unwrap()
}
fn view<T: Serialize + ?Sized>(value: &T) -> Value {
    serde_json::to_value(JsonData(&demlik_tea::data::plain_data(value).unwrap())).unwrap()
}
fn make_tool(ctx: Rc<Context>, group: &'static str, name: &'static str) -> Rc<Def> {
    let reject = ctx.input.scenario == "selected-B" && group == "A" && name == "read";
    tool::tool(format!("{name}_invoice"),ToolSpec::new(Rc::new(InputSchema),Rc::new(OutputSchema{reject}),ErrorFamily::new(["denied"],|e:&Declared|Ok(e.fields.clone()))).raised::<Thrown>(),
  move|args:&Rc<PlainData>,host:ToolContext<'_,Host>|{
   let ctx=Rc::clone(&host.host.0);let args=Rc::clone(args);
   Box::pin(async move{
    ctx.tools.set(ctx.tools.get()+1);ctx.trace.borrow_mut().push(json!(["handler",group,name,"inv-17"]));
    let same=ctx.owners.borrow().get(&JsText::from(name)).is_some_and(|c|Rc::ptr_eq(&c.args,&args));
    host.emit(&ctx.port,&json!({"name":name,"inputSame":same})).unwrap();
    if name=="read"&&ctx.input.scenario=="cancel-late"{ctx.entered.notify_one();ctx.release.notified().await;ctx.trace.borrow_mut().push(json!(["released","read"]));}
    let invoice:Value=serde_json::from_str(&tokio::fs::read_to_string(ctx.input.directory.join("invoice.json")).await.unwrap()).unwrap();
    let sum=invoice["lines"].as_array().unwrap().iter().map(|n|n.as_f64().unwrap()).sum::<f64>();assert_eq!(sum,invoice["total"].as_f64().unwrap());
    ctx.now.set(if name=="read"{20.5}else{25.75});
    if name=="read"&&ctx.input.scenario=="declared"{return Ok(Outcome::err(Rc::clone(&ctx.declared)))}
    if name=="read"&&ctx.input.scenario=="thrown"{return Err(Raised::Error{message:"invoice unavailable".into(),cause:Rc::clone(&ctx.thrown)})}
    let value=Rc::new(data(json!({"total":if name=="read"&&ctx.input.scenario=="bad-result"{-1.}else{sum}})));ctx.returned.borrow_mut().push(Rc::clone(&value));Ok(Outcome::ok(value))
   })
  }).unwrap()
}
struct Factory(Rc<Context>);
struct Model(Rc<Context>);
impl ModelFactory<Message, TurnSchema> for Factory {
    fn model_of(
        &self,
        _: Option<&JsText>,
    ) -> Result<impl Llm<Message, TurnSchema>, CallValue<Never>> {
        Ok(Model(Rc::clone(&self.0)))
    }
}
impl Llm<Message, TurnSchema> for Model {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a TurnSchema,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, Message>) -> Result<Rc<Turn>, CallValue<Never>> + 'a,
        CallValue<Never>,
    > {
        assert!(std::ptr::eq(schema, self.0.schema.as_ref()));
        Ok(async move |messages: Messages<'_, Message>| {
            let call = &messages.as_ref()[0].0;
            let rows = &call.payload.conversation.tool_records;
            let n = rows.len();
            self.0.models.set(self.0.models.get() + 1);
            self.0.trace.borrow_mut().push(json!(["model", n]));
            let calls = if n < 2 {
                let id = if n == 0 { "read" } else { "check" };
                let name = if id == "read" && self.0.input.scenario == "rejected" {
                    "missing_tool".to_owned()
                } else {
                    format!("{id}_invoice")
                };
                let args = Rc::new(data(
                    if id == "read" && self.0.input.scenario == "malformed-args" {
                        json!({"invoice":0})
                    } else {
                        json!({"invoice":"inv-17","extra":"kept"})
                    },
                ));
                let c = Rc::new(ToolCall {
                    call_id: id.into(),
                    name: name.into(),
                    args,
                });
                self.0.owners.borrow_mut().insert(id.into(), Rc::clone(&c));
                vec![c]
            } else {
                self.0.now.set(30.125);
                vec![]
            };
            let content = if n == 0 {
                "collect"
            } else if n == 1 {
                "check"
            } else if rows
                .iter()
                .any(|r| matches!(r.outcome.as_ref(), ToolOutcome::Error(_)))
            {
                "Invoice requires review"
            } else {
                "Invoice total confirmed: 15"
            };
            schema.parse(Rc::new(Turn::new(content.into(), calls)))
        })
    }
}
struct Loader(Rc<Context>);
impl MessageLoader<JsText, Payload, Message, Never> for Loader {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload>>,
    ) -> Result<Messages<'a, Message>, CallValue<Never>>
    where
        Message: 'a,
    {
        self.0.trace.borrow_mut().push(json!([
            "load",
            call.payload.conversation.tool_records.len()
        ]));
        Ok(Messages::Shared(Rc::new(vec![Message(Rc::clone(call))])))
    }
}
#[derive(Debug)]
enum SaveError {
    File(FileStoreError),
    Crash(Rc<Cell<u32>>),
}
impl fmt::Display for SaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::File(e) => e.fmt(f),
            Self::Crash(_) => f.write_str("persisted-before-tool"),
        }
    }
}
impl std::error::Error for SaveError {}
enum Raw {
    Memory(Option<Rc<State>>),
    File(PlainData),
}
struct Saved {
    ctx: Rc<Context>,
    memory: Rc<RefCell<Option<Rc<State>>>>,
    loaded: Rc<RefCell<Option<Rc<State>>>>,
}
fn decode_pending(raw: PlainData) -> Migrated<Rc<State>> {
    if matches!(raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    let text = stringify_json(&raw).unwrap();
    let json: Value = serde_json::from_str(&text).unwrap();
    if !json["tools"]["done"].as_array().is_some_and(Vec::is_empty)
        || !json["tools"]["failed"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || !json["conversation"]["toolRecords"]
            .as_array()
            .is_some_and(Vec::is_empty)
    {
        return Migrated::Refused(demlik_tea::storage::refuse(
            "pending-only routed checkpoint",
        ));
    }
    match serde_json::from_str::<State>(&text) {
        Ok(state) => Migrated::State(Rc::new(state)),
        Err(e) => Migrated::Refused(demlik_tea::storage::refuse(e.to_string())),
    }
}
impl Store<Rc<State>> for Saved {
    type Raw = Raw;
    type Error = SaveError;
    async fn load(&self) -> Result<Raw, SaveError> {
        if self.ctx.input.scenario == "cold-pending" {
            file_store(self.ctx.input.directory.join("state.json"), decode_pending)
                .load()
                .await
                .map(Raw::File)
                .map_err(SaveError::File)
        } else {
            Ok(Raw::Memory(self.memory.borrow().clone()))
        }
    }
    async fn save(&self, state: &Rc<State>) -> Result<(), SaveError> {
        self.ctx.saves.borrow_mut().push(json!({"phase":state.run.phase.as_str(),"awaiting":state.conversation.as_ref().map(|c|view(&c.awaiting)),"records":state.conversation.as_ref().map(|c|view(&c.tool_records)).unwrap_or_else(||json!([]))}));
        if self.ctx.input.scenario == "cold-pending" {
            file_store(self.ctx.input.directory.join("state.json"), decode_pending)
                .save(state)
                .await
                .map_err(SaveError::File)?
        } else {
            self.memory.replace(Some(Rc::clone(state)));
        }
        if self.ctx.input.mode.as_deref() == Some("writer")
            && !self.ctx.cut.get()
            && !state.tools.running.is_empty()
        {
            self.ctx.cut.set(true);
            return Err(SaveError::Crash(Rc::clone(&self.ctx.crash)));
        }
        Ok(())
    }
    fn migrate(&self, raw: Raw) -> Migrated<Rc<State>> {
        let decoded = match raw {
            Raw::Memory(x) => x.map_or(Migrated::Fresh, Migrated::State),
            Raw::File(x) => decode_pending(x),
        };
        if let Migrated::State(state) = &decoded {
            self.loaded.replace(Some(Rc::clone(state)));
            for call in &state.tools.running {
                self.ctx
                    .owners
                    .borrow_mut()
                    .insert(call.call_id.clone(), Rc::clone(call));
            }
        }
        decoded
    }
}
fn message_view(message: &HostMsg) -> Value {
    match message {
        AgentMachineMsg::Start { run_id, at } => {
            json!({"type":"agent_start","runId":run_id,"at":at})
        }
        AgentMachineMsg::Tool(message) => view(message),
        AgentMachineMsg::Brain(message) => view(message),
        AgentMachineMsg::Boot { at } => json!({"type":"agent_boot","at":at}),
        AgentMachineMsg::Cancel { at } => json!({"type":"agent_cancel","at":at}),
        AgentMachineMsg::Deadline(message) => view(message),
        AgentMachineMsg::Compact(message) => match *message {},
    }
}
fn ownership(message: &HostMsg, state: &Rc<State>, ctx: &Context) {
    use demlik_tea::command::{Failure, Settlement};
    let AgentMachineMsg::Tool(tool) = message else {
        return;
    };
    let (invoices::Messages::Read(message) | invoices::Messages::Check(message)) = tool else {
        return;
    };
    let call = ctx.owners.borrow();
    let expected = call
        .get(&message.cmd().input().call_id)
        .expect("tracked actual call");
    assert!(
        Rc::ptr_eq(&expected.args, &message.cmd().input().args),
        "runtime-original-tool-input"
    );
    ctx.ownership_checks.set(ctx.ownership_checks.get() + 1);
    if let Settlement::Ok(value) = message.outcome() {
        assert!(
            ctx.returned
                .borrow()
                .iter()
                .any(|original| Rc::ptr_eq(original, value)),
            "runtime-original-output"
        );
        if ctx.input.scenario != "cancel-late" {
            let record = state
                .conversation
                .as_ref()
                .unwrap()
                .tool_records
                .iter()
                .find(|record| record.call.call_id == message.cmd().input().call_id)
                .unwrap();
            let ToolOutcome::Ok(result) = record.outcome.as_ref() else {
                panic!("typed success lost")
            };
            let (invoices::Results::Read(retained) | invoices::Results::Check(retained)) =
                result.as_ref()
            else {
                panic!("result family lost")
            };
            assert!(Rc::ptr_eq(retained, value), "reader-keeps-original-output");
        }
    }
    if message.cmd().input().call_id.as_utf8() == Some("read") && ctx.input.scenario == "declared" {
        let Settlement::Err(Failure::Declared(tool::ToolFailure::Declared(error))) =
            message.outcome()
        else {
            panic!("declared result was reconstructed")
        };
        assert!(Rc::ptr_eq(error, &ctx.declared));
        assert_eq!(error.token.get(), 1);
        let record = state
            .conversation
            .as_ref()
            .unwrap()
            .tool_records
            .iter()
            .find(|r| r.call.call_id.as_utf8() == Some("read"))
            .unwrap();
        let ToolOutcome::Error(error) = record.outcome.as_ref() else {
            panic!("business error lost")
        };
        let invoices::Errors::Read(view) = error.as_ref() else {
            panic!("business family lost")
        };
        let Failure::Declared(tool::ToolFailure::Declared(error)) = &view.error else {
            panic!("business cause lost")
        };
        assert!(
            Rc::ptr_eq(error, &ctx.declared),
            "reader-keeps-original-business-cause"
        );
    }
    if message.cmd().input().call_id.as_utf8() == Some("read") && ctx.input.scenario == "thrown" {
        let Settlement::Err(Failure::Declared(tool::ToolFailure::Thrown {
            cause: tool::ThrownCause::Error(error),
            ..
        })) = message.outcome()
        else {
            panic!("thrown cause lost")
        };
        assert!(Rc::ptr_eq(error, &ctx.thrown));
        assert_eq!(error.0.get(), 2);
    }
}
fn report(
    error: &RuntimeError<SaveError, AgentWorkError<tool::ToolError>, AgentMachineError>,
    phase: ErrorPhase,
    ctx: &Context,
) {
    let map_same = matches!(error,RuntimeError::Reduce(AgentMachineError::Agent(AgentError::ToolMapping(e)))if Rc::ptr_eq(e,&ctx.map_cause));
    let save_same =
        matches!(error,RuntimeError::Save(SaveError::Crash(e))if Rc::ptr_eq(e,&ctx.crash));
    let phase = serde_json::to_value(phase).unwrap();
    ctx.reports
        .borrow_mut()
        .push(json!({"phase":phase,"mapCauseSame":map_same,"saveCauseSame":save_same}));
    ctx.diagnostics
        .borrow_mut()
        .push(json!({"phase":phase,"error":{"name":error.name(),"message":error.to_string()}}));
}
async fn execute(input: Input, port: Port<Value>) -> Value {
    std::fs::create_dir_all(&input.directory).unwrap();
    if input.mode.as_deref() != Some("reader") {
        std::fs::write(
            input.directory.join("invoice.json"),
            json!({"lines":[4.5,10.5],"total":15}).to_string(),
        )
        .unwrap();
    }
    let ctx = Rc::new(Context {
        now: Cell::new(if input.mode.as_deref() == Some("reader") {
            50.
        } else {
            17.25
        }),
        input: input.clone(),
        models: Cell::new(0),
        tools: Cell::new(0),
        maps: Cell::new(0),
        cut: Cell::new(false),
        returned: RefCell::new(vec![]),
        ownership_checks: Cell::new(0),
        trace: RefCell::default(),
        ports: RefCell::default(),
        commits: RefCell::default(),
        saves: RefCell::default(),
        reports: RefCell::default(),
        diagnostics: RefCell::default(),
        rejections: RefCell::default(),
        calls: RefCell::default(),
        owners: RefCell::default(),
        schema: Rc::new(TurnSchema),
        port,
        entered: Notify::new(),
        release: Notify::new(),
        map_cause: Rc::new(tool::ToolError::Reserved {
            name: "map_fault".into(),
        }),
        crash: Rc::new(Cell::new(0)),
        declared: Rc::new(Declared {
            fields: data(
                json!({"_tag":"denied","invoice":"inv-17","kind":"payload","reason":"payload"}),
            ),
            token: Rc::new(Cell::new(1)),
        }),
        thrown: Rc::new(Thrown(Rc::new(Cell::new(2)))),
    });
    let origin = Rc::new(
        invoices::Router::new(
            make_tool(Rc::clone(&ctx), "A", "read"),
            make_tool(Rc::clone(&ctx), "A", "check"),
        )
        .unwrap(),
    );
    let selected = if input.scenario == "selected-B" {
        Rc::new(
            invoices::Router::new(
                make_tool(Rc::clone(&ctx), "B", "read"),
                make_tool(Rc::clone(&ctx), "B", "check"),
            )
            .unwrap(),
        )
    } else {
        Rc::clone(&origin)
    };
    let schema = Rc::clone(&ctx.schema);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
        |e: &Never| match *e {},
    ));
    let mapper = Rc::clone(&ctx);
    let route = Rc::clone(&origin);
    let agent: Rc<Knob> = Rc::new(observe!(
        &ctx,
        demlik_tea::agent::create_agent,
        AgentConfig::try_new(
            llm,
            vec![Rc::new(JsText::from("invoice"))],
            |_| "invoice".into(),
            move |call| {
                mapper.maps.set(mapper.maps.get() + 1);
                mapper
                    .trace
                    .borrow_mut()
                    .push(json!(["map", call.call_id, call.name]));
                if mapper.input.scenario == "map-refusal" && mapper.maps.get() == 2 {
                    return Err(Rc::clone(&mapper.map_cause));
                }
                route.tool_of(call).map_err(Rc::new)
            },
            |_, conversation, _| Payload {
                conversation: Rc::clone(conversation)
            },
            |turn| turn
        )
    ));
    let host = Rc::new(Host(Rc::clone(&ctx)));
    let binding = observe!(
        &ctx,
        invoices::Router::for_agent,
        Rc::clone(&selected),
        host
    );
    let timer_clock = Rc::clone(&ctx);
    let timer = Rc::new(TokioTimer::with_clock(
        move || timer_clock.now.get(),
        |_| panic!("unexpected deadline"),
    ));
    let wired = observe!(
        &ctx,
        demlik_tea::agent::Agent::to_machine_with_tools,
        Rc::clone(&agent),
        Factory(Rc::clone(&ctx)),
        Loader(Rc::clone(&ctx)),
        binding,
        timer
    );
    let loaded = Rc::new(RefCell::new(None));
    let mut options = Options::new(if input.profile == "effect" {
        Profile::Effect
    } else {
        Profile::Promise
    });
    let clock = Rc::clone(&ctx);
    options.clock = Rc::new(move || clock.now.get());
    options.store = Some(runtime::Persistence::new(Saved {
        ctx: Rc::clone(&ctx),
        memory: Rc::new(RefCell::new(None)),
        loaded: Rc::clone(&loaded),
    }));
    options.terminal = Some(Rc::new(|state: &Rc<State>| state.is_settled()));
    let reporting = Rc::clone(&ctx);
    options.on_error = Some(Rc::new(move |e, phase| report(e, phase, &reporting)));
    let run = observe!(
        &ctx,
        demlik_tea::runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        options
    );
    run.ready().await.unwrap();
    let observer = Rc::clone(&ctx);
    let _observe = run.observe(move |message: &HostMsg, state: &Rc<State>| {
        ownership(message, state, &observer);
        observer
            .commits
            .borrow_mut()
            .push(json!({"tag":message.tag(),"message":message_view(message),"state":view(state)}));
    });
    let observer = Rc::clone(&ctx);
    let _ports = run.subscribe_port(
        &ctx.port,
        Rc::new(move |value| {
            observer.ports.borrow_mut().push(value.clone());
            observer.trace.borrow_mut().push(json!(["port", value]));
        }),
    );
    let ready = view(run.get_state().unwrap().as_ref());
    let ready_calls = json!({"model":ctx.models.get(),"tools":ctx.tools.get()});
    let loaded_identity=loaded.borrow().as_ref().map_or(json!({"status":"not-applicable","same":null}),|value|json!({"status":"tracked","same":Rc::ptr_eq(value,run.get_state().unwrap().as_ref())}));
    let start = if input.mode.as_deref() == Some("reader") {
        AgentMachineMsg::boot(ctx.now.get())
    } else {
        AgentMachineMsg::Start {
            run_id: "invoice-routed".into(),
            at: ctx.now.get(),
        }
    };
    let first;
    if input.scenario == "cancel-late" {
        let control = async {
            ctx.entered.notified().await;
            ctx.now.set(19.5);
            let mut cancelled = Box::pin(run.dispatch(AgentMachineMsg::cancel(ctx.now.get())));
            assert!(futures::poll!(cancelled.as_mut()).is_pending());
            ctx.release.notify_one();
            cancelled.await
        };
        let (a, b) = tokio::join!(run.dispatch(start), control);
        first = a;
        if let Err(e) = b {
            ctx.rejections
                .borrow_mut()
                .push(json!({"name":e.name(),"message":e.to_string()}));
        }
    } else {
        first = run.dispatch(start).await;
    }
    if let Err(e) = first {
        ctx.rejections
            .borrow_mut()
            .push(json!({"name":e.name(),"message":e.to_string()}));
    }
    run.idle().await.unwrap();
    let final_state = view(run.get_state().unwrap().as_ref());
    let checkpoint = if input.scenario == "cold-pending" {
        Some(std::fs::read_to_string(input.directory.join("state.json")).unwrap())
    } else {
        None
    };
    if input.mode.as_deref() != Some("writer") {
        run.stop().await;
    }
    json!({"id":input.id,"ok":true,"view":{"ready":ready,"readyCalls":ready_calls,"loadedIdentity":loaded_identity,"final":final_state,"commits":*ctx.commits.borrow(),"trace":*ctx.trace.borrow(),"ports":*ctx.ports.borrow(),"saves":*ctx.saves.borrow(),"modelCalls":ctx.models.get(),"toolCalls":ctx.tools.get(),"maps":ctx.maps.get(),"reports":*ctx.reports.borrow(),"diagnostics":*ctx.diagnostics.borrow(),"rejections":*ctx.rejections.borrow(),"checkpoint":checkpoint,"stopInvoked":input.mode.as_deref()!=Some("writer"),"returnedCount":ctx.returned.borrow().len()},"observedCalls":*ctx.calls.borrow(),"nativeOwnershipChecks":ctx.ownership_checks.get()})
}
fn main() {
    let port = define_port("agent-routed-invoice-01a16c9d").unwrap();
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        for line in io::stdin().lock().lines() {
            let input: Input = serde_json::from_str(&line.unwrap()).unwrap();
            println!("{}", execute(input, port.clone()).await);
        }
    })
}
