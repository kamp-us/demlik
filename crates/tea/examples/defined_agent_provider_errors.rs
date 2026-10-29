//! Controlled provider failures through the public no-tool Agent and its real drive.
use demlik_tea::{
    PlainData,
    agent::{
        DefinedAgentRunOptions, DefinedAgentState,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::EmptyRouter,
        types::{AgentFailure, AgentField},
    },
    data::decode_json,
    llm_call::LlmCause,
    resilience::resilient_call::CallValue,
    runtime::DriveError,
    storage::{Migrated, Store},
};
use serde::Serialize;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};

macro_rules! called {
    ($trace:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let value = $function($($argument),*);
        $trace.borrow_mut().push(stringify!($function)); value
    }};
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Details {
    request_id: &'static str,
    retry: Retry,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Retry {
    after_ms: u32,
    attempts: Vec<u8>,
}
#[derive(Serialize)]
struct ProviderError {
    code: &'static str,
    status: u16,
    nested: Rc<Details>,
    #[serde(skip)]
    message: Option<&'static str>,
}
type Error<R = EmptyRouter> = DefinedAgentModelError<
    <R as demlik_tea::agent::DefinedAgentTools>::ContentError,
    Rc<ProviderError>,
>;
type State<R = EmptyRouter> = Rc<DefinedAgentState<R, Rc<ProviderError>>>;
struct RecordingStore<R: demlik_tea::agent::DefinedAgentTools>(Rc<RefCell<Vec<State<R>>>>);
impl<R: demlik_tea::agent::DefinedAgentTools> Store<State<R>> for RecordingStore<R> {
    type Raw = ();
    type Error = Infallible;
    async fn load(&self) -> Result<(), Infallible> {
        Ok(())
    }
    async fn save(&self, state: &State<R>) -> Result<(), Infallible> {
        self.0.borrow_mut().push(Rc::clone(state));
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<State<R>> {
        Migrated::Fresh
    }
}
async fn execute(id: &'static str) {
    let nested = Rc::new(Details {
        request_id: "request-17",
        retry: Retry {
            after_ms: 125,
            attempts: vec![1, 2],
        },
    });
    let provider = Rc::new(ProviderError {
        code: "provider_busy",
        status: 429,
        nested: Rc::clone(&nested),
        message: (id == "provider-error").then_some("Provider unavailable"),
    });
    let original = Rc::new(Error::<EmptyRouter>::Provider(Rc::clone(&provider)));
    let model_error = Rc::clone(&original);
    let saves = Rc::new(RefCell::new(Vec::new()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let calls = Rc::new(Cell::new(0));
    let capture = Rc::clone(&prompts);
    let model_calls = Rc::clone(&calls);
    let model = plain_model(async move |messages: Messages<'_, DefinedAgentMessage<EmptyRouter>>| -> Result<Rc<PlainData>, CallValue<Error>> {
        capture.borrow_mut().push(messages.as_ref().iter().map(|m| match m {
            DefinedAgentMessage::<EmptyRouter>::System(content) => json!({"role":"system","content":content}),
            DefinedAgentMessage::<EmptyRouter>::User(content) => json!({"role":"user","content":content}),
            _ => panic!("one no-tool call has no transcript"),
        }).collect::<Vec<_>>());
        model_calls.set(model_calls.get()+1);
        if id == "schema-guard" { Ok(Rc::new(decode_json(r#"{"content":17,"toolCalls":[]}"#).unwrap())) }
        else { Err(CallValue::Shared(Rc::clone(&model_error))) }
    });
    let trace = Rc::new(RefCell::new(Vec::new()));
    let config = called!(
        trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        Rc::new(EmptyRouter),
        "Keep provider failures."
    )
    .describe_provider_error(|error: &Rc<ProviderError>| {
        Ok(error.message.unwrap_or("[object Object]").into())
    });
    let agent = called!(trace, demlik_tea::agent::define_agent, config);
    let event_capture = Rc::clone(&events);
    let result = called!(
        trace,
        demlik_tea::agent::DefinedAgent::run,
        &agent,
        "Try once.",
        DefinedAgentRunOptions::new(Rc::new(()))
            .run_id("provider-run")
            .clock(|| 50.0)
            .store(RecordingStore(Rc::clone(&saves)))
            .on_event(move |e| event_capture
                .borrow_mut()
                .push(serde_json::to_value(e).unwrap()))
    )
    .await;
    let final_state = match result {
        Err(DriveError::Failed { state }) => Rc::clone(&state),
        Ok(_) => panic!("provider failure must reject"),
        Err(_) => panic!("unexpected drive failure channel"),
    };
    let saved = saves.borrow();
    assert!(Rc::ptr_eq(
        saved.last().expect("saved final state"),
        &final_state
    ));
    let AgentField::Value(Some(failure)) = &final_state.failure else {
        panic!("canonical agent failure")
    };
    let AgentFailure::Llm {
        error: AgentField::Value(error),
        ..
    } = failure.as_ref()
    else {
        panic!("llm failure")
    };
    let LlmCause::Value(cause) = &error.error else {
        panic!("typed original cause")
    };
    let classification = if id == "schema-guard" {
        assert!(matches!(cause.as_ref(), Error::<EmptyRouter>::Guard(_)));
        "Guard"
    } else {
        assert!(Rc::ptr_eq(cause, &original));
        let Error::<EmptyRouter>::Provider(actual) = cause.as_ref() else {
            panic!("provider variant")
        };
        assert!(Rc::ptr_eq(actual, &provider));
        assert!(Rc::ptr_eq(&actual.nested, &nested));
        "Provider"
    };
    println!(
        "{}",
        json!({"id":id,"phase":{"prompts":*prompts.borrow(),"events":*events.borrow(),"saves":*saved,"saveWires":saved.iter().map(|s|serde_json::to_string(s).unwrap()).collect::<Vec<_>>(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"calls":calls.get(),"contentCalls":0,"toolCalls":0,"outcome":"failed","ownership":{"finalSaved":true,"causeSame":id!="schema-guard","nestedSame":id!="schema-guard"},"failureClass":"DriveError::Failed","classification":classification,"nativeTrace":*trace.borrow()}})
    );
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, async {
        for id in ["provider-rich", "provider-error", "schema-guard"] {
            execute(id).await;
        }
        execute_content().await;
    });
}

demlik_tea::tool_router! { mod content_route { Read(read) } }
struct AnyArgs;
impl demlik_tea::llm_call::Schema for AnyArgs {
    type Raw = Rc<demlik_tea::agent::PlainToolArgs>;
    type Output = Rc<()>;
    type Error = demlik_tea::command::SchemaError;
    fn parse(&self, _: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(Rc::new(()))
    }
}
struct TextResult;
impl demlik_tea::llm_call::Schema for TextResult {
    type Raw = String;
    type Output = Rc<String>;
    type Error = demlik_tea::command::SchemaError;
    fn parse(&self, raw: String) -> Result<Rc<String>, CallValue<Self::Error>> {
        Ok(Rc::new(raw))
    }
}
enum NoErrors {}
impl demlik_tea::Tagged for NoErrors {
    fn tag(&self) -> &str {
        match *self {}
    }
}
type ReadTool = demlik_tea::agent::tool::ToolDef<
    'static,
    demlik_tea::agent::PlainToolArgs,
    (),
    String,
    AnyArgs,
    TextResult,
    NoErrors,
    PlainData,
    (),
    Rc<ProviderError>,
>;
async fn execute_content() {
    use demlik_tea::agent::tool::{self, ErrorFamily, ToolSpec};
    let nested = Rc::new(Details {
        request_id: "request-17",
        retry: Retry {
            after_ms: 125,
            attempts: vec![1, 2],
        },
    });
    let original = Rc::new(ProviderError {
        code: "provider_busy",
        status: 429,
        nested: Rc::clone(&nested),
        message: None,
    });
    let content_calls = Rc::new(Cell::new(0));
    let tool_calls = Rc::new(Cell::new(0));
    let content_owner = Rc::clone(&original);
    let content_capture = Rc::clone(&content_calls);
    let tool_capture = Rc::clone(&tool_calls);
    let spec = ToolSpec::new(
        Rc::new(AnyArgs),
        Rc::new(TextResult),
        ErrorFamily::new(std::iter::empty::<&str>(), |e: &NoErrors| match *e {}),
    )
    .try_content(move |_| {
        content_capture.set(content_capture.get() + 1);
        Err(Rc::clone(&content_owner))
    });
    let tool = tool::tool("read", spec, move |_, _: tool::ToolContext<'_, ()>| {
        tool_capture.set(tool_capture.get() + 1);
        Box::pin(async { Ok(demlik_tea::command::Outcome::ok("receipt".to_owned())) })
    })
    .unwrap();
    let router = Rc::new(content_route::Router::new(tool).unwrap());
    let saves = Rc::new(RefCell::new(Vec::new()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let calls = Rc::new(Cell::new(0));
    let capture = Rc::clone(&prompts);
    let model_calls = Rc::clone(&calls);
    let model =
        plain_model(
            async move |messages: Messages<
                '_,
                DefinedAgentMessage<content_route::Router<ReadTool>>,
            >|
                        -> Result<
                Rc<PlainData>,
                CallValue<Error<content_route::Router<ReadTool>>>,
            > {
                capture.borrow_mut().push(
                    messages
                        .as_ref()
                        .iter()
                        .map(|m| match m {
                            DefinedAgentMessage::<content_route::Router<ReadTool>>::System(c) => {
                                json!({"role":"system","content":c})
                            }
                            DefinedAgentMessage::<content_route::Router<ReadTool>>::User(c) => {
                                json!({"role":"user","content":c})
                            }
                            _ => panic!("content failure precedes next model invocation"),
                        })
                        .collect::<Vec<_>>(),
                );
                model_calls.set(model_calls.get() + 1);
                Ok(Rc::new(decode_json(r#"{"content":"Read once.","toolCalls":[{"callId":"read-17","name":"read","args":{}}]}"#).unwrap()))
            },
        );
    let trace = Rc::new(RefCell::new(Vec::new()));
    let config = called!(
        trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        router,
        "Keep provider failures."
    );
    let agent = called!(trace, demlik_tea::agent::define_agent, config);
    let event_capture = Rc::clone(&events);
    let result = called!(
        trace,
        demlik_tea::agent::DefinedAgent::run,
        &agent,
        "Try once.",
        DefinedAgentRunOptions::new(Rc::new(()))
            .run_id("provider-run")
            .clock(|| 50.0)
            .store(RecordingStore(Rc::clone(&saves)))
            .on_event(move |e| event_capture
                .borrow_mut()
                .push(serde_json::to_value(e).unwrap()))
    )
    .await;
    let final_state = match result {
        Err(DriveError::Failed { state }) => Rc::clone(&state),
        _ => panic!("ordinary content failure"),
    };
    let saved = saves.borrow();
    assert!(Rc::ptr_eq(saved.last().unwrap(), &final_state));
    let AgentField::Value(Some(failure)) = &final_state.failure else {
        panic!("failure")
    };
    let AgentFailure::Llm {
        error: AgentField::Value(error),
        ..
    } = failure.as_ref()
    else {
        panic!("llm failure")
    };
    let LlmCause::Value(cause) = &error.error else {
        panic!("typed content cause")
    };
    let DefinedAgentModelError::Content(content_route::ContentErrors::Read(actual)) =
        cause.as_ref()
    else {
        panic!("content variant remains distinct")
    };
    assert!(Rc::ptr_eq(actual, &original));
    assert!(Rc::ptr_eq(&actual.nested, &nested));
    assert_eq!(error.reason.as_utf8(), Some("tool content callback failed"));
    println!(
        "{}",
        json!({"id":"content-error","phase":{"prompts":*prompts.borrow(),"events":*events.borrow(),"saves":*saved,"saveWires":saved.iter().map(|s|serde_json::to_string(s).unwrap()).collect::<Vec<_>>(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"calls":calls.get(),"contentCalls":content_calls.get(),"toolCalls":tool_calls.get(),"outcome":"failed","ownership":{"finalSaved":true,"causeSame":true,"nestedSame":true},"failureClass":"DriveError::Failed","classification":"Content","nativeTrace":*trace.borrow()}})
    );
}
