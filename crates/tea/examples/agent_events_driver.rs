//! Fixture boundary for the frozen Source event/transcript workflows.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        Agent, AgentCompletion, AgentConfig, AgentEvents, AgentMachineError, AgentMachineMsg,
        AgentToolMsg, AgentWorkError, StateOf, create_agent,
        model::{Messages, NoMessages, plain_model},
        transcript::{Transcript, TranscriptSeed},
        types::{
            AgentEvent, AgentField, AgentTerminalFailure, AgentTurn, Conversation, ToolCall,
            TurnUsage,
        },
    },
    command::{CommandContractError, CommandEdge, CommandFamily, Outcome},
    data::JsText,
    llm_call::{self, LlmCall, LlmErr, LlmOk, Schema},
    resilience::{deadline::DeadlineExceeded, resilient_call::CallValue},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile, RuntimeError},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
};

#[derive(Deserialize)]
struct Input {
    id: String,
    #[serde(default = "pure_mode")]
    mode: String,
    #[serde(default = "usage_mode")]
    scenario: String,
    profile: Option<String>,
}
fn pure_mode() -> String {
    "pure".into()
}
fn usage_mode() -> String {
    "usage".into()
}
type Turn = AgentTurn;
struct Parser;
impl Schema for Parser {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = PlainData;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(value)
    }
}
struct Tool(Rc<ToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_io"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<PlainData>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(messages)
    }
}
type State = StateOf<JsText, JsText, Rc<PlainData>, Parser, PlainData, PlainData, PlainData, Turn>;
type Msg = AgentMachineMsg<JsText, Rc<PlainData>, Rc<Turn>, PlainData, AgentToolMsg<PlainData>>;
type Ending = AgentTerminalFailure<JsText, PlainData, LlmErr<JsText, PlainData>>;
type Event = AgentEvent<PlainData, Turn, Ending, PlainData>;
type Knob = Agent<
    'static,
    JsText,
    JsText,
    Rc<PlainData>,
    Parser,
    PlainData,
    PlainData,
    PlainData,
    Turn,
    PlainData,
    Tool,
