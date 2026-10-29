//! Public defined-Agent stop guards with controlled time and retained Store checkpoints.
use demlik_tea::{
    PlainData,
    agent::{
        AgentMachineError, AgentMachineMsg, DefinedAgentRunOptions, DefinedAgentState,
        DefinedAgentTools,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::EmptyRouter,
        types::{AgentField, Awaiting},
    },
    data::decode_json,
    resilience::resilient_call::CallValue,
    runtime::{self, DriveError, DriveOptions, Options, Persistence, Profile},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};
macro_rules! called {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let value = $function($($argument),*);
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}
type State = Rc<DefinedAgentState<EmptyRouter>>;
struct RecordingStore {
    seed: Option<State>,
    saves: Rc<RefCell<Vec<State>>>,
}
impl Store<State> for RecordingStore {
    type Raw = Option<State>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.seed.clone())
    }
    async fn save(&self, state: &State) -> Result<(), Self::Error> {
        self.saves.borrow_mut().push(Rc::clone(state));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<State> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
}
#[derive(Clone, Copy)]
struct Case {
    id: &'static str,
    turns: Option<f64>,
    elapsed: Option<f64>,
    stop: Option<usize>,
    resume: bool,
    raw: bool,
}
impl Case {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            turns: None,
            elapsed: None,
            stop: None,
            resume: false,
            raw: false,
        }
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
#[expect(
    clippy::result_large_err,
    reason = "The raw machine retains the existing canonical typed reducer error channel."
)]
async fn execute(c: Case, seed: Option<State>) -> (Value, Vec<State>) {
    let at = Rc::new(Cell::new(if seed.is_some() { 100.0 } else { 50.0 }));
    let calls = Rc::new(Cell::new(0_usize));
    let predicates = Rc::new(Cell::new(0_usize));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let saves = Rc::new(RefCell::new(Vec::new()));
    let turns:Vec<_>=(0..3).map(|i|Rc::new(decode_json(&json!({"content":format!("round-{i}"),"toolCalls":if i==2{vec![]}else{(0..3).map(|j|json!({"callId":format!("{i}-{j}"),"name":"missing","args":{"index":j}})).collect()},"provider":{"opaque":17},"extra":{"kept":true}}).to_string()).unwrap())).collect();
    let mut originals = turns.clone();
    if let Some(s) = &seed
        && let Some(conv) = &s.conversation
    {
        originals.extend(conv.turns.iter().cloned());
    }
    let model_calls = Rc::clone(&calls);
    let model_at = Rc::clone(&at);
    let capture = Rc::clone(&prompts);
    let model=plain_model(async move |messages:Messages<'_,DefinedAgentMessage<EmptyRouter>>|->Result<Rc<PlainData>,CallValue<DefinedAgentModelError<Infallible>>>{capture.borrow_mut().push(prompt(messages.as_ref()));let i=model_calls.get();model_calls.set(i+1);model_at.set(model_at.get()+10.0);Ok(Rc::clone(turns.get(i).expect("no extra model call")))});
    let native_trace = Rc::new(RefCell::new(Vec::new()));
    let mut config = called!(
        native_trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        Rc::new(EmptyRouter),
        "Bound the conversation."
    );
    if let Some(n) = c.turns {
        config = config.max_turns(n);
    }
    if let Some(n) = c.elapsed {
        config = config.max_elapsed_ms(n);
    }
    if let Some(n) = c.stop {
        let capture = Rc::clone(&predicates);
        config = config.stop_when(move |s| {
            capture.set(capture.get() + 1);
            s.conversation
                .as_ref()
                .is_some_and(|conv| conv.turn_count.number_or_zero() >= n as f64)
        });
    }
    let agent = called!(native_trace, demlik_tea::agent::define_agent, config);
    let store = RecordingStore {
        seed,
        saves: Rc::clone(&saves),
    };
    let clock = Rc::clone(&at);
    let capture = Rc::clone(&events);
    let result = if c.raw {
        let timer_at = Rc::clone(&at);
        let w = called!(
            native_trace,
            demlik_tea::agent::DefinedAgent::machine,
            &agent,
            "Do three rounds.".into(),
            Rc::new(()),
            Rc::new(TokioTimer::with_clock(move || timer_at.get(), |_| {})),
        );
        let mut options = Options::new(Profile::Promise);
        options.clock = Rc::new(move || clock.get());
        options.store = Some(Persistence::new(store));
        options.terminal = Some(Rc::new(|s: &State| s.is_settled()));
        let projection = demlik_tea::agent::plain_agent_events();
        let routes = Rc::new(EmptyRouter).bind(Rc::new(()));
        let options=options.with_checked_events(move|msg,s|projection.project_routed::<_,_,_,_,_,_,_,_,_,_,_,<EmptyRouter as DefinedAgentTools>::Command,_>(msg,s,&routes).map_err(AgentMachineError::from));
        let runtime = runtime::try_launch(w.machine, (), w.interpret, w.subscribe, options);
        let listeners: Vec<_> = demlik_tea::agent::types::AGENT_EVENT_TYPES
            .into_iter()
            .map(|kind| {
                let capture = Rc::clone(&capture);
                runtime.on(
                    kind,
                    Rc::new(move |e| capture.borrow_mut().push(serde_json::to_value(e).unwrap())),
                )
            })
            .collect();
        let result = runtime::drive_to_done(
            &runtime,
            AgentMachineMsg::Start {
                run_id: "guard-run".into(),
                at: at.get(),
            },
            |s| s.is_settled(),
            DriveOptions {
                failed: Some(Rc::new(|s: &State| {
                    !matches!(s.failure, AgentField::Value(None))
                })),
                cancellation: None,
            },
        )
        .await
        .map(|s| Rc::clone(&s));
        for detach in listeners {
            detach();
        }
        result
    } else {
        called!(
            native_trace,
            demlik_tea::agent::DefinedAgent::run,
            &agent,
            "Do three rounds.",
            DefinedAgentRunOptions::new(Rc::new(()))
                .run_id("guard-run")
                .clock(move || clock.get())
                .store(store)
                .on_event(move |e| capture.borrow_mut().push(serde_json::to_value(e).unwrap())),
        )
        .await
    };
    let (final_state, outcome) = match result {
        Ok(s) => (s, "resolved"),
        Err(DriveError::Failed { state }) => (Rc::clone(&state), "failed"),
        Err(other) => panic!("unexpected drive error {other:?}"),
    };
    let states = saves.borrow().clone();
    assert!(
        states
            .iter()
            .all(|s| s.conversation.as_ref().is_none_or(|conv| conv
                .turns
                .iter()
                .all(|t| originals.iter().any(|o| Rc::ptr_eq(t, o))))),
        "canonical turns retain their owner"
    );
    assert!(
        states.last().is_some_and(|s| Rc::ptr_eq(s, &final_state)),
        "returned failed or cancelled state is the actually saved owner"
    );
    let phase = json!({"prompts":*prompts.borrow(),"events":*events.borrow(),"saves":states,"saveWires":states.iter().map(|s|serde_json::to_string(s).unwrap()).collect::<Vec<_>>(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"calls":calls.get(),"predicates":predicates.get(),"outcome":outcome,"nativeTrace":*native_trace.borrow()});
    (phase, states)
}
async fn run() {
    let mut cases = Vec::new();
    for id in [
        "unset",
        "zero",
        "one",
        "fraction",
        "nan",
        "elapsed-below",
        "elapsed-equal",
        "stop",
        "turn-before-stop",
        "elapsed-before-stop",
        "raw",
        "resume-stop",
        "resume-elapsed",
        "resume-turn",
    ] {
        let mut c = Case::new(id);
        match id {
            "zero" => c.turns = Some(0.0),
            "one" | "turn-before-stop" | "raw" | "resume-turn" => c.turns = Some(1.0),
            "fraction" => c.turns = Some(1.5),
            "nan" => c.turns = Some(f64::NAN),
            "elapsed-below" => c.elapsed = Some(11.0),
            "elapsed-equal" | "elapsed-before-stop" => c.elapsed = Some(10.0),
            "resume-elapsed" => c.elapsed = Some(20.0),
            _ => {}
        }
        if id == "stop" {
            c.stop = Some(2);
        }
        if id.ends_with("before-stop") || id == "resume-stop" {
            c.stop = Some(1);
        }
        c.raw = id == "raw";
        c.resume = id.starts_with("resume-");
        cases.push(c);
    }
    for c in cases {
        let seed = if c.resume {
            let mut first = Case::new("seed");
            first.turns = Some(1.0);
            let (_, saves) = execute(first, None).await;
            Some(Rc::clone(
                saves
                    .iter()
                    .find(|s| {
                        s.conversation
                            .as_ref()
                            .is_some_and(|conv| matches!(conv.awaiting, Awaiting::Tools { .. }))
                    })
                    .expect("real saved awaiting-tools state"),
            ))
        } else {
            None
        };
        let (phase, _) = execute(c, seed).await;
        println!("{}", json!({"id":c.id,"phase":phase}));
    }
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, run());
}
