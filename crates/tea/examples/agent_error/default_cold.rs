//! Default GuardedSchema, real JSON files and explicitly resumed invoice work.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, GuardedSchema, PlainCalls,
        PlainToolCall, StateOf, StructuredOutputError, create_agent,
        model::{Messages, NoMessages, plain_model},
        types::{AGENT_TURN_SCHEMA, AgentFailure, AgentField, Awaiting},
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, decode_json, stringify_json},
    file_store::{FileStore, FileStoreError},
    llm_call::{self, LlmCall, LlmCause},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile},
    storage::{Migrated, Store, refuse},
    timing::TokioTimer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, Read},
    path::PathBuf,
    rc::{Rc, Weak},
};
macro_rules! observe {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));value}};}
macro_rules! observe_async {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*).await;$ctx.calls.borrow_mut().push(stringify!($f));value}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    profile: String,
    mode: String,
    checkpoint: String,
    directory: PathBuf,
}
type State = StateOf<
    JsText,
    JsText,
    PlainData,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
>;
type Msg = AgentMachineMsg<
    JsText,
    PlainData,
    Rc<PlainData>,
    StructuredOutputError,
    AgentToolMsg<PlainData>,
>;
struct Context {
    input: Input,
    models: Cell<usize>,
    tools: Cell<usize>,
    calls: RefCell<Vec<&'static str>>,
    loaded: RefCell<Option<Weak<State>>>,
    decoded: RefCell<Option<Weak<PlainToolCall>>>,
    command_same: Cell<Option<bool>>,
    record_same: Cell<Option<bool>>,
    cut: Cell<bool>,
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
    fn settle(self, out: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(out)
    }
}
struct Tools(Rc<Context>);
impl Interpreter<Tool, Msg> for Tools {
    type Error = AgentWorkError<std::io::Error>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<PlainData>>, Self::Error>> {
        Some(CommandWork::new(async move {
            if let Some(original) = self.0.decoded.borrow().as_ref().and_then(Weak::upgrade) {
                self.0.command_same.set(Some(Rc::ptr_eq(&cmd.0, &original)));
            }
            let PlainData::Object(args) = cmd.0.args() else {
                panic!("invoice args")
            };
            let PlainData::String(path) = &args["path"] else {
                panic!("invoice path")
            };
            let text = tokio::fs::read_to_string(path.as_utf8().unwrap())
                .await
                .map_err(AgentWorkError::Tool)?;
            let invoice: Value = serde_json::from_str(&text).expect("real invoice JSON");
            let total = invoice["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .sum::<f64>();
            assert_eq!(
                total,
                invoice["total"].as_f64().unwrap(),
                "real invoice validator"
            );
            self.0.tools.set(self.0.tools.get() + 1);
            Ok(vec![AgentToolMsg::Ok {
                call_id: cmd.0.call_id().clone(),
                result: Rc::new(PlainData::Number(total)),
                at: 17.25,
            }])
        }))
    }
}
#[derive(Debug)]
enum SaveError {
    Cut,
    File(FileStoreError),
}
impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cut => f.write_str("persisted-before-effect"),
            Self::File(e) => e.fmt(f),
        }
    }
}
fn decode(raw: PlainData) -> Migrated<Rc<State>> {
    if matches!(raw, PlainData::Null) {
        return Migrated::Fresh;
    }
    match serde_json::from_str(&stringify_json(&raw).unwrap()) {
        Ok(state) => Migrated::State(Rc::new(state)),
        Err(e) => Migrated::Refused(refuse(format!("default invoice checkpoint:{e}"))),
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
    async fn save(&self, state: &Rc<State>) -> Result<(), SaveError> {
        observe_async!(
            &self.ctx,
            demlik_tea::storage::Store::save,
            &self.base,
            state
        )
        .map_err(SaveError::File)?;
        let target = self.ctx.input.mode == "writer"
            && match self.ctx.input.checkpoint.as_str() {
                "brain" => {
                    state
                        .conversation
                        .as_ref()
                        .is_some_and(|c| matches!(c.awaiting, Awaiting::Llm))
                        && self.ctx.models.get() == 0
                }
                "tools" => !state.tools.running.is_empty(),
                "guard-error" => false,
                _ => panic!("checkpoint"),
            };
        if target && !self.ctx.cut.replace(true) {
            return Err(SaveError::Cut);
        }
        Ok(())
    }
    fn migrate(&self, raw: PlainData) -> Migrated<Rc<State>> {
        let value = observe!(
            &self.ctx,
            demlik_tea::storage::Store::migrate,
            &self.base,
            raw
        );
        if let Migrated::State(s) = &value {
            self.ctx.loaded.replace(Some(Rc::downgrade(s)));
        }
        value
    }
}
fn cause(state: &State) -> Value {
    let AgentField::Value(Some(failure)) = &state.failure else {
        return Value::Null;
    };
    let AgentFailure::Llm {
        error: AgentField::Value(error),
        ..
    } = failure.as_ref()
    else {
        return Value::Null;
    };
    let LlmCause::Value(value) = &error.error else {
        panic!("actual guard cause")
    };
    let (kind, rejected) = match value.as_ref() {
        StructuredOutputError::Live(e) => {
            ("live", Some(matches!(e.value().as_ref(), PlainData::Null)))
        }
        StructuredOutputError::Plain(_) => ("plain", None),
    };
    json!({"kind":kind,"description":value.describe().unwrap(),"reason":error.reason,"nativeRejectedNull":rejected})
}
async fn execute(input: Input) -> Value {
    assert!(matches!(input.mode.as_str(), "writer" | "reader"));
    assert!(matches!(
        input.checkpoint.as_str(),
        "brain" | "tools" | "guard-error"
    ));
    let ctx = Rc::new(Context {
        input,
        models: Cell::new(0),
        tools: Cell::new(0),
        calls: RefCell::new(vec![]),
        loaded: RefCell::new(None),
        decoded: RefCell::new(None),
        command_same: Cell::new(None),
        record_same: Cell::new(None),
        cut: Cell::new(false),
    });
    let invoice = ctx.input.directory.join("invoice.json");
    if ctx.input.mode == "writer" {
        std::fs::write(&invoice, r#"{"lines":[7,8],"total":15}"#).unwrap();
    }
    let model_ctx = Rc::clone(&ctx);
    let model = plain_model(async move |_: Messages<'_, ()>| {
        let ordinal = model_ctx.models.get();
        model_ctx.models.set(ordinal + 1);
        let value = if model_ctx.input.checkpoint == "guard-error" {
            PlainData::Null
        } else if ordinal == 0
            && !(model_ctx.input.mode == "reader" && model_ctx.input.checkpoint == "tools")
        {
            decode_json(&format!(r#"{{"content":"collect/check","toolCalls":[{{"callId":"invoice-1","name":"collect","args":{{"path":{},"unknownArg":"kept"}},"unknownCall":{{"kept":true}}}}],"unknownTurn":"kept","provider":{{"opaque":true}}}}"#,serde_json::to_string(&model_ctx.input.directory.join("invoice.json")).unwrap())).unwrap()
        } else {
            decode_json(
                r#"{"content":"Invoice total confirmed: 15","toolCalls":[],"unknownFinal":"kept"}"#,
            )
            .unwrap()
        };
        Ok(Rc::new(value))
    });
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let selected = Rc::clone(&schema);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&selected)),
        StructuredOutputError::describe,
    ));
    let agent = Rc::new(create_agent(AgentConfig::from_plain_turns(
        llm,
        vec![Rc::<JsText>::new("invoice".into())],
        |s| s.unwrap().as_ref().clone(),
        |call| Tool(Rc::clone(call)),
        |_, _, _| PlainData::Null,
    )));
    let wired = observe!(
        &ctx,
        demlik_tea::agent::Agent::to_machine,
        Rc::clone(&agent),
        model,
        NoMessages,
        Tools(Rc::clone(&ctx)),
        Rc::new(TokioTimer::with_clock(|| 17.25, |_| {}))
    );
    let base = observe!(
        &ctx,
        demlik_tea::file_store::file_store,
        ctx.input.directory.join("state.json"),
        decode as fn(PlainData) -> Migrated<Rc<State>>
    );
    let profile = match ctx.input.profile.as_str() {
        "promise" => Profile::Promise,
        "effect" => Profile::Effect,
        _ => panic!("profile"),
    };
    let mut options = Options::new(profile);
    let at = if ctx.input.mode == "writer" {
        17.25
    } else {
        50.0
    };
    options.clock = Rc::new(move || at);
    options.store = Some(runtime::Persistence::new(Saved {
        base,
        ctx: Rc::clone(&ctx),
    }));
    options.terminal = Some(Rc::new(|s: &Rc<State>| s.is_settled()));
    let records = Rc::clone(&ctx);
    options.on_commit.push(Rc::new(move |_, s| {
        if let Some(call) = records.decoded.borrow().as_ref().and_then(Weak::upgrade)
            && let Some(conv) = &s.conversation
        {
            for record in conv.tool_records.iter() {
                records
                    .record_same
                    .set(Some(Rc::ptr_eq(&record.call, &call)));
            }
        }
    }));
    let errors = Rc::new(RefCell::new(vec![]));
    let sink = Rc::clone(&errors);
    options.on_error = Some(Rc::new(move |e, p| {
        sink.borrow_mut().push(json!([e.name(), format!("{p:?}")]))
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
    let loaded_same = ctx
        .loaded
        .borrow()
        .as_ref()
        .and_then(Weak::upgrade)
        .map(|s| Rc::ptr_eq(&s, ready.as_ref()));
    let ready_view = json!({"modelCalls":ctx.models.get(),"toolCalls":ctx.tools.get(),"loadedSame":loaded_same,"wire":ready.as_ref(),"cause":cause(&ready)});
    if let Some(call) = ready.tools.running.first() {
        ctx.decoded.replace(Some(Rc::downgrade(call)));
    }
    let msg = if ctx.input.mode == "writer" {
        AgentMachineMsg::Start {
            run_id: "default-invoice".into(),
            at: 0.0,
        }
    } else {
        observe!(&ctx, demlik_tea::agent::agent_boot_msg, 50.0)
    };
    let dispatch = observe_async!(&ctx, demlik_tea::runtime::Runtime::dispatch, &run, msg);
    let failure = dispatch.err().map(|e| e.name());
    let state = run.get_state().unwrap();
    if state.is_settled() {
        observe_async!(&ctx, demlik_tea::runtime::Runtime::done, &run).unwrap();
    }
    observe_async!(&ctx, demlik_tea::runtime::Runtime::stop, &run);
    let bytes = std::fs::read_to_string(ctx.input.directory.join("state.json")).unwrap();
    json!({"id":ctx.input.id,"view":{"ready":ready_view,"wire":serde_json::from_str::<Value>(&bytes).unwrap(),"modelCalls":ctx.models.get(),"toolCalls":ctx.tools.get(),"settled":state.is_settled(),"cause":cause(&state),"cut":ctx.cut.get(),"dispatchFailure":failure,"decodedCommandSame":ctx.command_same.get(),"decodedRecordSame":ctx.record_same.get(),"reports":errors.borrow().clone()},"wireText":bytes,"calls":ctx.calls.borrow().clone()})
}
pub fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).unwrap();
    let input: Input = serde_json::from_str(&text).expect("precise default JSON phase");
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let answer = tokio::task::LocalSet::new().block_on(&host, execute(input));
    println!("{answer}");
}