>;
type Projection = AgentEvents<Turn>;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observed {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*);
        $calls.borrow_mut().push(stringify!($function)); value
    }};
}
fn data(value: Value) -> Rc<PlainData> {
    Rc::new(serde_json::from_value(value).unwrap())
}
fn value<T: serde::Serialize + ?Sized>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}
fn event(event: &Event) -> Value {
    match event {
        AgentEvent::BrainStarted {
            head,
            turn,
            purpose,
            model,
            payload,
        } => {
            json!({"type":"BrainStarted","runId":head.run_id,"at":head.at,"turn":turn,"purpose":purpose,"model":model,"payload":payload})
        }
        AgentEvent::TurnSettled { head, turn, usage } => {
            let mut out =
                json!({"type":"TurnSettled","runId":head.run_id,"at":head.at,"turn":turn});
            if let AgentField::Value(usage) = usage {
                out["usage"] = value(usage);
            }
            out
        }
        AgentEvent::ToolStarted {
            head,
            call_id,
            name,
            args,
        } => {
            json!({"type":"ToolStarted","runId":head.run_id,"at":head.at,"callId":call_id,"name":name,"args":args})
        }
        AgentEvent::ToolSettled {
            head,
            call_id,
            result,
        } => {
            json!({"type":"ToolSettled","runId":head.run_id,"at":head.at,"callId":call_id,"result":result})
        }
        AgentEvent::ToolFailed {
            head,
            call_id,
            name,
            failure,
        } => {
            json!({"type":"ToolFailed","runId":head.run_id,"at":head.at,"callId":call_id,"name":name,"failure":failure})
        }
        AgentEvent::RunDone { head, status } => {
            json!({"type":"RunDone","runId":head.run_id,"at":head.at,"status":status})
        }
    }
}
struct Fixture {
    payload: Rc<PlainData>,
    calls: Vec<Rc<ToolCall>>,
    turns: Vec<Rc<Turn>>,
    result: Rc<PlainData>,
    failure: Rc<PlainData>,
}
impl Fixture {
    fn new() -> Self {
        let calls = vec![
            Rc::new(ToolCall {
                call_id: "read-17".into(),
                name: "read".into(),
                args: data(json!({"relative":"invoice.txt","extra":"keep"})),
            }),
            Rc::new(ToolCall {
                call_id: "check-17".into(),
                name: "check".into(),
                args: data(json!({"expected":17,"extra":[1,2]})),
            }),
        ];
        let turns = vec![
            Rc::new(Turn::new(
                "collect invoice".into(),
                vec![Rc::clone(&calls[0])],
            )),
            Rc::new(Turn::new("collected".into(), vec![])),
            Rc::new(Turn::new(
                "check invoice".into(),
                vec![Rc::clone(&calls[1])],
            )),
            Rc::new(Turn::new("checked".into(), vec![])),
            Rc::new(Turn::new("invoice 17 is valid".into(), vec![])),
        ];
        Self {
            payload: data(json!({"invoiceId":"invoice-17","audit":{"revision":3}})),
            calls,
            turns,
            result: data(json!({"raw":"invoice=17\namount=17\n","total":17,"valid":true})),
            failure: data(
                json!({"kind":"error","reason":"invoice unavailable","_tag":"missing","data":{"file":"invoice.txt","code":17}}),
            ),
        }
    }
    fn agent(&self, retry: bool) -> Knob {
        let payload = Rc::clone(&self.payload);
        let llm = Rc::new(
            LlmCall::new(
                llm_call::Config::new(|_: &JsText| Rc::new(Parser)),
                |_: &PlainData| Ok("rejected".into()),
            )
            .with_rng(|| 0.0),
        );
        let config = AgentConfig::new(
            llm,
            ["collect", "check", "summarize"]
                .into_iter()
                .map(|s| Rc::new(s.into()))
                .collect(),
            |_| JsText::from("invoice"),
            |call| Tool(Rc::clone(call)),
            move |_, _: &Rc<Conversation<PlainData>>, _| Rc::clone(&payload),
            |turn| turn,
        );
        let config = if retry {
            config.tool_resilience_of(|_| {
                Some(
                    demlik_tea::agent::ToolResilience::default().retry(RetryPolicy {
                        curve: BackoffCurve {
                            base_ms: 10.0,
                            factor: 2.0,
                            cap_ms: 100.0,
                            jitter: Jitter::Full,
                        },
                        budget: CountBound { max_attempts: 2.0 },
                    }),
                )
            })
        } else {
            config
        };
        create_agent(config)
    }
}
fn projected(project: &Projection, message: &Msg, state: &Rc<State>, calls: &Calls) -> Vec<Event> {
    observed!(
        calls,
        demlik_tea::agent::AgentEvents::project,
        project,
        message,
        state
    )
    .unwrap()
}
fn pure(input: &Input, calls: &Calls) -> Value {
    let fixture = Fixture::new();
    let agent = fixture.agent(input.scenario == "retry");
    let project = observed!(calls, demlik_tea::agent::agent_events, |turn: &Turn| turn);
    let initial = agent.init();
    let start = Msg::Start {
        run_id: "invoice-run".into(),
        at: 11.0,
    };
    let boot = Msg::Boot { at: 12.0 };
    let started = agent.start(&initial, "invoice-run", 11.0).unwrap().state;
    let pending = agent
        .turn(&started, Rc::clone(&fixture.turns[0]), 13.0)
        .unwrap()
        .state;
    let ok = Msg::Tool(AgentToolMsg::Ok {
        call_id: "read-17".into(),
        result: Rc::clone(&fixture.result),
        at: 17.0,
    });
    let err = Msg::Tool(AgentToolMsg::Err {
        call_id: "read-17".into(),
        reason: "invoice unavailable".into(),
        at: 17.0,
    });
    let mut batches = Vec::new();
    let mut checks = json!({});
    match input.scenario.as_str() {
        "idle" => batches.push(projected(&project, &start, &initial, calls)),
        "outbox" => {
            let first = projected(&project, &start, &started, calls);
            let embedded = projected(&project, &boot, &started, calls);
            let next = agent.boot(&started, 19.0).unwrap().state;
            let fresh = projected(&project, &Msg::Boot { at: 19.0 }, &next, calls);
            checks = json!({"payloadChecks":first.iter().chain(&fresh).filter(|e|matches!(e,AgentEvent::BrainStarted{..})).count(),"payloadSame":first.iter().chain(&fresh).all(|e|matches!(e,AgentEvent::BrainStarted {payload,..} if Rc::ptr_eq(payload,&fixture.payload))),"freshOutbox":!Rc::ptr_eq(started.lifecycle.value().unwrap(),next.lifecycle.value().unwrap())});
            batches.extend([first, embedded, fresh]);
        }
        "direct" => {
            let next = agent
                .tool_ok(&pending, "read-17", Rc::clone(&fixture.result), 17.0)
                .unwrap()
                .state;
            let first = projected(&project, &ok, &next, calls);
            let second = projected(&project, &ok, &next, calls);
            checks = json!({"resultChecks":first.iter().chain(&second).filter(|e|matches!(e,AgentEvent::ToolSettled{..})).count(),"resultSame":first.iter().chain(&second).filter_map(|e|if let AgentEvent::ToolSettled{result,..}=e {Some(result)}else{None}).all(|r|Rc::ptr_eq(r,&fixture.result))});
            batches.extend([first, second]);
        }
        "refused" => {
            let next = agent
                .tool_err(&pending, "read-17", Rc::clone(&fixture.failure), 17.0)
                .unwrap()
                .state;
            let first = projected(&project, &err, &next, calls);
            let late = projected(&project, &ok, &next, calls);
            checks = json!({"failureChecks":first.iter().filter(|e|matches!(e,AgentEvent::ToolFailed{..})).count(),"failureSame":first.iter().any(|e|matches!(e,AgentEvent::ToolFailed{failure,..}if Rc::ptr_eq(failure,&fixture.failure)))});
            batches.extend([first, late]);
        }
        "cancel" => {
            let next = agent.cancel(&pending, 21.0).unwrap().state;
            let cancel = Msg::Cancel { at: 21.0 };
            batches.extend([
                projected(&project, &cancel, &next, calls),
                projected(&project, &cancel, &next, calls),
                projected(&project, &ok, &next, calls),
            ]);
        }
        "retry" => {
            let waiting = agent
                .tool_err(&pending, "read-17", Rc::clone(&fixture.failure), 17.0)
                .unwrap()
                .state;
            let first = projected(&project, &err, &waiting, calls);
            let timer = agent
                .subs(&waiting)
                .unwrap()
                .into_iter()
                .find(|t| {
                    t.id.as_units()
                        .starts_with(&"resilient:retry:$tool:".encode_utf16().collect::<Vec<_>>())
                })
                .unwrap();
            let timer = DeadlineExceeded {
                kind: "deadline_exceeded".into(),
                id: timer.id,
                at_ms: 18.0.into(),
            };
            let running = agent.on_timer(&waiting, &timer).unwrap().state;
            let retried = projected(&project, &Msg::Deadline(timer), &running, calls);
            let ended = agent
                .tool_err(&running, "read-17", Rc::clone(&fixture.failure), 19.0)
                .unwrap()
                .state;
            let final_events = projected(
                &project,
                &Msg::Tool(AgentToolMsg::Err {
                    call_id: "read-17".into(),
                    reason: "invoice unavailable".into(),
                    at: 19.0,
                }),
                &ended,
                calls,
            );
            checks = json!({"finalFailureChecks":final_events.iter().filter(|e|matches!(e,AgentEvent::ToolFailed{..})).count(),"exhaustedTag":final_events.iter().any(|e|if let AgentEvent::ToolFailed{failure,..}=e {value(failure)["_tag"]=="retry_exhausted"}else{false})});
            batches.extend([first, retried, final_events]);
        }
        "usage" => {
            let usage = Rc::new(TurnUsage {
                input_tokens: 17.0.into(),
                output_tokens: 5.0.into(),
                reasoning_tokens: AgentField::Value(2.0.into()),
                cached_input_tokens: AgentField::Value(3.0.into()),
            });
            let mut turn = Turn::new("invoice checked".into(), vec![]);
            turn.usage = AgentField::Value(Rc::clone(&usage));
            let turn = Rc::new(turn);
            // One-stage receipt matches the separately frozen usage supplement.
            let llm = Rc::new(LlmCall::new(
                llm_call::Config::new(|_: &JsText| Rc::new(Parser)),
                |_: &PlainData| Ok("rejected".into()),
            ));
            let payload = Rc::clone(&fixture.payload);
            let agent = create_agent(AgentConfig::new(
                llm,
                vec![Rc::new(JsText::from("only"))],
                |_| JsText::from("invoice"),
                |call| Tool(Rc::clone(call)),
                move |_, _: &Rc<Conversation<PlainData>>, _| Rc::clone(&payload),
                |turn| turn,
            ));
            let mut start = agent.start(&agent.init(), "invoice-usage", 11.0).unwrap();
            let message = start
                .commands
                .pop()
                .unwrap()
                .settle_in(
                    AgentCompletion::Brain(Some(Outcome::ok(CallValue::value(LlmOk {
                        key: "invoice".into(),
                        purpose: JsText::from("invoice"),
                        output: Rc::clone(&turn),
                    })))),
                    &CommandEdge::new(|| 17.0),
                )
                .unwrap()
                .pop()
                .unwrap();
            let Msg::Brain(brain) = &message else {
                unreachable!()
            };
            let next = agent.succeed(&start.state, brain, 17.0).unwrap().state;
            let events = projected(&project, &message, &next, calls);
            let collector = Transcript::new();
            for e in &events {
                collector.on_event(e)
            }
            let original=events.iter().any(|e|matches!(e,AgentEvent::TurnSettled{usage:AgentField::Value(v),..}if Rc::ptr_eq(v,&usage)));
            return json!({"events":events.iter().map(event).collect::<Vec<_>>(),"transcript":collector.read(),"checks":{"usageChecks":1,"usageSame":original,"turnChecks":1,"turnSame":events.iter().any(|e|matches!(e,AgentEvent::TurnSettled{turn:t,..}if Rc::ptr_eq(t,&turn))),"transcriptUsageChecks":1,"transcriptUsageSame":Rc::ptr_eq(collector.read().turns[0].usage.value().unwrap(),&usage)}});
        }
        _ => panic!("unknown pure scenario"),
    }
    json!({"batches":batches.iter().map(|b|b.iter().map(event).collect::<Vec<_>>()).collect::<Vec<_>>(),"checks":checks})
}

