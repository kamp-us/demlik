//! Public tool policies over the existing durable ladder and timer subscriptions.
use demlik_tea::retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy};
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        DefinedAgentRunOptions, DefinedAgentState, DefinedAgentTools, PlainToolArgs,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::{self, ErrorFamily, Raised, ToolDefinition, ToolSpec},
        tool_resilience::ToolResilience,
        types::ToolOutcome,
    },
    command::{Outcome, SchemaError},
    data::decode_json,
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    storage::{Migrated, Store},
};
use futures::FutureExt;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};
demlik_tea::tool_router! {mod tools {Policy(policy),Plain(plain)}}
macro_rules! called {($trace:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let value=$function($($argument),*);$trace.borrow_mut().push(stringify!($function));value}};}
struct Args {
    raw: Rc<PlainToolArgs>,
    index: usize,
}
impl Serialize for Args {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.raw.value().serialize(s)
    }
}
struct Input {
    reject: bool,
}
impl Schema for Input {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<Args>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        if self.reject {
            return Err(CallValue::value(SchemaError::Issues(vec![
                demlik_tea::command::Issue::new("", "invalid"),
            ])));
        }
        let value = serde_json::to_value(raw.value()).unwrap();
        Ok(Rc::new(Args {
            index: value["index"].as_u64().unwrap() as usize,
            raw,
        }))
    }
}
#[derive(Serialize)]
struct ResultValue {
    index: usize,
    attempt: usize,
    nested: Rc<Value>,
}
struct Identity;
impl Schema for Identity {
    type Raw = Rc<ResultValue>;
    type Output = Rc<ResultValue>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
struct Busy;
impl Tagged for Busy {
    fn tag(&self) -> &str {
        "busy"
    }
}
struct Control {
    at: Rc<Cell<f64>>,
    id: &'static str,
    log: RefCell<Vec<Value>>,
    active: Cell<usize>,
    max: Cell<usize>,
    attempts: RefCell<Vec<usize>>,
    turn: Rc<PlainData>,
    results: Vec<Rc<ResultValue>>,
    error: Rc<Busy>,
}
fn definition(
    name: &'static str,
    configured: bool,
    c: Rc<Control>,
) -> Rc<
    impl ToolDefinition<
        Host = (),
        RawArgs = PlainToolArgs,
        Args = Args,
        RawResult = Rc<ResultValue>,
        Ok = ResultValue,
        Error = Busy,
        Thrown = (),
        ContentError = Infallible,
    >,
> {
    let mut spec = ToolSpec::new(
        Rc::new(Input {
            reject: c.id == "malformed-retry",
        }),
        Rc::new(Identity),
        ErrorFamily::new(["busy"], |_: &Busy| {
            Ok(decode_json(r#"{"_tag":"busy"}"#).unwrap())
        }),
    )
    .raised::<()>();
    if configured && !c.id.starts_with("free") && c.id != "bare-failure" {
        let mut policy = ToolResilience::default();
        if c.id.starts_with("timeout") {
            policy = policy.timeout_ms(if c.id == "timeout-retries" {
                18.0
            } else {
                10.0
            });
        }
        if !matches!(c.id, "timeout-late" | "timeout-serial") {
            policy = policy.retry(RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 5.0,
                    factor: 2.0,
                    cap_ms: 20.0,
                    jitter: Jitter::None,
                },
                budget: CountBound { max_attempts: 2.0 },
            });
        }
        spec = spec.resilience(policy);
    }
    tool::tool(name, spec, move |a: &Rc<Args>, _| {
        let c = Rc::clone(&c);
        Box::pin(async move {
            assert!(Rc::ptr_eq(a.raw.call().owner(), &c.turn));
            let index = a.index;
            let attempt = {
                let mut v = c.attempts.borrow_mut();
                v[index] += 1;
                v[index]
            };
            c.active.set(c.active.get() + 1);
            c.max.set(c.max.get().max(c.active.get()));
            c.log
                .borrow_mut()
                .push(json!({"kind":"start","index":index,"attempt":attempt,"at":c.at.get()}));
            let delay = if matches!(c.id, "timeout-late" | "timeout-serial") {
                25
            } else if c.id == "timeout-retries" {
                if attempt == 1 { 3 } else { 7 }
            } else {
                2
            };
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            c.active.set(c.active.get() - 1);
            c.log
                .borrow_mut()
                .push(json!({"kind":"end","index":index,"attempt":attempt,"at":c.at.get()}));
            if configured
                && !c.id.starts_with("free")
                && (matches!(c.id, "retry-exhaust" | "timeout-retries") || attempt == 1)
            {
                return Err(Raised::Declared(Rc::clone(&c.error)));
            }
            Ok(Outcome::ok(Rc::clone(&c.results[index])))
        })
    })
    .unwrap()
}
struct RecordingStore<S> {
    seed: Option<S>,
    saves: Rc<RefCell<Vec<S>>>,
    wires: Rc<RefCell<Vec<String>>>,
}
impl<S: Clone + Serialize> Store<S> for RecordingStore<S> {
    type Raw = Option<S>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.seed.clone())
    }
    async fn save(&self, s: &S) -> Result<(), Self::Error> {
        self.saves.borrow_mut().push(s.clone());
        self.wires
            .borrow_mut()
            .push(serde_json::to_string(s).unwrap());
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
    Value::Array(messages.iter().map(|m|match m {DefinedAgentMessage::<R>::System(c)=>json!({"role":"system","content":c}),DefinedAgentMessage::<R>::User(c)=>json!({"role":"user","content":c}),DefinedAgentMessage::<R>::Assistant(t)=>{let t=serde_json::to_value(t).unwrap();json!({"role":"assistant","content":t["content"],"toolCalls":t["toolCalls"],"provider":t["provider"]})},DefinedAgentMessage::<R>::Tool{record,parts}=>{assert!(parts.is_none());json!({"role":"tool","callId":record.call.call_id(),"name":record.call.name(),"outcome":record.outcome})}}).collect())
}
struct WithoutConstructors;
impl DefinedAgentTools for WithoutConstructors {
    type Host = ();
    type Result = <tool::EmptyRouter as DefinedAgentTools>::Result;
    type Error = <tool::EmptyRouter as DefinedAgentTools>::Error;
    type ContentError = <tool::EmptyRouter as DefinedAgentTools>::ContentError;
    type Command = <tool::EmptyRouter as DefinedAgentTools>::Command;
    type Bound = <tool::EmptyRouter as DefinedAgentTools>::Bound;
    fn route(
        &self,
        c: &Rc<demlik_tea::agent::PlainToolCall>,
    ) -> Result<Self::Command, tool::ToolError> {
        tool::EmptyRouter.route(c)
    }
    fn parts(
        &self,
        c: &demlik_tea::agent::PlainToolCall,
        o: &ToolOutcome<Self::Result, Self::Error>,
    ) -> Result<Option<demlik_tea::agent::content::Parts>, Self::ContentError> {
        tool::EmptyRouter.parts(c, o)
    }
    fn bind(self: Rc<Self>, h: Rc<Self::Host>) -> Self::Bound {
        Rc::new(tool::EmptyRouter).bind(h)
    }
    fn failure(
        &self,
        c: &Self::Command,
        o: &<Self::Command as demlik_tea::command::CommandFamily>::Completion,
    ) -> Result<Option<demlik_tea::agent::defined::DefinedToolFailure<Self::Error>>, tool::ToolError>
    {
        tool::EmptyRouter.failure(c, o)
    }
    fn resilience_of(&self, _: &demlik_tea::agent::PlainToolCall) -> Option<ToolResilience> {
        Some(ToolResilience::default().retry(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 5.0,
                factor: 2.0,
                cap_ms: 20.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 1.0 },
        }))
    }
    fn command_has_policy(&self, _: &Self::Command) -> bool {
        true
    }
}
async fn execute<R>(
    id: &'static str,
    router: Rc<R>,
    c: Rc<Control>,
    seed: Option<Rc<DefinedAgentState<R>>>,
    check: impl Fn(&R::Result) + 'static,
) -> (Value, Vec<Rc<DefinedAgentState<R>>>)
where
    R: DefinedAgentTools<Host = ()>,
    R::Result: Serialize,
    R::Error: Serialize,
{
    let seed_owner = seed.clone();
    let resumed = seed.is_some();
    let calls = Rc::new(Cell::new(0));
    let prompts = Rc::new(RefCell::new(vec![]));
    let events = Rc::new(RefCell::new(vec![]));
    let hooks = Rc::new(RefCell::new(vec![]));
    let pending = Rc::new(Cell::new(0));
    let saves = Rc::new(RefCell::new(vec![]));
    let wires = Rc::new(RefCell::new(Vec::<String>::new()));
    let trace = Rc::new(RefCell::new(vec![]));
    let hook_owners = Rc::new(RefCell::new(Vec::new()));
    let n = Rc::clone(&calls);
    let seen = Rc::clone(&prompts);
    let owner = Rc::clone(&c);
    let model = plain_model(
        async move |messages: Messages<'_, DefinedAgentMessage<R>>| -> Result<
            Rc<PlainData>,
            CallValue<DefinedAgentModelError<R::ContentError>>,
        > {
            n.set(n.get() + 1);
            for m in messages.as_ref() {
                if let DefinedAgentMessage::<R>::Tool { record, .. } = m {
                    assert!(Rc::ptr_eq(record.call.owner(), &owner.turn));
                    if let ToolOutcome::Ok(value) = record.outcome.as_ref() {
                        check(value.as_ref());
                    }
                }
            }
            seen.borrow_mut().push(prompt::<R>(messages.as_ref()));
            Ok(if resumed || n.get() == 2 {
                Rc::new(
                    decode_json(r#"{"content":"done","toolCalls":[],"provider":{"opaque":17}}"#)
                        .unwrap(),
                )
            } else {
                Rc::clone(&owner.turn)
            })
        },
    );
    let hc = Rc::clone(&c);
    let h = Rc::clone(&hooks);
    let p = Rc::clone(&pending);
    let checkpoints = Rc::clone(&wires);
    let owners = Rc::clone(&hook_owners);
    let mut config = called!(
        trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        router,
        "Apply each tool policy."
    )
    .on_tool_error(move |failure| {
        owners.borrow_mut().push(Rc::clone(&failure.outcome));
        let hc = Rc::clone(&hc);
        let p = Rc::clone(&p);
        let h = Rc::clone(&h);
        let checkpoints = Rc::clone(&checkpoints);
        let context = serde_json::to_value(&failure.context).unwrap();
        let outcome = serde_json::to_value(&failure.outcome).unwrap();
        Box::pin(async move {
            p.set(p.get() + 1);
            let records = checkpoints
                .borrow()
                .last()
                .map(|w| {
                    serde_json::from_str::<Value>(w).unwrap()["conversation"]["toolRecords"]
                        .as_array()
                        .map_or(0, Vec::len)
                })
                .unwrap_or(0);
            h.borrow_mut().push(
                json!({"context":context,"outcome":outcome,"at":hc.at.get(),"records":records}),
            );
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            p.set(p.get() - 1);
            hc.log
                .borrow_mut()
                .push(json!({"kind":"hook-end","callId":context["callId"],"at":hc.at.get()}));
        })
    });
    if !matches!(id, "free-serial" | "timeout-serial") {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::tool_concurrency,
            config,
            if id == "mixed" { 3.0 } else { 2.0 }
        );
    }
    let agent = called!(trace, demlik_tea::agent::define_agent, config);
    let at = Rc::clone(&c.at);
    let captured = Rc::clone(&events);
    let drive = called!(
        trace,
        demlik_tea::agent::DefinedAgent::run,
        &agent,
        "Complete.",
        DefinedAgentRunOptions::new(Rc::new(()))
            .run_id("tool-policy-run")
            .clock(move || at.get())
            .store(RecordingStore {
                seed,
                saves: Rc::clone(&saves),
                wires: Rc::clone(&wires)
            })
            .on_event(move |e| captured.borrow_mut().push(serde_json::to_value(e).unwrap()))
    );
    futures::pin_mut!(drive);
    let mut final_state = None;
    for _ in 0..200 {
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        if let Some(s) = drive.as_mut().now_or_never() {
            final_state = Some(s.unwrap());
            break;
        }
        c.at.set(c.at.get() + 1.0);
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
    }
    let final_state = final_state.expect("bounded controlled drive");
    if let Some(seed) = seed_owner {
        assert!(
            Rc::ptr_eq(&seed, saves.borrow().first().unwrap()),
            "boot retains the actual in-process checkpoint owner"
        );
    }
    assert_eq!(c.active.get(), 0);
    assert_eq!(calls.get(), if resumed { 1 } else { 2 });
    assert!(Rc::ptr_eq(&final_state, saves.borrow().last().unwrap()));
    if id == "malformed-retry" {
        assert_eq!(
            hooks.borrow().len(),
            6,
            "Source announces rejected attempts and their final ladder endings"
        );
        assert!(c.attempts.borrow().iter().all(|attempt| *attempt == 0));
    }
    if id == "retry-recover" {
        assert!(
            c.attempts.borrow().iter().all(|attempt| *attempt == 2),
            "successful retry starts two attempts"
        );
        assert!(
            hooks.borrow().is_empty(),
            "absorbed retry attempts stay silent"
        );
    }
    if id.starts_with("timeout") {
        assert_eq!(hooks.borrow().len(), 2);
        for hook in hooks.borrow().iter() {
            assert_eq!(
                hook["outcome"]["_tag"], "timeout",
                "overall timeout produces the final ending"
            );
        }
    }
    if id == "retry-exhaust" {
        assert_eq!(
            pending.get(),
            if resumed { 1 } else { 2 },
            "ladder hooks remain unawaited after run, without reannouncing seeded failures"
        );
        for hook in hooks.borrow().iter() {
            assert_eq!(hook["outcome"]["attempts"], 2);
            assert_eq!(
                hook["outcome"]["last"], "busy",
                "exhaustion keeps last reason"
            );
        }
    }
    if !matches!(id, "bare-failure" | "malformed-retry") {
        for original in hook_owners.borrow().iter() {
            assert!(saves.borrow().iter().any(|s|s.conversation.as_ref().is_some_and(|conversation|conversation.tool_records.iter().any(|record|matches!(record.outcome.as_ref(),ToolOutcome::Error(error) if Rc::ptr_eq(original,error))))));
        }
    }
    let phase = json!({"nativeTrace":trace.borrow().clone(),"log":c.log.borrow().clone(),"hookPending":pending.get(),"maxActive":c.max.get(),"attempts":c.attempts.borrow().clone(),"calls":calls.get(),"hooks":hooks.borrow().clone(),"prompts":prompts.borrow().clone(),"events":events.borrow().clone(),"saves":wires.borrow().iter().map(|w|serde_json::from_str::<Value>(w).unwrap()).collect::<Vec<_>>(),"saveWires":wires.borrow().clone(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"settledAt":c.at.get()});
    let saved = saves.borrow().clone();
    (phase, saved)
}
fn control(id: &'static str, seed: bool, turn: Option<Rc<PlainData>>) -> Rc<Control> {
    let count = if id == "mixed" { 5 } else { 2 };
    Rc::new(Control{at:Rc::new(Cell::new(if seed{100.0}else{50.0})),id,log:RefCell::new(vec![]),active:Cell::new(0),max:Cell::new(0),attempts:RefCell::new(vec![usize::from(seed);count]),turn:turn.unwrap_or_else(||Rc::new(decode_json(&json!({"content":"tools","toolCalls":(0..count).map(|i|json!({"callId":format!("c{i}"),"name":if id=="mixed"&&i%2==1{"plain"}else{"policy"},"args":{"index":i,"nested":{"owner":format!("arg-{i}")}}})).collect::<Vec<_>>(),"provider":{"opaque":17},"extra":{"kept":true}}).to_string()).unwrap())),results:(0..count).map(|index|Rc::new(ResultValue{index,attempt:2,nested:Rc::new(json!({"owner":format!("result-{index}")}))})).collect(),error:Rc::new(Busy)})
}
async fn run_case(id: &'static str) {
    let first_id = match id {
        "resume" => "retry-recover",
        "resume-exhaust" => "retry-exhaust",
        _ => id,
    };
    let c = control(first_id, false, None);
    let router = Rc::new(
        tools::Router::new(
            definition("policy", true, Rc::clone(&c)),
            definition("plain", false, Rc::clone(&c)),
        )
        .unwrap(),
    );
    let owners = Rc::clone(&c);
    let (phase, saves) = execute(first_id, router, Rc::clone(&c), None, move |v| {
        let r = match v {
            tools::Results::Policy(v) | tools::Results::Plain(v) => v,
            _ => panic!("no rejected result"),
        };
        assert!(Rc::ptr_eq(r, &owners.results[r.index]));
        assert!(Rc::ptr_eq(&r.nested, &owners.results[r.index].nested));
    })
    .await;
    for saved in &saves {
        if id == "malformed-retry" {
            continue;
        }
        let demlik_tea::agent::types::AgentField::Value(map) = &saved.tool_resilience else {
            continue;
        };
        for (_, slice) in map.own_entries() {
            let demlik_tea::js_record::RecordValue::Entry(slice) = slice else {
                continue;
            };
            for (_, progress) in slice.snapshot().retry.own_entries() {
                let demlik_tea::js_record::RecordValue::Entry(progress) = progress else {
                    continue;
                };
                let Some(failure) = &progress.last_error else {
                    continue;
                };
                let demlik_tea::resilience::resilient_call::CallFailure::External(error) =
                    failure.as_ref()
                else {
                    continue;
                };
                let error = match error.as_ref() {
                    tools::Errors::Policy(value) | tools::Errors::Plain(value) => &value.error,
                    _ => panic!("retry keeps actual attempt failure"),
                };
                let demlik_tea::command::Failure::Declared(tool::ToolFailure::Declared(original)) =
                    error
                else {
                    panic!("declared payload");
                };
                assert!(Rc::ptr_eq(original, &c.error));
            }
        }
    }
    let mut phases = vec![phase];
    if matches!(id, "resume" | "resume-exhaust") {
        let seed = saves
            .into_iter()
            .find(|s| {
                if id == "resume-exhaust" {
                    return s.conversation.as_ref().is_some_and(|c| {
                        c.tool_records
                            .iter()
                            .any(|r| matches!(r.outcome.as_ref(), ToolOutcome::Error(_)))
                    });
                }
                serde_json::to_value(s).unwrap()["toolResilience"]["policy"]["calls"]
                    .as_object()
                    .is_some_and(|calls| calls.values().any(|v| v["phase"] == "waiting_retry"))
            })
            .unwrap();
        let c = control(
            first_id,
            true,
            Some(Rc::clone(&seed.conversation.as_ref().unwrap().turns[0])),
        );
        let router = Rc::new(
            tools::Router::new(
                definition("policy", true, Rc::clone(&c)),
                definition("plain", false, Rc::clone(&c)),
            )
            .unwrap(),
        );
        let owners = Rc::clone(&c);
        let (p, _) = execute(first_id, router, c, Some(seed), move |v| {
            let r = match v {
                tools::Results::Policy(v) | tools::Results::Plain(v) => v,
                _ => panic!("no rejected result"),
            };
            assert!(Rc::ptr_eq(r, &owners.results[r.index]));
        })
        .await;
        phases.push(p);
    }
    println!("{}", json!({"id":id,"phases":phases}));
}
async fn missing_family() {
    let calls = Rc::new(Cell::new(0));
    let n = Rc::clone(&calls);
    let model=plain_model(async move|_:Messages<'_,DefinedAgentMessage<WithoutConstructors>>|->Result<Rc<PlainData>,CallValue<DefinedAgentModelError<Infallible>>>{n.set(n.get()+1);Ok(Rc::new(decode_json(r#"{"content":"try","toolCalls":[{"callId":"missing","name":"policy","args":{}}]}"#).unwrap()))});
    let agent = demlik_tea::agent::define_agent(
        demlik_tea::agent::DefineAgentConfig::new(
            model,
            Rc::new(WithoutConstructors),
            "Missing constructors must be observable.",
        )
        .tool_concurrency(2.0),
    );
    let w = agent.machine(
        "Complete.".into(),
        Rc::new(()),
        Rc::new(demlik_tea::timing::TokioTimer::with_clock(|| 50.0, |_| {})),
    );
    let errors = Rc::new(Cell::new(0));
    let count = Rc::clone(&errors);
    let mut opts = demlik_tea::runtime::Options::new(demlik_tea::runtime::Profile::Promise);
    opts.clock = Rc::new(|| 50.0);
    opts.on_error = Some(Rc::new(
        move |error: &demlik_tea::runtime::RuntimeError<Infallible, _, _>, _| {
            assert!(matches!(error,demlik_tea::runtime::RuntimeError::Reduce(demlik_tea::agent::AgentMachineError::Agent(demlik_tea::agent::AgentError::ToolResilience(demlik_tea::agent::tool_resilience::ToolResilienceError::MissingFailureFamily)))));
            count.set(count.get() + 1);
        },
    ));
    let h = demlik_tea::runtime::try_launch(w.machine, (), w.interpret, w.subscribe, opts);
    h.dispatch(demlik_tea::agent::AgentMachineMsg::Start {
        run_id: "missing-family".into(),
        at: 50.0,
    })
    .await
    .unwrap();
    h.stop().await;
    assert!(errors.get() > 0);
    assert_eq!(calls.get(), 1);
    println!(
        "{}",
        json!({"id":"missing-family","typedError":"MissingFailureFamily","errorReports":errors.get(),"modelCalls":calls.get()})
    );
}
fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        tokio::time::pause();
        if std::env::args().any(|a| a == "--missing-family") {
            missing_family().await;
            return;
        }
        for id in [
            "free-serial",
            "free-concurrent",
            "retry-recover",
            "retry-exhaust",
            "malformed-retry",
            "bare-failure",
            "timeout-late",
            "timeout-serial",
            "timeout-retries",
            "mixed",
            "resume",
            "resume-exhaust",
        ]
        .into_iter()
        .filter(|id| {
            std::env::args()
                .find_map(|a| a.strip_prefix("--case=").map(str::to_owned))
                .is_none_or(|selected| selected == *id)
        }) {
            run_case(id).await;
        }
    });
}
