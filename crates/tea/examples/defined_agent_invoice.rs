//! A real file workflow through the public defined Agent interface.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        DefinedAgentRunOptions, DefinedAgentState, DefinedAgentTools, PlainToolArgs,
        content::{ContentPart, TextPart},
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::{self, ErrorFamily, Raised, ToolContext, ToolDefinition, ToolSpec},
        types::{AgentField, Awaiting},
    },
    command::{CommandSpec, Failure, Issue, Outcome, SchemaError},
    data::decode_json,
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    runtime::{self, DriveOptions, Options, Persistence, Profile},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    convert::Infallible,
    path::PathBuf,
    rc::{Rc, Weak},
};

demlik_tea::tool_router! { mod invoice { Collect(collect), Check(check), Summarize(summarize) } }
const INPUT: &str = "Finish invoice 17 from invoice.json.";
const INSTRUCTIONS: &str = "Collect invoice 17, check its total, write its summary.";
macro_rules! called {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let value = $function($($argument),*);
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}

#[derive(Clone, Copy)]
enum Kind {
    Collect,
    Check,
    Summarize,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Collect => "collect_invoice",
            Self::Check => "check_invoice",
            Self::Summarize => "summarize_invoice",
        }
    }
}
struct Args {
    source: Rc<PlainToolArgs>,
    raw: Option<Rc<PlainToolArgs>>,
    file: String,
    expected: Option<f64>,
    destination: Option<String>,
}
impl Serialize for Args {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(raw) = &self.raw {
            return raw.value().serialize(serializer);
        }
        let mut fields = json!({"file": self.file});
        if let Some(expected) = self.expected {
            fields["expected"] = json!(expected);
        }
        if let Some(destination) = &self.destination {
            fields["destination"] = json!(destination);
        }
        fields.serialize(serializer)
    }
}
struct InputSchema(Kind);
impl Schema for InputSchema {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<Args>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        let value = serde_json::to_value(raw.value()).unwrap();
        let refuse = || {
            CallValue::value(SchemaError::Issues(vec![Issue::new(
                "",
                "invoice arguments",
            )]))
        };
        let file = value["file"].as_str().ok_or_else(refuse)?.to_owned();
        let expected = value["expected"].as_f64();
        let destination = value["destination"].as_str().map(str::to_owned);
        if matches!(self.0, Kind::Check) && expected.is_none()
            || matches!(self.0, Kind::Summarize) && destination.is_none()
        {
            return Err(refuse());
        }
        Ok(Rc::new(Args {
            source: Rc::clone(&raw),
            raw: matches!(self.0, Kind::Collect).then_some(raw),
            file,
            expected,
            destination,
        }))
    }
}
struct Identity;
impl Schema for Identity {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
#[derive(Serialize)]
struct InvalidInvoice {
    expected: f64,
    actual: f64,
    data: Rc<Value>,
}
impl Tagged for InvalidInvoice {
    fn tag(&self) -> &str {
        "invalid_invoice"
    }
}
struct Host {
    owner: Weak<Host>,
    directory: PathBuf,
    calls: RefCell<Vec<Value>>,
    original_turns: RefCell<Vec<Rc<PlainData>>>,
    error_data: Rc<Value>,
}
fn plain(value: Value) -> PlainData {
    decode_json(&value.to_string()).unwrap()
}
fn definition(
    kind: Kind,
) -> Rc<
    impl ToolDefinition<
        RawArgs = PlainToolArgs,
        Args = Args,
        RawResult = Rc<PlainData>,
        Ok = PlainData,
        Error = InvalidInvoice,
        Thrown = (),
        Host = Host,
        ContentError = Infallible,
    >,
> {
    let family = ErrorFamily::new(["invalid_invoice"], |error: &InvalidInvoice| {
        Ok(plain(
            json!({"_tag":"invalid_invoice", "expected":error.expected, "actual":error.actual, "data":error.data}),
        ))
    });
    let spec = ToolSpec::new(Rc::new(InputSchema(kind)), Rc::new(Identity), family).raised::<()>();
    let spec = if matches!(kind, Kind::Check) {
        spec
    } else {
        spec.content(move |value| {
            let value = serde_json::to_value(value).unwrap();
            let text = match kind {
                Kind::Collect => value["raw"].as_str(),
                Kind::Summarize => value["text"].as_str(),
                Kind::Check => None,
            };
            Rc::new(RefCell::new(
                text.map(|text| ContentPart::Text(Rc::new(TextPart { text: text.into() })))
                    .into_iter()
                    .collect(),
            ))
        })
    };
    tool::tool(kind.name(), spec, move |args: &Rc<Args>, ctx: ToolContext<'_, Host>| {
        Box::pin(async move {
            let original=ctx.host.owner.upgrade().expect("retained application host");
            assert!(std::ptr::eq(ctx.host,original.as_ref()),"the interpreter must pass the original host");
            assert!(ctx.host.original_turns.borrow().iter().any(|turn|Rc::ptr_eq(turn,args.source.call().owner())),"the handler's raw cursor must retain an actual model-returned or restored turn");
            let raw_same=args.raw.as_ref().is_some_and(|raw|Rc::ptr_eq(raw,&args.source));
            ctx.host.calls.borrow_mut().push(json!({"tool":kind.name(),"args":args,"rawSame":raw_same,"hostObjectSame":std::ptr::eq(ctx.host,original.as_ref())}));
            let raw = std::fs::read_to_string(ctx.host.directory.join(&args.file)).unwrap();
            let value: Value = serde_json::from_str(&raw).unwrap();
            let result = match kind {
                Kind::Collect => json!({"invoiceId":"invoice-17","raw":raw}),
                Kind::Check => {
                    let total: f64 = value["lines"].as_array().unwrap().iter().map(|line| line.as_f64().unwrap()).sum();
                    if args.expected != Some(total) || value["total"].as_f64() != Some(total) {
                        return Err(Raised::Declared(Rc::new(InvalidInvoice { expected:args.expected.unwrap(), actual:total, data:Rc::clone(&ctx.host.error_data) })));
                    }
                    json!({"invoiceId":value["id"],"valid":true,"total":total})
                }
                Kind::Summarize => {
                    let text = format!("{}: {}\n", value["id"].as_str().unwrap(), value["total"].as_i64().unwrap());
                    let destination = args.destination.as_ref().unwrap();
                    std::fs::write(ctx.host.directory.join(destination), &text).unwrap();
                    json!({"file":destination,"text":text})
                }
            };
            Ok(Outcome::ok(Rc::new(plain(result))))
        })
    }).unwrap()
}
struct RecordingStore<S> {
    states: Rc<RefCell<Vec<S>>>,
    wires: Rc<RefCell<Vec<String>>>,
    seed: Option<S>,
}
impl<S: Clone + Serialize> Store<S> for RecordingStore<S> {
    type Raw = Option<S>;
    type Error = Infallible;
    async fn load(&self) -> Result<Option<S>, Infallible> {
        Ok(self.seed.clone())
    }
    async fn save(&self, state: &S) -> Result<(), Infallible> {
        self.wires
            .borrow_mut()
            .push(serde_json::to_string(state).unwrap());
        self.states.borrow_mut().push(state.clone());
        Ok(())
    }
    fn migrate(&self, raw: Option<S>) -> Migrated<S> {
        match raw {
            Some(value) => Migrated::State(value),
            None => Migrated::Fresh,
        }
    }
}
fn turns(failing: bool) -> Vec<Rc<PlainData>> {
    let provider = json!({"resumeToken":{"original":"provider-17"},"extra":[1,2]});
    let make = |content: &str, tool_calls: Value| {
        Rc::new(plain(
            json!({"content":content,"toolCalls":tool_calls,"provider":provider,"unknownTurn":{"keep":true}}),
        ))
    };
    let mut turns = vec![
        make(
            "Collect invoice",
            json!([{"callId":"collect-17","name":"collect_invoice","args":{"file":"invoice.json","rawExtra":{"keep":true}}}]),
        ),
        make(
            "Check invoice",
            json!([{"callId":"check-17","name":"check_invoice","args":{"file":"invoice.json","expected":if failing {18}else{17},"rawExtra":{"keep":true}}}]),
        ),
    ];
    if !failing {
        turns.push(make("Summarize invoice",json!([{"callId":"summary-17","name":"summarize_invoice","args":{"file":"invoice.json","destination":"report.txt","rawExtra":{"keep":true}}}])));
    }
    turns.push(make(
        if failing {
            "Invoice total rejected"
        } else {
            "Invoice 17 checked and summarized"
        },
        json!([]),
    ));
    turns
}
fn prompt<R: DefinedAgentTools>(messages: &[DefinedAgentMessage<R>]) -> Value
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    Value::Array(messages.iter().map(|message| match message {
        DefinedAgentMessage::<R>::System(content) => json!({"role":"system","content":content}),
        DefinedAgentMessage::<R>::User(content) => json!({"role":"user","content":content}),
        DefinedAgentMessage::<R>::Assistant(turn) => {
            let turn = serde_json::to_value(turn).unwrap();
            json!({"role":"assistant","content":turn["content"],"toolCalls":turn["toolCalls"],"provider":turn["provider"]})
        }
        DefinedAgentMessage::<R>::Tool{record,parts} => {
            let mut message=json!({"role":"tool","callId":record.call.call_id(),"name":record.call.name(),"outcome":record.outcome});
            if let Some(parts)=parts {message["parts"]=serde_json::to_value(parts).unwrap();}
            message
        }
    }).collect())
}
struct Phase<R: DefinedAgentTools> {
    final_state: Rc<DefinedAgentState<R>>,
    saves: Vec<Rc<DefinedAgentState<R>>>,
    view: Value,
}
fn original_error<
    A: CommandSpec,
    B: CommandSpec<Error = tool::ToolFailure<InvalidInvoice, ()>>,
    C: CommandSpec,