struct HostCause {
    message: &'static str,
}
struct SaveFailure(Rc<HostCause>);
impl fmt::Debug for SaveFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.message)
    }
}
impl fmt::Display for SaveFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.message)
    }
}
struct CallbackCause {
    message: &'static str,
}
struct Context {
    fixture: Fixture,
    scenario: String,
    directory: PathBuf,
    models: Cell<usize>,
    tools: Cell<usize>,
    saves: Cell<usize>,
    log: RefCell<Vec<Value>>,
    events: RefCell<Vec<Value>>,
    project_inputs: RefCell<Vec<Value>>,
    checks: RefCell<Value>,
    reports: RefCell<Vec<Value>>,
    save_cause: Rc<HostCause>,
    callback_cause: Arc<CallbackCause>,
    thrown: Cell<bool>,
    trace: Calls,
}
impl Context {
    fn push(&self, value: Value) {
        self.log.borrow_mut().push(value)
    }
}
struct Saved {
    ctx: Rc<Context>,
    loaded: Option<Rc<State>>,
}
impl Store<Rc<State>> for Saved {
    type Raw = Option<Rc<State>>;
    type Error = SaveFailure;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.loaded.clone())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Rc<State>> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
    async fn save(&self, state: &Rc<State>) -> Result<(), Self::Error> {
        let n = self.ctx.saves.get() + 1;
        self.ctx.saves.set(n);
        self.ctx.push(json!(["save", n, state.run.phase.as_str()]));
        if self.ctx.scenario == "save" && n == 2 {
            Err(SaveFailure(Rc::clone(&self.ctx.save_cause)))
        } else {
            Ok(())
        }
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
            self.0.tools.set(self.0.tools.get() + 1);
            self.0.push(json!(["tool", cmd.0.call_id]));
            let raw = std::fs::read_to_string(self.0.directory.join("invoice.txt"))
                .map_err(AgentWorkError::Tool)?;
            assert_eq!(raw, "invoice=17\namount=17\n");
            if cmd.0.name.as_utf8() == Some("check") {
                std::fs::write(self.0.directory.join("checked.txt"), "invoice=17:valid\n")
                    .map_err(AgentWorkError::Tool)?;
            }
            Ok(vec![AgentToolMsg::Ok {
                call_id: cmd.0.call_id.clone(),
                result: Rc::clone(&self.0.fixture.result),
                at: 51.0,
            }])
        }))
    }
}
#[expect(
    clippy::result_large_err,
    reason = "The fixture keeps event projection and reduction in the real machine's canonical AgentMachineError channel."
)]
async fn runtime_case(
    input: &Input,
    directory: PathBuf,
    calls: &Calls,
    causes: &Rc<RefCell<Vec<Value>>>,
) -> Value {
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("invoice.txt"), "invoice=17\namount=17\n").unwrap();
    let ctx = Rc::new(Context {
        fixture: Fixture::new(),
        scenario: input.scenario.clone(),
        directory,
        models: Cell::new(usize::from(input.scenario == "resume")),
        tools: Cell::new(0),
        saves: Cell::new(0),
        log: RefCell::new(vec![]),
        events: RefCell::new(vec![]),
        project_inputs: RefCell::new(vec![]),
        checks: RefCell::new(
            json!({"turnChecks":0,"originalTurns":true,"resultChecks":0,"originalResults":true,"argsChecks":0,"originalArgs":true,"payloadChecks":0,"originalPayloads":true,"callbackCauseSame":true}),
        ),
        reports: RefCell::new(vec![]),
        save_cause: Rc::new(HostCause {
            message: "invoice checkpoint refused",
        }),
        callback_cause: Arc::new(CallbackCause {
            message: "invoice event listener failed",
        }),
        thrown: Cell::new(false),
        trace: Rc::clone(calls),
    });
    let agent = Rc::new(ctx.fixture.agent(false));
    let loaded = if input.scenario == "resume" {
        let started = agent.start(&agent.init(), "invoice-run", 11.0).unwrap();
        Some(
            agent
                .turn(&started.state, Rc::clone(&ctx.fixture.turns[0]), 13.0)
                .unwrap()
                .state,
        )
    } else {
        None
    };
    let collector = Transcript::from_seed(TranscriptSeed {
        conversation: loaded.as_ref().and_then(|s| s.conversation.as_deref()),
    });
    let invoked = Rc::clone(&ctx);
    let model = plain_model(
        async move |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<PlainData>> {
            let n = invoked.models.get();
            invoked.models.set(n + 1);
            let turn = Rc::clone(invoked.fixture.turns.get(n).expect("finite model script"));
            invoked.push(json!(["model", turn.content]));
            Ok(turn)
        },
    );
    let wired = Rc::clone(&agent).to_machine(
        model,
        NoMessages,
        Tools(Rc::clone(&ctx)),
        Rc::new(TokioTimer::with_clock(|| 50.0, |_| {})),
    );
    let projector = observed!(calls, demlik_tea::agent::agent_events, |turn: &Turn| turn);
    let projecting = Rc::clone(&ctx);
    let options = Options::new(if input.profile.as_deref() == Some("effect") {
        Profile::Effect
    } else {
        Profile::Promise
    });
    let mut options = observed!(
        calls,
        demlik_tea::runtime::Options::with_checked_events,
        options,
        move |message: &Msg, state: &Rc<State>| {
            projecting.project_inputs.borrow_mut().push(json!([
                message.tag(),
                state.lifecycle.value().map_or_else(Vec::new, |notes| notes
                    .iter()
                    .map(|n| match n.as_ref() {
                        demlik_tea::agent::types::AgentLifecycleNote::BrainStarted { .. } =>
                            "brain_started",
                        demlik_tea::agent::types::AgentLifecycleNote::ToolStarted { .. } =>
                            "tool_started",
                        demlik_tea::agent::types::AgentLifecycleNote::ToolFailed { .. } =>
                            "tool_failed",
                        demlik_tea::agent::types::AgentLifecycleNote::RunEnded { .. } =>
                            "run_ended",
                    })
                    .collect())
            ]));
            observed!(
                &projecting.trace,
                demlik_tea::agent::AgentEvents::project,
                &projector,
                message,
                state
            )
            .map_err(AgentMachineError::from)
        }
    );
    options.store = Some(runtime::Persistence::new(Saved {
        ctx: Rc::clone(&ctx),
        loaded: loaded.clone(),
    }));
    let terminal = Rc::clone(&agent);
    options.terminal = Some(Rc::new(move |s| terminal.is_settled(s)));
    options.clock = Rc::new(|| 50.0);
    let reported = Rc::clone(&ctx);
    let reported_causes = Rc::clone(causes);
    options.on_error = Some(Rc::new(move |error, phase| {
        let same = match error {
            RuntimeError::Panic(cause) => cause.with_payload(|p| {
                if let Some(actual) = p.downcast_ref::<Arc<CallbackCause>>() {
                    let same = Arc::ptr_eq(actual, &reported.callback_cause);
                    reported_causes.borrow_mut().push(
                        json!({"channel":"callback","originalSame":same,"message":actual.message}),
                    );
                    same && actual.message == "invoice event listener failed"
                } else {
                    false
                }
            }),
            _ => false,
        };
        reported.checks.borrow_mut()["callbackCauseSame"] = json!(same);
        reported.reports.borrow_mut().push(json!({"phase":phase,"error":{"name":error.name(),"message":match error{RuntimeError::Panic(cause)=>cause.summary.clone(),_=>format!("{error}")}}}));
        reported.push(json!(["report", phase]));
    }));
    let run = observed!(
        calls,
        demlik_tea::runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        options
    );
    run.ready().await.unwrap();
    let ready_no_events = ctx.events.borrow().is_empty() && ctx.project_inputs.borrow().is_empty();
    let ready = run.get_state().unwrap();
    let retained = loaded.as_ref().map_or(json!("not-applicable"), |s| {
        json!(Rc::ptr_eq(ready.as_ref(), s))
    });
    let booted = Rc::clone(&ctx);
    let _boot = run.on_boot(move |state| booted.push(json!(["boot", state.run.phase.as_str()])));
    let changed = Rc::clone(&ctx);
    let _change = run.subscribe(move || changed.push(json!(["change"])));
    let observed = Rc::clone(&ctx);
    let _observe = run.observe(move |msg, _| observed.push(json!(["observe", msg.tag()])));
    let off = run.on(
        "TurnSettled",
        Rc::new(|_: &Event| panic!("unsubscribed callback must not run")),
    );
    off();
    let throwing = Rc::clone(&ctx);
    let _throw = run.on(
        "TurnSettled",
        Rc::new(move |_: &Event| {
            if throwing.scenario == "listener" && !throwing.thrown.replace(true) {
                std::panic::panic_any(Arc::clone(&throwing.callback_cause));
            }
        }),
    );
    let mut detach = vec![];
    for tag in demlik_tea::agent::types::AGENT_EVENT_TYPES {
        let recording = Rc::clone(&ctx);
        let collected = collector.clone();
        detach.push(run.on(
            tag,
            Rc::new(move |e: &Event| {
                if let Some((count, same, ok)) = match e {
                    AgentEvent::TurnSettled { turn, .. } => Some((
                        "turnChecks",
                        "originalTurns",
                        recording.fixture.turns.iter().any(|t| Rc::ptr_eq(t, turn)),
                    )),
                    AgentEvent::ToolSettled { result, .. } => Some((
                        "resultChecks",
                        "originalResults",
                        Rc::ptr_eq(result, &recording.fixture.result),
                    )),
                    AgentEvent::ToolStarted { args, .. } => Some((
                        "argsChecks",
                        "originalArgs",
                        recording
                            .fixture
                            .calls
                            .iter()
                            .any(|c| Rc::ptr_eq(&c.args, args)),
                    )),
                    AgentEvent::BrainStarted { payload, .. } => Some((
                        "payloadChecks",
                        "originalPayloads",
                        Rc::ptr_eq(payload, &recording.fixture.payload),
                    )),
                    _ => None,
                } {
                    let mut checks = recording.checks.borrow_mut();
                    checks[count] = json!(checks[count].as_u64().unwrap() + 1);
                    checks[same] = json!(checks[same].as_bool().unwrap() && ok);
                }
                recording.events.borrow_mut().push(event(e));
                recording.push(json!(["event", e.tag()]));
                observed!(
                    &recording.trace,
                    demlik_tea::agent::transcript::Transcript::on_event,
                    &collected,
                    e
                );
            }),
        ));
    }
    let answer = run
        .dispatch(if loaded.is_some() {
            Msg::Boot { at: 15.0 }
        } else {
            Msg::Start {
                run_id: "invoice-run".into(),
                at: 11.0,
            }
        })
        .await;
    let dispatch_same = match &answer {
        Ok(()) => json!("not-applicable"),
        Err(error) => json!(match error.as_ref() {
            RuntimeError::Save(actual) => {
                let same = Rc::ptr_eq(&actual.0, &ctx.save_cause);
                causes.borrow_mut().push(
                    json!({"channel":"store","originalSame":same,"message":actual.0.message}),
                );
                same && actual.0.message == "invoice checkpoint refused"
            }
            _ => false,
        }),
    };
    let dispatch_error = answer.err().map_or(
        Value::Null,
        |error| json!({"name":error.name(),"message":format!("{error}")}),
    );
    let state = run.get_state().unwrap();
    let mut checks = ctx.checks.borrow().clone();
    checks["readyNoEvents"] = json!(ready_no_events);
    checks["retainedReadySame"] = retained;
    checks["dispatchCauseSame"] = dispatch_same;
    let saves = ctx.saves.get();
    run.stop().await;
    for off in detach {
        off()
    }
    json!({"stopSaves":ctx.saves.get()-saves,"ready":ready.as_ref(),"state":state.as_ref(),"events":*ctx.events.borrow(),"transcript":collector.read(),"log":*ctx.log.borrow(),"projectInputs":*ctx.project_inputs.borrow(),"models":ctx.models.get(),"tools":ctx.tools.get(),"transitionSaves":saves,"checks":checks,"reports":*ctx.reports.borrow(),"dispatchError":dispatch_error})
}
fn main() {
    let original: Value = serde_json::from_str(&std::env::args().nth(1).unwrap()).unwrap();
    let input: Input = serde_json::from_value(original.clone()).unwrap();
    let calls = Rc::new(RefCell::new(vec![]));
    let causes = Rc::new(RefCell::new(Vec::new()));
    let panic_hooks = Arc::new(Mutex::new(Vec::new()));
    let hook = Arc::clone(&panic_hooks);
    std::panic::set_hook(Box::new(move |info| {
        hook.lock().unwrap().push(info.to_string())
    }));
    let output = if input.mode == "pure" {
        pure(&input, &calls)
    } else {
        let host = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(
            &host,
            runtime_case(
                &input,
                PathBuf::from(std::env::args().nth(2).unwrap()),
                &calls,
                &causes,
            ),
        )
    };
    println!(
        "{}",
        json!({"input":original,"output":output,"nativeTrace":*calls.borrow(),"nativeOnly":{"panicHooks":*panic_hooks.lock().unwrap(),"id":input.id,"causes":*causes.borrow()}})
    );
}

