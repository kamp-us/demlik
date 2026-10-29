//! A public streaming agent with real tools, snapshots and retained progress handles.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        DefinedAgent, DefinedAgentRunOptions, DefinedAgentState, DefinedAgentTools, PlainToolArgs,
        defined::{DefinedAgentMessage, DefinedAgentModelError, DefinedTurnSchema},
        model::{Messages, ModelFactory, ModelStream, TurnChunk},
        tool::{self, ErrorFamily, ToolDefinition, ToolSpec},
        types::{AgentFailure, AgentField, ToolOutcome},
    },
    command::{Outcome, SchemaError},
    data::decode_json,
    llm_call::LlmCause,
    resilience::resilient_call::CallValue,
    runtime::{self, DriveError, DriveOptions, Options, Persistence, Profile},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    convert::Infallible,
    rc::Rc,
};
demlik_tea::tool_router! {mod tools {Lookup(lookup)}}
macro_rules! called {($trace:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let value=$function($($argument),*);$trace.borrow_mut().push(stringify!($function));value}};}
type Error<R> = DefinedAgentModelError<<R as DefinedAgentTools>::ContentError, Rc<ProviderError>>;
type State<R> = Rc<DefinedAgentState<R, Rc<ProviderError>>>;
type CheckResult<R> = dyn Fn(&<R as DefinedAgentTools>::Result, &str);
struct Args {
    raw: Rc<PlainToolArgs>,
    input: String,
}
impl Serialize for Args {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.raw.value().serialize(s)
    }
}
struct Input;
impl demlik_tea::llm_call::Schema for Input {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<Args>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        let value = serde_json::to_value(raw.value()).unwrap();
        Ok(Rc::new(Args {
            input: value["input"].as_str().unwrap().to_owned(),
            raw,
        }))
    }
}
#[derive(Serialize)]
struct ResultValue {
    input: String,
    nested: Rc<Value>,
}
struct Identity;
impl demlik_tea::llm_call::Schema for Identity {
    type Raw = Rc<ResultValue>;
    type Output = Rc<ResultValue>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
enum NoErrors {}
impl Tagged for NoErrors {
    fn tag(&self) -> &str {
        match *self {}
    }
}
#[derive(Serialize)]
struct ProviderError {
    code: &'static str,
    nested: Rc<Value>,
}
struct Control {
    mode: &'static str,
    records: RefCell<BTreeMap<String, Rc<Capture>>>,
    streams: RefCell<BTreeMap<String, Vec<ModelStream>>>,
    turns: BTreeMap<String, Vec<Rc<PlainData>>>,
    results: BTreeMap<String, Rc<ResultValue>>,
    provider: Rc<ProviderError>,
    trace: Rc<RefCell<Vec<&'static str>>>,
}
#[derive(Default)]
struct Capture {
    chunks: RefCell<Vec<Rc<TurnChunk>>>,
    prompts: RefCell<Vec<Value>>,
    events: RefCell<Vec<Value>>,
    trace: RefCell<Vec<String>>,
    calls: Cell<usize>,
    stream_calls: Cell<usize>,
    wires: RefCell<Vec<String>>,
}
fn definition(
    c: Rc<Control>,
) -> Rc<
    impl ToolDefinition<
        Host = (),
        RawArgs = PlainToolArgs,
        Args = Args,
        RawResult = Rc<ResultValue>,
        Ok = ResultValue,
        Error = NoErrors,
        ContentError = Infallible,
    >,
> {
    let spec = ToolSpec::new(
        Rc::new(Input),
        Rc::new(Identity),
        ErrorFamily::new(std::iter::empty::<&str>(), |e: &NoErrors| match *e {}),
    );
    tool::tool("lookup", spec, move |args: &Rc<Args>, _| {
        let c = Rc::clone(&c);
        Box::pin(async move {
            assert!(Rc::ptr_eq(
                args.raw.call().owner(),
                &c.turns[&args.input][0]
            ));
            Ok(Outcome::ok(Rc::clone(&c.results[&args.input])))
        })
    })
    .unwrap()
}
struct RecordingStore<S> {
    seed: Option<S>,
    capture: Rc<Capture>,
    saves: Rc<RefCell<Vec<S>>>,
}
impl<S: Clone + Serialize> Store<S> for RecordingStore<S> {
    type Raw = Option<S>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.seed.clone())
    }
    async fn save(&self, s: &S) -> Result<(), Self::Error> {
        self.capture
            .wires
            .borrow_mut()
            .push(serde_json::to_string(s).unwrap());
        self.saves.borrow_mut().push(s.clone());
        Ok(())
    }
    fn migrate(&self, s: Self::Raw) -> Migrated<S> {
        s.map_or(Migrated::Fresh, Migrated::State)
    }
}
fn prompt<R: DefinedAgentTools>(messages: &[DefinedAgentMessage<R>]) -> Value
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    Value::Array(messages.iter().map(|m|match m{DefinedAgentMessage::<R>::System(c)=>json!({"role":"system","content":c}),DefinedAgentMessage::<R>::User(c)=>json!({"role":"user","content":c}),DefinedAgentMessage::<R>::Assistant(t)=>{let t=serde_json::to_value(t).unwrap();json!({"role":"assistant","content":t["content"],"toolCalls":t["toolCalls"],"provider":t["provider"]})},DefinedAgentMessage::<R>::Tool{record,parts}=>{assert!(parts.is_none());json!({"role":"tool","callId":record.call.call_id(),"name":record.call.name(),"outcome":record.outcome})}}).collect())
}
async fn body<R: DefinedAgentTools>(
    c: &Rc<Control>,
    messages: Messages<'_, DefinedAgentMessage<R>>,
    stream: Option<ModelStream>,
    error: &Rc<Error<R>>,
    check: &dyn Fn(&R::Result, &str),
) -> Result<Rc<PlainData>, CallValue<Error<R>>>
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    let input = messages
        .as_ref()
        .iter()
        .find_map(|m| {
            if let DefinedAgentMessage::<R>::User(
                demlik_tea::agent::content::MessageContent::Text(s),
            ) = m
            {
                s.as_utf8().map(str::to_owned)
            } else {
                None
            }
        })
        .unwrap();
    let record = Rc::clone(&c.records.borrow()[&input]);
    record.calls.set(record.calls.get() + 1);
    record
        .prompts
        .borrow_mut()
        .push(prompt::<R>(messages.as_ref()));
    let second = messages
        .as_ref()
        .iter()
        .any(|m| matches!(m, DefinedAgentMessage::<R>::Assistant(_)));
    record
        .trace
        .borrow_mut()
        .push(format!("model:{}", usize::from(second)));
    if let Some(stream) = stream {
        record.stream_calls.set(record.stream_calls.get() + 1);
        let first = {
            let mut streams = c.streams.borrow_mut();
            let previous = streams.entry(input.clone()).or_default();
            previous.push(stream.clone());
            previous[0].clone()
        };
        if c.mode == "late" && second {
            first.on_chunk(Rc::new(TurnChunk {
                text: format!("after-turn-{input}").into(),
            }));
        }
        for word in ["head", "middle", "tail"] {
            let chunk = Rc::new(TurnChunk {
                text: format!("{}:{word}-{input}", usize::from(second)).into(),
            });
            stream.on_chunk(Rc::clone(&chunk));
            assert!(
                record.chunks.borrow().iter().any(|v| Rc::ptr_eq(v, &chunk))
                    || matches!(c.mode, "omitted" | "raw"),
                "configured stream must deliver its original chunk"
            );
            tokio::task::yield_now().await;
        }
    }
    if c.mode == "provider-failure" {
        return Err(CallValue::shared(Rc::clone(error)));
    }
    for m in messages.as_ref() {
        match m {
            DefinedAgentMessage::<R>::Assistant(turn) => {
                assert!(c.turns[&input].iter().any(|v| Rc::ptr_eq(v, turn)))
            }
            DefinedAgentMessage::<R>::Tool { record, .. } => {
                assert!(Rc::ptr_eq(record.call.owner(), &c.turns[&input][0]));
                if let ToolOutcome::Ok(value) = record.outcome.as_ref() {
                    check(value.as_ref(), &input);
                }
            }
            _ => {}
        }
    }
    Ok(Rc::clone(&c.turns[&input][usize::from(second)]))
}
struct Phase<R: DefinedAgentTools> {
    capture: Rc<Capture>,
    saves: Vec<State<R>>,
    final_state: State<R>,
    outcome: &'static str,
}
impl<R: DefinedAgentTools> Phase<R>
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    fn value(&self) -> Value {
        let r = &self.capture;
        json!({"chunks":r.chunks.borrow().clone(),"warnings":[],"prompts":r.prompts.borrow().clone(),"events":r.events.borrow().clone(),"trace":r.trace.borrow().clone(),"saves":r.wires.borrow().iter().map(|w|serde_json::from_str::<Value>(w).unwrap()).collect::<Vec<_>>(),"saveWires":r.wires.borrow().clone(),"calls":r.calls.get(),"streamCalls":r.stream_calls.get(),"outcome":self.outcome,"final":self.final_state,"finalWire":serde_json::to_string(&self.final_state).unwrap()})
    }
}
#[expect(
    clippy::result_large_err,
    reason = "The real machine retains its canonical typed reducer failures."
)]
async fn drive<F, R: DefinedAgentTools<Host = ()>>(
    agent: &DefinedAgent<F, R, Rc<ProviderError>>,
    router: Rc<R>,
    c: Rc<Control>,
    baseline: bool,
    input: &'static str,
    seed: Option<State<R>>,
    error: Rc<Error<R>>,
) -> Phase<R>
where
    F: ModelFactory<DefinedAgentMessage<R>, DefinedTurnSchema<R::ContentError, Rc<ProviderError>>>
        + 'static,
    R::Result: Serialize,
    R::Error: Serialize,
    R::Bound: runtime::Interpreter<
            R::Command,
            demlik_tea::agent::DefinedAgentMsg<R, Rc<ProviderError>>,
            Error = demlik_tea::agent::AgentWorkError<tool::ToolError>,
        >,
{
    let record = Rc::new(Capture::default());
    c.records
        .borrow_mut()
        .insert(input.into(), Rc::clone(&record));
    let saves = Rc::new(RefCell::new(vec![]));
    let seed_owner = seed.clone();
    let store = RecordingStore {
        seed,
        capture: Rc::clone(&record),
        saves: Rc::clone(&saves),
    };
    let captured = Rc::clone(&record);
    let answer = if c.mode == "raw" && !baseline {
        let w = called!(
            c.trace,
            demlik_tea::agent::DefinedAgent::machine,
            agent,
            input.into(),
            Rc::new(()),
            Rc::new(TokioTimer::with_clock(|| 50.0, |_| {}))
        );
        let mut opts = Options::new(Profile::Promise);
        opts.store = Some(Persistence::new(store));
        opts.clock = Rc::new(|| 50.0);
        opts.terminal = Some(Rc::new(|s: &State<R>| s.is_settled()));
        let projection = demlik_tea::agent::plain_agent_events();
        let routes = router.bind(Rc::new(()));
        let opts = opts.with_checked_events(move |msg, s| {
            projection
                .project_routed::<_, _, _, _, _, _, _, _, _, _, _, R::Command, _>(msg, s, &routes)
                .map_err(demlik_tea::agent::AgentMachineError::from)
        });
        let h = runtime::try_launch(w.machine, (), w.interpret, w.subscribe, opts);
        let listeners: Vec<_> = demlik_tea::agent::types::AGENT_EVENT_TYPES
            .into_iter()
            .map(|kind| {
                let captured = Rc::clone(&captured);
                h.on(
                    kind,
                    Rc::new(move |e| {
                        let v = serde_json::to_value(e).unwrap();
                        captured
                            .trace
                            .borrow_mut()
                            .push(v["type"].as_str().unwrap().into());
                        captured.events.borrow_mut().push(v);
                    }),
                )
            })
            .collect();
        let s = runtime::drive_to_done(
            &h,
            demlik_tea::agent::AgentMachineMsg::Start {
                run_id: "stream-run".into(),
                at: 50.0,
            },
            |s| s.is_settled(),
            DriveOptions::default(),
        )
        .await
        .map(|s| Rc::clone(&s));
        for off in listeners {
            off();
        }
        s
    } else {
        let mut opts = DefinedAgentRunOptions::new(Rc::new(()))
            .run_id("stream-run")
            .clock(|| 50.0)
            .on_event(move |e| {
                let value = serde_json::to_value(e).unwrap();
                captured
                    .trace
                    .borrow_mut()
                    .push(value["type"].as_str().unwrap().into());
                captured.events.borrow_mut().push(value);
            });
        if !baseline && c.mode != "omitted" {
            let chunks = Rc::clone(&record);
            let throwing = c.mode == "throwing";
            opts = called!(
                c.trace,
                demlik_tea::agent::DefinedAgentRunOptions::on_chunk,
                opts,
                move |chunk| {
                    chunks
                        .trace
                        .borrow_mut()
                        .push(format!("chunk:{}", chunk.text.as_utf8().unwrap()));
                    chunks.chunks.borrow_mut().push(Rc::clone(chunk));
                    if throwing {
                        panic!("progress defect");
                    }
                }
            );
        }
        let opts = opts.store(store);
        called!(
            c.trace,
            demlik_tea::agent::DefinedAgent::run,
            agent,
            input,
            opts
        )
        .await
    };
    let (final_state, outcome) = match answer {
        Ok(s) => (s, "resolved"),
        Err(DriveError::Failed { state }) => {
            let state = Rc::clone(&state);
            let AgentField::Value(Some(failure)) = &state.failure else {
                panic!("canonical failure")
            };
            let AgentFailure::Llm {
                error: AgentField::Value(error_view),
                ..
            } = failure.as_ref()
            else {
                panic!("llm failure")
            };
            let LlmCause::Value(original) = &error_view.error else {
                panic!("actual error")
            };
            assert!(Rc::ptr_eq(original, &error));
            let DefinedAgentModelError::Provider(provider) = original.as_ref() else {
                panic!("provider failure")
            };
            assert!(Rc::ptr_eq(provider, &c.provider));
            assert!(Rc::ptr_eq(&provider.nested, &c.provider.nested));
            (state, "failed")
        }
        Err(error) => panic!("unexpected {error:?}"),
    };
    assert!(Rc::ptr_eq(&final_state, saves.borrow().last().unwrap()));
    if let Some(seed) = seed_owner {
        assert!(Rc::ptr_eq(&seed, saves.borrow().first().unwrap()));
    }
    let saved = saves.borrow().clone();
    Phase {
        capture: record,
        saves: saved,
        final_state,
        outcome,
    }
}
async fn execute_agent<F, R: DefinedAgentTools<Host = ()>>(
    model: F,
    router: Rc<R>,
    c: Rc<Control>,
    baseline: bool,
    error: Rc<Error<R>>,
) -> Value
where
    F: ModelFactory<DefinedAgentMessage<R>, DefinedTurnSchema<R::ContentError, Rc<ProviderError>>>
        + 'static,
    R::Result: Serialize,
    R::Error: Serialize,
    R::Bound: runtime::Interpreter<
            R::Command,
            demlik_tea::agent::DefinedAgentMsg<R, Rc<ProviderError>>,
            Error = demlik_tea::agent::AgentWorkError<tool::ToolError>,
        >,
{
    let config = called!(
        c.trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        Rc::clone(&router),
        "Stream progress, settle complete turns."
    )
    .describe_provider_error(|_: &Rc<ProviderError>| Ok("stream unavailable".into()));
    let agent = called!(c.trace, demlik_tea::agent::define_agent, config);
    let mut phases = if c.mode == "isolation" {
        let (a, b) = futures::join!(
            drive(
                &agent,
                Rc::clone(&router),
                Rc::clone(&c),
                baseline,
                "A",
                None,
                Rc::clone(&error)
            ),
            drive(
                &agent,
                Rc::clone(&router),
                Rc::clone(&c),
                baseline,
                "B",
                None,
                Rc::clone(&error)
            )
        );
        if !baseline {
            c.streams.borrow()["A"][0].on_chunk(Rc::new(TurnChunk {
                text: "after-other-run-A".into(),
            }));
            assert!(
                !b.capture
                    .chunks
                    .borrow()
                    .iter()
                    .any(|v| v.text.as_utf8() == Some("after-other-run-A"))
            );
        }
        vec![a, b]
    } else {
        vec![
            drive(
                &agent,
                Rc::clone(&router),
                Rc::clone(&c),
                baseline,
                "A",
                None,
                Rc::clone(&error),
            )
            .await,
        ]
    };
    if c.mode == "resume" {
        let seed = phases[0]
            .saves
            .iter()
            .find(|s| {
                s.conversation.as_ref().is_some_and(|v| {
                    matches!(v.awaiting, demlik_tea::agent::types::Awaiting::Llm)
                        && v.tool_records.len() == 1
                })
            })
            .cloned()
            .unwrap();
        c.streams.borrow_mut().remove("A");
        phases.push(
            drive(
                &agent,
                router,
                Rc::clone(&c),
                baseline,
                "A",
                Some(seed),
                error,
            )
            .await,
        );
    }
    drop(agent);
    if c.mode == "late" && !baseline {
        c.streams.borrow()["A"][0].on_chunk(Rc::new(TurnChunk {
            text: "after-run-A".into(),
        }));
    }
    json!({"phases":phases.iter().map(Phase::value).collect::<Vec<_>>(),"nativeTrace":c.trace.borrow().clone()})
}
fn control(mode: &'static str) -> Rc<Control> {
    let inputs = if mode == "isolation" {
        vec!["A", "B"]
    } else {
        vec!["A"]
    };
    Rc::new(Control{mode,records:RefCell::new(BTreeMap::new()),streams:RefCell::new(BTreeMap::new()),turns:inputs.iter().map(|input|((*input).into(),vec![Rc::new(decode_json(&json!({"content":format!("tools-{input}"),"toolCalls":[{"callId":format!("{input}-call"),"name":"lookup","args":{"input":input,"nested":{"owner":format!("arg-{input}")}}}],"provider":{"opaque":17},"extra":{"kept":true}}).to_string()).unwrap()),Rc::new(decode_json(&json!({"content":format!("done-{input}"),"toolCalls":[],"provider":{"opaque":17}}).to_string()).unwrap())])).collect(),results:inputs.iter().map(|input|((*input).into(),Rc::new(ResultValue{input:(*input).into(),nested:Rc::new(json!({"owner":format!("result-{input}")}))}))).collect(),provider:Rc::new(ProviderError{code:"offline",nested:Rc::new(json!({"owner":"provider"}))}),trace:Rc::new(RefCell::new(vec![]))})
}
async fn execute<R: DefinedAgentTools<Host = ()>>(
    mode: &'static str,
    baseline: bool,
    router: Rc<R>,
    c: Rc<Control>,
    check: Rc<CheckResult<R>>,
) -> Value
where
    R::Result: Serialize,
    R::Error: Serialize,
    R::Bound: runtime::Interpreter<
            R::Command,
            demlik_tea::agent::DefinedAgentMsg<R, Rc<ProviderError>>,
            Error = demlik_tea::agent::AgentWorkError<tool::ToolError>,
        >,
{
    let error = Rc::new(DefinedAgentModelError::Provider(Rc::clone(&c.provider)));
    let body_c = Rc::clone(&c);
    let body_error = Rc::clone(&error);
    if baseline || mode == "plain-sink" {
        let callback = async move |messages: Messages<'_, DefinedAgentMessage<R>>| {
            body::<R>(&body_c, messages, None, &body_error, check.as_ref()).await
        };
        let model = called!(c.trace, demlik_tea::agent::model::plain_model, callback);
        execute_agent(model, router, c, baseline, error).await
    } else {
        let callback = async move |messages: Messages<'_, DefinedAgentMessage<R>>,
                                   stream: ModelStream| {
            body::<R>(&body_c, messages, Some(stream), &body_error, check.as_ref()).await
        };
        let model = called!(c.trace, demlik_tea::agent::model::streaming_model, callback);
        execute_agent(model, router, c, baseline, error).await
    }
}
async fn case(mode: &'static str, baseline: bool) -> Value {
    let c = control(mode);
    let router = Rc::new(tools::Router::new(definition(Rc::clone(&c))).unwrap());
    let owners = Rc::clone(&c);
    execute(
        mode,
        baseline,
        router,
        c,
        Rc::new(move |v, input| {
            let tools::Results::Lookup(value) = v else {
                panic!("actual result")
            };
            assert!(Rc::ptr_eq(value, &owners.results[input]));
            assert!(Rc::ptr_eq(&value.nested, &owners.results[input].nested));
        }),
    )
    .await
}
fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        for id in ["watched", "omitted", "plain-sink", "raw", "throwing", "late", "isolation", "resume", "provider-failure"]
            .into_iter()
            .filter(|id| std::env::args().find_map(|arg| arg.strip_prefix("--case=").map(str::to_owned)).is_none_or(|selected| selected == *id))
        {
            let actual = case(id, false).await;
            let baseline = case(id, true).await;
            let phases = actual["phases"].as_array().unwrap();
            let controls = baseline["phases"].as_array().unwrap();
            for (phase, plain) in phases.iter().zip(controls) {
                assert_eq!(phase["saveWires"], plain["saveWires"], "chunks never change saved state");
                assert_eq!(phase["finalWire"], plain["finalWire"]);
            }
            println!("{}", json!({"id":id,"phases":actual["phases"],"baseline":baseline["phases"],"nativeTrace":actual["nativeTrace"],"baselineTrace":baseline["nativeTrace"]}));
        }
    });
}