>(
    error: &invoice::Errors<A, B, C>,
    expected: &Rc<Value>,
) -> bool {
    let invoice::Errors::Check(view) = error else {
        return false;
    };
    let Failure::Declared(tool::ToolFailure::Declared(cause)) = &view.error else {
        return false;
    };
    Rc::ptr_eq(&cause.data, expected)
}
#[expect(
    clippy::too_many_arguments,
    reason = "One shared consumer exercises the frozen Source routes and retained restart checkpoints."
)]
#[expect(
    clippy::result_large_err,
    reason = "The raw machine route keeps the existing canonical typed reducer error channel."
)]
async fn execute<R>(
    router: Rc<R>,
    host: Rc<Host>,
    failing: bool,
    seed: Option<Rc<DefinedAgentState<R>>>,
    start: usize,
    instructions: &'static str,
    raw_machine: bool,
    verify_error: impl Fn(&R::Error, &Rc<Value>) -> bool + 'static,
) -> Phase<R>
where
    R: DefinedAgentTools<Host = Host>,
    R::Result: Serialize,
    R::Error: Serialize,
{
    let scripts = turns(failing);
    if let Some(conversation) = seed.as_ref().and_then(|state| state.conversation.as_ref()) {
        host.original_turns
            .borrow_mut()
            .extend(conversation.turns.iter().map(Rc::clone));
    }
    let index = Rc::new(RefCell::new(start));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let capture = Rc::clone(&prompts);
    let model_host = Rc::clone(&host);
    let model = plain_model(
        async move |messages: Messages<'_, DefinedAgentMessage<R>>| -> Result<
            Rc<PlainData>,
            CallValue<DefinedAgentModelError<R::ContentError>>,
        > {
            for message in messages.as_ref() {
                if let DefinedAgentMessage::<R>::Assistant(turn) = message {
                    assert!(
                        model_host
                            .original_turns
                            .borrow()
                            .iter()
                            .any(|original| Rc::ptr_eq(turn, original)),
                        "the prompt must retain the original assistant turn"
                    );
                }
            }
            capture.borrow_mut().push(prompt::<R>(messages.as_ref()));
            let mut index = index.borrow_mut();
            let value = Rc::clone(scripts.get(*index).expect("no extra model call"));
            *index += 1;
            model_host
                .original_turns
                .borrow_mut()
                .push(Rc::clone(&value));
            Ok(value)
        },
    );
    let saves = Rc::new(RefCell::new(Vec::new()));
    let wires = Rc::new(RefCell::new(Vec::new()));
    let hooks = Rc::new(RefCell::new(Vec::new()));
    let hook_capture = Rc::clone(&hooks);
    let hook_saves = Rc::clone(&saves);
    let hook_host = Rc::clone(&host);
    let events = Rc::new(RefCell::new(Vec::new()));
    let native_calls = Rc::new(RefCell::new(Vec::new()));
    let event_capture = Rc::clone(&events);
    let store = RecordingStore {
        states: Rc::clone(&saves),
        wires: Rc::clone(&wires),
        seed,
    };
    let config=called!(native_calls, demlik_tea::agent::DefineAgentConfig::new, model,Rc::clone(&router),instructions).on_tool_error(move |failure| {
        let before=hook_saves.borrow().last().and_then(|state:&Rc<DefinedAgentState<R>>|state.conversation.as_ref()).map(|conversation|conversation.tool_records.len());
        let receipt=json!({"outcome":failure.outcome,"context":failure.context,"recordsBeforeHook":before,"originalErrorData":verify_error(&failure.outcome,&hook_host.error_data)});
        let saves=Rc::clone(&hook_saves);
        let hooks=Rc::clone(&hook_capture);
        Box::pin(async move {
            tokio::task::yield_now().await;
            assert_eq!(saves.borrow().last().and_then(|state|state.conversation.as_ref()).map(|conversation|conversation.tool_records.len()),before,"hook must finish before folding tool failure");
            hooks.borrow_mut().push(receipt);
        })
    });
    let agent = called!(native_calls, demlik_tea::agent::define_agent, config);
    let final_state = if raw_machine {
        let wired = called!(
            native_calls,
            demlik_tea::agent::DefinedAgent::machine,
            &agent,
            INPUT.into(),
            Rc::clone(&host),
            Rc::new(TokioTimer::with_clock(|| 50.0, |_| {})),
        );
        let projection = demlik_tea::agent::plain_agent_events();
        let routes = Rc::clone(&router).bind(Rc::clone(&host));
        let mut options = Options::new(Profile::Promise);
        options.store = Some(Persistence::new(store));
        options.clock = Rc::new(|| 50.0);
        options.terminal = Some(Rc::new(|state: &Rc<DefinedAgentState<R>>| {
            state.is_settled()
        }));
        let options = options.with_checked_events(move |message, state| {
            projection
                .project_routed::<_, _, _, _, _, _, _, _, _, _, _, R::Command, _>(
                    message, state, &routes,
                )
                .map_err(demlik_tea::agent::AgentMachineError::from)
        });
        let runtime =
            runtime::try_launch(wired.machine, (), wired.interpret, wired.subscribe, options);
        let listeners: Vec<_> = demlik_tea::agent::types::AGENT_EVENT_TYPES
            .into_iter()
            .map(|kind| {
                let capture = Rc::clone(&event_capture);
                runtime.on(
                    kind,
                    Rc::new(move |event| {
                        capture
                            .borrow_mut()
                            .push(serde_json::to_value(event).unwrap())
                    }),
                )
            })
            .collect();
        let outcome = runtime::drive_to_done(
            &runtime,
            demlik_tea::agent::AgentMachineMsg::Start {
                run_id: "invoice-run-17".into(),
                at: 50.0,
            },
            |state| state.is_settled(),
            DriveOptions::default(),
        )
        .await
        .unwrap();
        for detach in listeners {
            detach();
        }
        Rc::clone(&outcome)
    } else {
        called!(
            native_calls,
            demlik_tea::agent::DefinedAgent::run,
            &agent,
            INPUT,
            DefinedAgentRunOptions::new(Rc::clone(&host))
                .run_id("invoice-run-17")
                .clock(|| 50.0)
                .store(store)
                .on_event(move |event| {
                    event_capture
                        .borrow_mut()
                        .push(serde_json::to_value(event).unwrap())
                }),
        )
        .await
        .unwrap()
    };
    assert!(final_state.is_settled() && final_state.conversation.is_none());
    for state in saves.borrow().iter() {
        if let Some(conversation) = &state.conversation {
            assert!(conversation.turns.iter().all(|turn| {
                host.original_turns
                    .borrow()
                    .iter()
                    .any(|original| Rc::ptr_eq(turn, original))
            }));
            assert!(conversation.tool_records.iter().all(|record| {
                host.original_turns
                    .borrow()
                    .iter()
                    .any(|original| Rc::ptr_eq(record.call.owner(), original))
            }));
        }
    }
    assert!(
        matches!(final_state.instructions,AgentField::Value(Some(ref value)) if value.as_utf8()==Some(INSTRUCTIONS))
    );
    let view = json!({"prompts":*prompts.borrow(),"events":*events.borrow(),"hooks":*hooks.borrow(),"handlerCalls":*host.calls.borrow(),"saves":saves.borrow().iter().map(|state|serde_json::to_value(state).unwrap()).collect::<Vec<_>>(),"saveWires":*wires.borrow(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"nativeTrace":*native_calls.borrow()});
    let states = saves.borrow().clone();
    Phase {
        final_state,
        saves: states,
        view,
    }
}
async fn run() {
    let base = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/defined-agent-invoice"));
    std::fs::create_dir_all(&base).unwrap();
    let router = Rc::new(
        invoice::Router::new(
            definition(Kind::Collect),
            definition(Kind::Check),
            definition(Kind::Summarize),
        )
        .unwrap(),
    );
    for scenario in [
        "complete",
        "machine",
        "resume-brain",
        "resume-tool",
        "terminal",
        "declared-failure",
    ] {
        let directory = base.join(scenario);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("invoice.json"),
            "{\"id\":\"invoice-17\",\"lines\":[7,10],\"total\":17}\n",
        )
        .unwrap();
        let host = || {
            Rc::new_cyclic(|owner| Host {
                owner: owner.clone(),
                directory: directory.clone(),
                calls: RefCell::new(Vec::new()),
                original_turns: RefCell::new(Vec::new()),
                error_data: Rc::new(
                    json!({"invoice":"invoice-17","evidence":{"source":"validator","code":17}}),
                ),
            })
        };
        let first = execute(
            Rc::clone(&router),
            host(),
            scenario == "declared-failure",
            None,
            0,
            INSTRUCTIONS,
            scenario == "machine",
            original_error,
        )
        .await;
        let mut phases = vec![first.view];
        if matches!(scenario, "resume-brain" | "resume-tool" | "terminal") {
            let checkpoint = if scenario == "terminal" {
                Rc::clone(&first.final_state)
            } else {
                first
                    .saves
                    .iter()
                    .find(|state| {
                        state.conversation.as_ref().is_some_and(|conversation| {
                            if scenario == "resume-brain" {
                                matches!(conversation.awaiting, Awaiting::Llm)
                                    && conversation.tool_records.len() == 1
                            } else {
                                matches!(conversation.awaiting, Awaiting::Tools { .. })
                                    && conversation.turns.len() == 1
                            }
                        })
                    })
                    .map(Rc::clone)
                    .expect("actual saved checkpoint")
            };
            let second = execute(
                Rc::clone(&router),
                host(),
                false,
                Some(Rc::clone(&checkpoint)),
                if scenario == "terminal" { 100 } else { 1 },
                "New config instructions must not replace the stored ones.",
                false,
                original_error,
            )
            .await;
            if scenario == "terminal" {
                assert!(Rc::ptr_eq(&checkpoint, &second.final_state));
                assert_eq!(second.view["prompts"], json!([]));
            } else {
                assert_eq!(second.view["prompts"].as_array().unwrap().len(), 3);
            }
            phases.push(second.view);
        }
        if scenario != "declared-failure" {
            assert_eq!(
                std::fs::read_to_string(directory.join("report.txt")).unwrap(),
                "invoice-17: 17\n"
            );
        }
        let report = std::fs::read_to_string(directory.join("report.txt")).ok();
        println!(
            "{}",
            json!({"scenario":scenario,"phases":phases,"report":report})
        );
    }
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, run());
}