#[cfg(test)]
mod checks {
    use super::*;
    use demlik_tea::agent::agent_events;
    use demlik_tea::{
        Machine, Step, Sub, TryUpdate,
        core::Message,
        runtime::{ErrorPhase, NoEvent, NoInterpreter, NoSubscriptions},
    };
    use std::convert::Infallible;

    struct RoutedReads {
        outcomes: Cell<usize>,
        times: Cell<usize>,
    }
    impl demlik_tea::agent::tool::AgentToolRoutes<Tool, PlainData, PlainData> for RoutedReads {
        fn settlement_types(&self) -> Vec<String> {
            vec!["agent_tool_ok".into(), "agent_tool_err".into()]
        }
        fn outcome_of(
            &self,
            message: &AgentToolMsg<PlainData>,
        ) -> Result<
            Option<demlik_tea::agent::tool::ToolSettlement<PlainData, PlainData>>,
            CommandContractError,
        > {
            self.outcomes.set(self.outcomes.get() + 1);
            let (call_id, outcome) = match message {
                AgentToolMsg::Ok {
                    call_id, result, ..
                } => (
                    call_id,
                    demlik_tea::agent::types::ToolOutcome::Ok(Rc::clone(result)),
                ),
                AgentToolMsg::Err {
                    call_id, reason, ..
                } => (
                    call_id,
                    demlik_tea::agent::types::ToolOutcome::Error(data(json!({"reason":reason}))),
                ),
            };
            Ok(Some(demlik_tea::agent::tool::ToolSettlement {
                call_id: call_id.clone(),
                outcome,
            }))
        }
        fn at(&self, message: &AgentToolMsg<PlainData>) -> Option<demlik_tea::data::NumberOrNull> {
            self.times.set(self.times.get() + 1);
            Some(match message {
                AgentToolMsg::Ok { at, .. } | AgentToolMsg::Err { at, .. } => (*at).into(),
            })
        }
    }
    #[test]
    fn routed_late_settlements_use_the_message_owner_and_obey_event_admission() {
        let fixture = Fixture::new();
        let agent = fixture.agent(false);
        let initial = agent.init();
        let started = agent.start(&initial, "invoice-run", 11.0).unwrap().state;
        let pending = agent
            .turn(&started, Rc::clone(&fixture.turns[0]), 13.0)
            .unwrap()
            .state;
        let settled = agent
            .tool_ok(&pending, "read-17", Rc::clone(&fixture.result), 17.0)
            .unwrap()
            .state;
        let late = data(json!({"late":"actual new result"}));
        let message = Msg::Tool(AgentToolMsg::Ok {
            call_id: "read-17".into(),
            result: Rc::clone(&late),
            at: 19.0,
        });
        let routes = RoutedReads {
            outcomes: Cell::new(0),
            times: Cell::new(0),
        };
        let projector = agent_events(|turn: &Turn| turn);
        let events = projector
            .project_routed::<_, _, _, _, _, _, _, _, _, _, _, Tool, _>(&message, &settled, &routes)
            .unwrap();
        assert!(events.iter().any(|event|matches!(event,AgentEvent::ToolSettled{result,..}if Rc::ptr_eq(result,&late))),"late success must expose the actual message result, not the earlier durable receipt");
        let error = Msg::Tool(AgentToolMsg::Err {
            call_id: "read-17".into(),
            reason: "late failure".into(),
            at: 20.0,
        });
        let events = projector
            .project_routed::<_, _, _, _, _, _, _, _, _, _, _, Tool, _>(&error, &settled, &routes)
            .unwrap();
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, AgentEvent::ToolSettled { .. })),
            "late failure cannot be turned into a stored success"
        );
        let cancelled = agent.cancel(&settled, 21.0).unwrap().state;
        let before = routes.outcomes.get();
        projector
            .project_routed::<_, _, _, _, _, _, _, _, _, _, _, Tool, _>(&message, &initial, &routes)
            .unwrap();
        projector
            .project_routed::<_, _, _, _, _, _, _, _, _, _, _, Tool, _>(
                &message, &cancelled, &routes,
            )
            .unwrap();
        assert_eq!(
            routes.outcomes.get(),
            before,
            "idle and cancelled event paths must not read the router"
        );
        let mut refused = settled.as_ref().clone();
        refused.refused_calls = AgentField::Value(Rc::new(vec!["read-17".into()]));
        let time_reads = routes.times.get();
        let events = projector
            .project_routed::<_, _, _, _, _, _, _, _, _, _, _, Tool, _>(&message, &refused, &routes)
            .unwrap();
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, AgentEvent::ToolSettled { .. }))
        );
        assert_eq!(
            routes.times.get(),
            time_reads,
            "a refused completion must not read the settlement timestamp"
        );
    }

    enum Signal {
        Reject,
        Publish,
    }
    impl Tagged for Signal {
        fn tag(&self) -> &str {
            match self {
                Self::Reject => "reject",
                Self::Publish => "publish",
            }
        }
    }
    impl Message for Signal {
        const TYPES: &'static [&'static str] = &["reject", "publish"];
    }
    enum Never {}
    impl Tagged for Never {
        fn tag(&self) -> &str {
            match *self {}
        }
    }
    impl CommandFamily for Never {
        type Msg = Signal;
        type Completion = Vec<Signal>;
        fn settle(self, _: Vec<Signal>, _: f64) -> Result<Vec<Signal>, CommandContractError> {
            match self {}
        }
    }
    struct Pulse(u8);
    impl Tagged for Pulse {
        fn tag(&self) -> &str {
            "pulse"
        }
    }
    struct RichCause(Rc<Cell<u8>>); // no Clone/Debug/serde/Send

    #[tokio::test(flavor = "current_thread")]
    async fn checked_failure_keeps_original_cause_and_no_partial_events_then_publishes_whole_batch()
    {
        tokio::task::LocalSet::new()
            .run_until(async {
                for profile in [Profile::Promise, Profile::Effect] {
                    let cause = Rc::new(RichCause(Rc::new(Cell::new(17))));
                    let original = Rc::clone(&cause);
                    let machine: Machine<'static, u8, Signal, Never, Sub<()>, (), Rc<RichCause>> =
                        Machine {
                            init: Box::new(|saved, _| Step::new(saved.unwrap_or(0), vec![])),
                            update: TryUpdate::try_reducer(|state: &u8, _: &Signal| {
                                Ok(Step::new(state + 1, vec![]))
                            }),
                            subscriptions: demlik_tea::core::try_subscriptions(|_| Ok(vec![])),
                        };
                    let prepared = Rc::new(Cell::new(0));
                    let preparing = Rc::clone(&prepared);
                    let options: Options<
                        u8,
                        Signal,
                        Infallible,
                        Infallible,
                        NoEvent,
                        Rc<RichCause>,
                    > = Options::new(profile);
                    let mut options = options.with_checked_events(move |msg, _| {
                        let batch = vec![Pulse(1), Pulse(2)];
                        preparing.set(batch.len());
                        if matches!(msg, Signal::Reject) {
                            Err(Rc::clone(&cause))
                        } else {
                            Ok(batch)
                        }
                    });
                    let reported = Rc::new(RefCell::new(vec![]));
                    let errors = Rc::clone(&reported);
                    options.on_error = Some(Rc::new(move |error, phase| {
                        assert_eq!(phase, ErrorPhase::Event);
                        let RuntimeError::EventProjection(cause) = error else {
                            panic!("checked event error channel")
                        };
                        errors.borrow_mut().push(Rc::clone(cause));
                    }));
                    let run = runtime::try_launch(
                        machine,
                        (),
                        NoInterpreter::new(),
                        NoSubscriptions::new(),
                        options,
                    );
                    assert!(run.ready().await.is_ok());
                    let delivered = Rc::new(RefCell::new(vec![]));
                    let events = Rc::clone(&delivered);
                    let off = run.on(
                        "pulse",
                        Rc::new(move |event: &Pulse| {
                            assert_eq!(prepared.get(), 2, "whole Vec exists before fanout");
                            events.borrow_mut().push(event.0);
                        }),
                    );
                    assert!(run.dispatch(Signal::Reject).await.is_ok());
                    assert!(delivered.borrow().is_empty());
                    assert_eq!(**run.get_state().as_ref().unwrap(), 1);
                    assert_eq!(reported.borrow().len(), 1);
                    assert!(Rc::ptr_eq(&reported.borrow()[0], &original));
                    assert_eq!(reported.borrow()[0].0.get(), 17);
                    assert!(run.dispatch(Signal::Publish).await.is_ok());
                    assert_eq!(*delivered.borrow(), [1, 2]);
                    off();
                    run.stop().await;
                }
            })
            .await;
    }

    #[test]
    fn failed_note_marks_original_outbox_before_reading_and_keeps_no_strong_owner() {
        use demlik_tea::agent::{AgentError, AgentEventReadError, types::AgentLifecycleNote};
        let fixture = Fixture::new();
        let agent = fixture.agent(false);
        let started = agent.start(&agent.init(), "r", 1.0).unwrap().state;
        let notes = Rc::new(vec![
            Rc::new(AgentLifecycleNote::ToolStarted {
                call: Rc::clone(&fixture.calls[0]),
                at: 1.0.into(),
            }),
            Rc::new(AgentLifecycleNote::BrainStarted {
                turn: 0.0.into(),
                purpose: "missing-purpose".into(),
                model: None,
                at: 1.0.into(),
            }),
        ]);
        let weak = Rc::downgrade(&notes);
        let mut state = started.as_ref().clone();
        state.lifecycle = AgentField::Value(Rc::clone(&notes));
        let state = Rc::new(state);
        let projector = agent_events(|turn: &Turn| turn);
        let message: Msg = Msg::Start {
            run_id: "r".into(),
            at: 1.0,
        };
        assert!(matches!(
            projector.project(&message, &state),
            Err(AgentError::EventRead(
                AgentEventReadError::MissingPayload { .. }
            ))
        ));
        assert!(
            projector.project(&message, &state).unwrap().is_empty(),
            "no partial first ToolStarted can be delivered after failure"
        );
        assert_eq!(Rc::strong_count(&notes), 2, "projector keeps only Weak");
        drop(state);
        drop(notes);
        assert!(weak.upgrade().is_none());
    }

    struct ReentrantTurn {
        native: Turn,
        before_read: RefCell<Option<Box<dyn Fn()>>>,
    }
    fn reentrant_view(turn: &ReentrantTurn) -> &Turn {
        let callback = turn.before_read.borrow_mut().take();
        if let Some(callback) = callback {
            callback()
        }
        &turn.native
    }
    struct ReentrantParser;
    impl Schema for ReentrantParser {
        type Raw = Rc<ReentrantTurn>;
        type Output = Self::Raw;
        type Error = PlainData;
        fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
            Ok(value)
        }
    }
    #[test]
    fn caller_turn_reader_reenters_same_projector_without_registry_borrow() {
        let payload = data(json!({"loan":"original"}));
        let llm = Rc::new(LlmCall::new(
            llm_call::Config::new(|_: &JsText| Rc::new(ReentrantParser)),
            |_: &PlainData| Ok("refused".into()),
        ));
        let agent = create_agent(AgentConfig::new(
            llm,
            vec![Rc::new(JsText::from("only"))],
            |_| JsText::from("invoice"),
            |call| Tool(Rc::clone(call)),
            move |_, _: &Rc<Conversation<PlainData, ReentrantTurn>>, _| Rc::clone(&payload),
            reentrant_view,
        ));
        let projector = Rc::new(agent_events(reentrant_view));
        let mut started = agent.start(&agent.init(), "r", 1.0).unwrap();
        let turn = Rc::new(ReentrantTurn {
            native: Turn::new("done".into(), vec![]),
            before_read: RefCell::new(None),
        });
        let message = started
            .commands
            .pop()
            .unwrap()
            .settle_in(
                AgentCompletion::Brain(Some(Outcome::ok(CallValue::value(LlmOk {
                    key: "invoice".into(),
                    purpose: JsText::from("invoice"),
                    output: Rc::clone(&turn),
                })))),
                &CommandEdge::new(|| 2.0),
            )
            .unwrap()
            .pop()
            .unwrap();
        let AgentMachineMsg::Brain(brain) = &message else {
            unreachable!()
        };
        let next = agent.succeed(&started.state, brain, 2.0).unwrap();
        let read = Rc::new(Cell::new(0));
        let entered = Rc::clone(&read);
        let inner = Rc::clone(&projector);
        let state = Rc::clone(&started.state);
        turn.before_read.replace(Some(Box::new(move || {
            let start: AgentMachineMsg<
                JsText,
                Rc<PlainData>,
                Rc<ReentrantTurn>,
                PlainData,
                AgentToolMsg<PlainData>,
            > = AgentMachineMsg::Start {
                run_id: "r".into(),
                at: 1.0,
            };
            let events = inner.project(&start, &state).unwrap();
            entered.set(events.len());
        })));
        let events = projector.project(&message, &next.state).unwrap();
        assert_eq!(read.get(), 1);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::TurnSettled { .. }));
    }
}
