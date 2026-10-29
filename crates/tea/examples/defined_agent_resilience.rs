//! Controlled provider failures through the public no-tool Agent and its real drive.
use demlik_tea::retry_backoff::{
    BackoffCurve, CountBound, DurationBound, Jitter, RetryPolicy, Unbounded,
};
use demlik_tea::{
    PlainData,
    agent::{
        DefinedAgentRunOptions, DefinedAgentState,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::EmptyRouter,
    },
    data::decode_json,
    llm_call::LlmCause,
    resilience::resilient_call::CallValue,
    runtime::DriveError,
    storage::{Migrated, Store},
};
use futures::FutureExt;
use serde::Serialize;
use serde_json::{Value, json};
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
struct RecordingStore {
    seed: Option<State>,
    saves: Rc<RefCell<Vec<State>>>,
}
impl Store<State> for RecordingStore {
    type Raw = Option<State>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Infallible> {
        Ok(self.seed.clone())
    }
    async fn save(&self, s: &State) -> Result<(), Infallible> {
        self.saves.borrow_mut().push(Rc::clone(s));
        Ok(())
    }
    fn migrate(&self, s: Self::Raw) -> Migrated<State> {
        s.map_or(Migrated::Fresh, Migrated::State)
    }
}
fn prompt(messages: &[DefinedAgentMessage<EmptyRouter>]) -> Value {
    Value::Array(messages.iter().map(|m|match m {
 DefinedAgentMessage::<EmptyRouter>::System(c)=>json!({"role":"system","content":c}),
 DefinedAgentMessage::<EmptyRouter>::User(c)=>json!({"role":"user","content":c}),
 DefinedAgentMessage::<EmptyRouter>::Assistant(t)=>{let t=serde_json::to_value(t).unwrap();json!({"role":"assistant","content":t["content"],"toolCalls":t["toolCalls"],"provider":t["provider"]})},
 DefinedAgentMessage::<EmptyRouter>::Tool{record,parts}=>{let mut m=json!({"role":"tool","callId":record.call.call_id(),"name":record.call.name(),"outcome":record.outcome});if let Some(p)=parts{m["parts"]=serde_json::to_value(p).unwrap();}m}
 }).collect())
}
fn retry_causes(state: &State) -> Vec<Rc<Error>> {
    let mut values = Vec::new();
    for (_, value) in state.resilience.snapshot().retry.own_entries() {
        if let demlik_tea::js_record::RecordValue::Entry(progress) = value
            && let Some(failure) = &progress.last_error
            && let demlik_tea::resilience::resilient_call::CallFailure::External(error) =
                failure.as_ref()
            && let LlmCause::Value(cause) = &error.error
        {
            values.push(Rc::clone(cause));
        }
    }
    values
}
async fn execute(id: &'static str, seed: Option<State>) -> (Value, Vec<State>) {
    tokio::time::pause();
    let seeded = seed.is_some();
    let prior = seed.as_ref().map(retry_causes).unwrap_or_default();
    let at = Rc::new(Cell::new(if seeded { 55.0 } else { 50.0 }));
    let calls = Rc::new(Cell::new(0_usize));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let saves = Rc::new(RefCell::new(Vec::new()));
    let provider = Rc::new(ProviderError {
        code: "provider_busy",
        status: 429,
        nested: Rc::new(Details {
            request_id: "request-17",
            retry: Retry {
                after_ms: 5,
                attempts: vec![1, 2],
            },
        }),
        message: Some("Provider unavailable"),
    });
    let original = Rc::new(Error::<EmptyRouter>::Provider(Rc::clone(&provider)));
    let cause = Rc::clone(&original);
    let capture = Rc::clone(&prompts);
    let count = Rc::clone(&calls);
    let model=plain_model(async move |messages:Messages<'_,DefinedAgentMessage<EmptyRouter>>|->Result<Rc<PlainData>,CallValue<Error>>{
 capture.borrow_mut().push(prompt(messages.as_ref()));count.set(count.get()+1);let n=count.get();
 if id.starts_with("watchdog") {
 tokio::time::sleep(std::time::Duration::from_millis(if id.ends_with("stall"){25}else{6})).await;
 return Ok(Rc::new(decode_json(&json!({"content":format!("round-{n}"),"toolCalls":if id.ends_with("progress")&&n<3 {vec![json!({"callId":format!("c{n}"),"name":"missing","args":{}})]}else{vec![]},"provider":{"opaque":17}}).to_string()).unwrap()));
 }
 if id.contains("exhaust") || n<=if seeded {1}else{2} {return Err(CallValue::Shared(Rc::clone(&cause)));}
 Ok(Rc::new(decode_json(r#"{"content":"Recovered.","toolCalls":[],"provider":{"opaque":17}}"#).unwrap()))
 });
    let trace = Rc::new(RefCell::new(Vec::new()));
    let mut config = called!(
        trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        Rc::new(EmptyRouter),
        "Recover or report a stall."
    )
    .describe_provider_error(|e: &Rc<ProviderError>| Ok(e.message.unwrap().into()));
    let curve = BackoffCurve {
        base_ms: 5.0,
        factor: 2.0,
        cap_ms: 20.0,
        jitter: Jitter::None,
    };
    if id.contains("count") {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::retry,
            config,
            RetryPolicy {
                curve,
                budget: CountBound { max_attempts: 3.0 },
            }
        );
    }
    if id.contains("duration") {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::retry,
            config,
            RetryPolicy {
                curve,
                budget: DurationBound {
                    max_elapsed_ms: if id == "duration-exhaust" { 4.0 } else { 30.0 },
                    max_attempts: if id.contains("only") {
                        None
                    } else {
                        Some(if id.contains("both") { 2.0 } else { 4.0 })
                    },
                },
            }
        );
    }
    if id.starts_with("unbounded") {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::retry,
            config,
            RetryPolicy {
                curve,
                budget: Unbounded,
            }
        );
    }
    if id.starts_with("watchdog") {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::deadline_ms,
            config,
            10.0
        );
    }
    let agent = called!(trace, demlik_tea::agent::define_agent, config);
    let clock = Rc::clone(&at);
    let capture = Rc::clone(&events);
    let drive = called!(
        trace,
        demlik_tea::agent::DefinedAgent::run,
        &agent,
        "Complete the request.",
        DefinedAgentRunOptions::new(Rc::new(()))
            .run_id("resilience-run")
            .clock(move || clock.get())
            .store(RecordingStore {
                seed,
                saves: Rc::clone(&saves)
            })
            .on_event(move |e| capture.borrow_mut().push(serde_json::to_value(e).unwrap()))
    );
    futures::pin_mut!(drive);
    let mut result = None;
    for _ in 0..200 {
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        if let Some(value) = drive.as_mut().now_or_never() {
            result = Some(value);
            break;
        }
        at.set(at.get() + 1.0);
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
    }
    let (final_state, outcome) = match result.expect("bounded controlled drive") {
        Ok(s) => (s, "resolved"),
        Err(DriveError::Failed { state }) => (Rc::clone(&state), "failed"),
        Err(_) => panic!("unexpected runtime failure"),
    };
    assert!(saves.borrow().iter().any(|s| Rc::ptr_eq(s, &final_state)));
    // A failed attempt retains the provider's actual shared payload on the durable ladder.
    for s in saves.borrow().iter() {
        for value in retry_causes(s) {
            assert!(
                Rc::ptr_eq(&value, &original)
                    || prior.iter().any(|cause| Rc::ptr_eq(&value, cause))
            );
        }
    }
    let wires: Vec<_> = saves
        .borrow()
        .iter()
        .map(|s| serde_json::to_string(s).unwrap())
        .collect();
    let phase = json!({"prompts":*prompts.borrow(),"events":*events.borrow(),"saves":saves.borrow().iter().map(|s|serde_json::to_value(s).unwrap()).collect::<Vec<_>>(),"saveWires":wires,"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"calls":calls.get(),"outcome":outcome,"settledAt":at.get(),"nativeTrace":*trace.borrow()});
    tokio::time::resume();
    let saved = saves.borrow().clone();
    (phase, saved)
}
async fn run() {
    for id in [
        "unset",
        "count-recover",
        "count-exhaust",
        "duration-recover",
        "duration-exhaust",
        "duration-only-recover",
        "duration-both-exhaust",
        "unbounded-recover",
        "resume-count",
        "resume-duration",
        "watchdog-stall",
        "watchdog-progress",
    ] {
        let seed = if id.starts_with("resume") {
            let (_, saved) = execute(
                if id.contains("count") {
                    "count-recover"
                } else {
                    "duration-recover"
                },
                None,
            )
            .await;
            Some(Rc::clone(saved.iter().find(|s|matches!(s.resilience.call("act"),Some(demlik_tea::resilience::resilient_call::CallPhase::WaitingRetry{..}))).expect("real retained wait")))
        } else {
            None
        };
        let (phase, _) = execute(id, seed).await;
        println!("{}", json!({"id":id,"phase":phase}));
    }
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, run());
}
