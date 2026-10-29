//! Public cancellation workflow with controlled in-flight provider and tool owners.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        DefinedAgentRunOptions, DefinedAgentTools, PlainToolArgs,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, ModelStream, TurnChunk},
        tool::{self, ErrorFamily, Raised, ToolDefinition, ToolSpec},
        types::ToolOutcome,
    },
    command::{Outcome, SchemaError},
    data::decode_json,
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    runtime::DriveSignal,
    storage::{Migrated, Store},
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};
use tokio::sync::Notify;
demlik_tea::tool_router! {mod tools {Lookup(lookup)}}
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
struct Input;
impl Schema for Input {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<Args>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        let index = raw.call().call_id().as_utf8().unwrap()[1..]
            .parse()
            .unwrap();
        Ok(Rc::new(Args { raw, index }))
    }
}
#[derive(Serialize)]
struct ResultValue {
    token: &'static str,
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
#[derive(Serialize)]
struct Denied {
    detail: Rc<Value>,
}
impl Tagged for Denied {
    fn tag(&self) -> &str {
        "denied"
    }
}
// Opaque thrown cause has no Clone, Debug, Display, Serialize, Send or Sync obligation.
struct Thrown {
    nested: Rc<Value>,
}
struct Control {
    id: &'static str,
    n: usize,
    trace: RefCell<Vec<String>>,
    prompts: RefCell<Vec<Value>>,
    hooks: RefCell<Vec<Value>>,
    chunks: RefCell<Vec<Rc<TurnChunk>>>,
    stream: RefCell<Option<ModelStream>>,
    calls: Cell<usize>,
    tool_calls: Cell<usize>,
    completed: Cell<usize>,
    active: Cell<usize>,
    max: Cell<usize>,
    started: Notify,
    provider: Notify,
    releases: Vec<Notify>,
    ends: Vec<Notify>,
    hook_ends: Vec<Notify>,
    turn: Rc<PlainData>,
    answer: Rc<PlainData>,
    result: Rc<ResultValue>,
    denied: Rc<Denied>,
    thrown: Rc<Thrown>,
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
        Error = Denied,
        Thrown = Thrown,
        ContentError = Infallible,
    >,
> {
    let spec = ToolSpec::new(
        Rc::new(Input),
        Rc::new(Identity),
        ErrorFamily::new(["denied"], |e: &Denied| {
            Ok(decode_json(&format!(r#"{{"_tag":"denied","detail":{}}}"#, e.detail)).unwrap())
        }),
    )
    .raised::<Thrown>();
    tool::tool("lookup", spec, move |a: &Rc<Args>, _| {
        let c = Rc::clone(&c);
        Box::pin(async move {
            assert!(Rc::ptr_eq(a.raw.call().owner(), &c.turn));
            let PlainData::Object(turn) = c.turn.as_ref() else {
                panic!("turn")
            };
            let PlainData::Array(calls) = &turn["toolCalls"] else {
                panic!("calls")
            };
            let PlainData::Object(call) = &calls[a.index] else {
                panic!("call")
            };
            let PlainData::Object(original) = &call["args"] else {
                panic!("args")
            };
            let PlainData::Object(actual) = a.raw.value() else {
                panic!("cursor")
            };
            assert!(std::ptr::eq(&actual["nested"], &original["nested"]));
            let i = c.tool_calls.get();
            c.tool_calls.set(i + 1);
            assert_eq!(i, a.index);
            c.active.set(c.active.get() + 1);
            c.max.set(c.max.get().max(c.active.get()));
            c.trace.borrow_mut().push(format!("tool:start:{i}"));
            if i + 1 == c.n {
                c.started.notify_one();
            }
            if c.id != "omitted" {
                c.releases[i].notified().await;
            }
            c.active.set(c.active.get() - 1);
            c.completed.set(c.completed.get() + 1);
            c.trace.borrow_mut().push(format!("tool:end:{i}"));
            c.ends[i].notify_one();
            if c.id.ends_with("typed") {
                return Err(Raised::Declared(Rc::clone(&c.denied)));
            }
            if c.id.ends_with("thrown") {
                return Err(Raised::Error {
                    message: "lookup unavailable".into(),
                    cause: Rc::clone(&c.thrown),
                });
            }
            Ok(Outcome::ok(Rc::clone(&c.result)))
        })
    })
    .unwrap()
}
struct RecordingStore<S> {
    seed: Option<S>,
    wires: Rc<RefCell<Vec<String>>>,
    states: Rc<RefCell<Vec<S>>>,
}
impl<S: Clone + Serialize> Store<S> for RecordingStore<S> {
    type Raw = Option<S>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.seed.clone())
    }
    async fn save(&self, s: &S) -> Result<(), Self::Error> {
        self.wires
            .borrow_mut()
            .push(serde_json::to_string(s).unwrap());
        self.states.borrow_mut().push(s.clone());
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
async fn execute<R>(
    c: Rc<Control>,
    router: Rc<R>,
    check_result: impl Fn(&R::Result) + 'static,
    check_error: impl Fn(&R::Error) + 'static,
) -> Value
where
    R: DefinedAgentTools<Host = ()>,
    R::Result: Serialize,
    R::Error: Serialize,
{
    let native_trace = Rc::new(RefCell::new(vec![]));
    let m = Rc::clone(&c);
    let model = called!(
        native_trace,
        demlik_tea::agent::model::streaming_model,
        async move |messages: Messages<'_, DefinedAgentMessage<R>>,
                    sink: ModelStream|
                    -> Result<
            Rc<PlainData>,
            CallValue<DefinedAgentModelError<R::ContentError>>,
        > {
            for msg in messages.as_ref() {
                match msg {
                    DefinedAgentMessage::<R>::Assistant(t) => assert!(Rc::ptr_eq(t, &m.turn)),
                    DefinedAgentMessage::<R>::Tool { record, .. } => {
                        assert!(Rc::ptr_eq(record.call.owner(), &m.turn));
                        if let ToolOutcome::Ok(r) = record.outcome.as_ref() {
                            check_result(r);
                        }
                    }
                    _ => {}
                }
            }
            assert_ne!(m.id, "preabort", "preaborted signal must skip model");
            let calls = m.calls.get() + 1;
            m.calls.set(calls);
            m.prompts.borrow_mut().push(prompt::<R>(messages.as_ref()));
            m.trace.borrow_mut().push(format!("model:{calls}"));
            *m.stream.borrow_mut() = Some(sink.clone());
            let chunk = Rc::new(TurnChunk {
                text: format!("chunk:{calls}").into(),
            });
            sink.on_chunk(Rc::clone(&chunk));
            assert!(Rc::ptr_eq(m.chunks.borrow().last().unwrap(), &chunk));
            if m.id == "provider" {
                m.started.notify_one();
                m.provider.notified().await;
                m.trace.borrow_mut().push("model:end".into());
            }
            Ok(Rc::clone(if m.id == "done" || calls > 1 {
                &m.answer
            } else {
                &m.turn
            }))
        }
    );
    let h = Rc::clone(&c);
    let mut config = called!(
        native_trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        router,
        "Cancel the lookup."
    )
    .on_tool_error(move |f| {
        let h = Rc::clone(&h);
        check_error(&f.outcome);
        let value = json!({"failure":f.outcome,"context":f.context});
        let id = f.context.call_id.as_utf8().unwrap().to_owned();
        Box::pin(async move {
            h.hooks.borrow_mut().push(value);
            h.trace.borrow_mut().push(format!("hook:{id}"));
            h.hook_ends[id[1..].parse::<usize>().unwrap()].notify_one();
        })
    });
    if c.id.starts_with("concurrent") {
        config = config.tool_concurrency(3.0);
    }
    let agent = Rc::new(called!(
        native_trace,
        demlik_tea::agent::define_agent,
        config
    ));
    let wires = Rc::new(RefCell::new(vec![]));
    let states = Rc::new(RefCell::new(vec![]));
    let events = Rc::new(RefCell::new(vec![]));
    let store = RecordingStore {
        seed: None,
        wires: Rc::clone(&wires),
        states: Rc::clone(&states),
    };
    let signal = DriveSignal::new();
    if c.id == "preabort" {
        signal.abort();
    }
    let e = Rc::clone(&events);
    let chunks = Rc::clone(&c);
    let mut opts = DefinedAgentRunOptions::new(Rc::new(()))
        .run_id("run")
        .clock(|| 50.0)
        .on_event(move |e0| e.borrow_mut().push(serde_json::to_value(e0).unwrap()))
        .on_chunk(move |chunk| chunks.chunks.borrow_mut().push(Rc::clone(chunk)));
    if c.id != "omitted" {
        opts = called!(
            native_trace,
            demlik_tea::agent::DefinedAgentRunOptions::signal,
            opts,
            signal.clone()
        );
    }
    // Set signal before the error-generic store builder to prove forwarding.
    let opts = called!(
        native_trace,
        demlik_tea::agent::DefinedAgentRunOptions::store,
        opts,
        store
    );
    let running = called!(
        native_trace,
        demlik_tea::agent::DefinedAgent::run,
        agent.as_ref(),
        "go",
        opts
    );
    let task = tokio::task::spawn_local(running);
    if !["preabort", "done", "omitted"].contains(&c.id) {
        c.started.notified().await;
        assert_eq!(c.calls.get(), 1);
        assert_eq!(c.completed.get(), 0);
        c.trace.borrow_mut().push("abort".into());
        signal.abort();
        if c.id == "provider" {
            c.provider.notify_one();
        } else {
            for i in 0..c.n {
                c.releases[i].notify_one();
                c.ends[i].notified().await;
                if c.id.ends_with("typed") || c.id.ends_with("thrown") {
                    c.hook_ends[i].notified().await;
                }
            }
        }
    }
    let final_state = task
        .await
        .unwrap()
        .unwrap_or_else(|e| panic!("unexpected {}", e.name()));
    c.trace.borrow_mut().push("resolved".into());
    if c.id == "done" {
        signal.abort();
        c.trace.borrow_mut().push("abort:after-done".into());
    }
    if let Some(stream) = c.stream.borrow().as_ref() {
        stream.on_chunk(Rc::new(TurnChunk {
            text: "after-run".into(),
        }));
    }
    assert_eq!(
        c.calls.get(),
        if c.id == "preabort" {
            0
        } else if c.id == "omitted" {
            2
        } else {
            1
        },
        "cancellation must stop model advancement"
    );
    let value = serde_json::to_value(&final_state).unwrap();
    assert_eq!(
        value["run"]["phase"],
        if ["done", "omitted"].contains(&c.id) {
            "done"
        } else {
            "cancelled"
        },
        "signal must resolve a durable cancellation"
    );
    if value["run"]["phase"] == "cancelled" {
        assert_eq!(
            value["run"]["at"], 50,
            "cancellation timestamp must use the caller clock"
        );
        assert!(
            final_state
                .conversation
                .as_ref()
                .is_none_or(|v| v.tool_records.is_empty())
        );
    }
    assert_eq!(
        c.max.get(),
        if ["preabort", "provider", "done"].contains(&c.id) {
            0
        } else {
            c.n
        }
    );
    assert!(
        states.borrow().iter().any(|s| Rc::ptr_eq(&final_state, s)),
        "drive returns the original saved terminal receipt"
    );
    let frozen = (
        wires.borrow().len(),
        events.borrow().len(),
        c.hooks.borrow().len(),
    );
    let resumed_wires = Rc::new(RefCell::new(vec![]));
    let resumed_events = Rc::new(RefCell::new(vec![]));
    let re = Rc::clone(&resumed_events);
    let resumed_opts = DefinedAgentRunOptions::new(Rc::new(()))
        .run_id("resumed")
        .clock(|| 50.0)
        .signal(DriveSignal::new())
        .on_event(move |e| re.borrow_mut().push(serde_json::to_value(e).unwrap()))
        .store(RecordingStore {
            seed: Some(Rc::clone(&final_state)),
            wires: Rc::clone(&resumed_wires),
            states: Rc::new(RefCell::new(vec![])),
        });
    let resumed = called!(
        native_trace,
        demlik_tea::agent::DefinedAgent::run,
        agent.as_ref(),
        "go",
        resumed_opts
    )
    .await
    .unwrap_or_else(|e| panic!("unexpected resume {}", e.name()));
    assert!(Rc::ptr_eq(&resumed, &final_state));
    assert_eq!(
        frozen,
        (
            wires.borrow().len(),
            events.borrow().len(),
            c.hooks.borrow().len()
        )
    );
    json!({"id":c.id,"nativeTrace":native_trace.borrow().clone(),"maxActive":c.max.get(),"trace":c.trace.borrow().clone(),"prompts":c.prompts.borrow().clone(),"events":events.borrow().clone(),"hooks":c.hooks.borrow().clone(),"chunks":c.chunks.borrow().iter().map(|v|serde_json::to_value(v).unwrap()).collect::<Vec<_>>(),"toolCalls":c.tool_calls.get(),"completed":c.completed.get(),"calls":c.calls.get(),"saves":wires.borrow().iter().map(|w|serde_json::from_str::<Value>(w).unwrap()).collect::<Vec<_>>(),"saveWires":wires.borrow().clone(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap(),"resume":{"saveWires":resumed_wires.borrow().clone(),"events":resumed_events.borrow().clone(),"final":resumed,"finalWire":serde_json::to_string(&resumed).unwrap()}})
}
fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&rt,async{
 for id in ["preabort","provider","serial-ok","serial-typed","concurrent-ok","concurrent-typed","concurrent-thrown","done","omitted"]{
 if let Some(case)=std::env::args().find_map(|a|a.strip_prefix("--case=").map(str::to_owned))&&case!=id{continue;}
 let n=if id.starts_with("concurrent"){3}else{1};
 let turn=Rc::new(decode_json(&format!(r#"{{"content":"lookup","toolCalls":[{}],"provider":{{"kept":true}}}}"#,(0..n).map(|i|format!(r#"{{"callId":"c{i}","name":"lookup","args":{{"token":"args","nested":{{"owner":"arg"}}}}}}"#)).collect::<Vec<_>>().join(","))).unwrap());
 let c=Rc::new(Control{id,n,trace:RefCell::new(vec![]),prompts:RefCell::new(vec![]),hooks:RefCell::new(vec![]),chunks:RefCell::new(vec![]),stream:RefCell::new(None),calls:Cell::new(0),tool_calls:Cell::new(0),completed:Cell::new(0),active:Cell::new(0),max:Cell::new(0),started:Notify::new(),provider:Notify::new(),releases:(0..3).map(|_|Notify::new()).collect(),ends:(0..3).map(|_|Notify::new()).collect(),hook_ends:(0..3).map(|_|Notify::new()).collect(),turn,answer:Rc::new(decode_json(r#"{"content":"done","toolCalls":[],"provider":{"kept":true}}"#).unwrap()),result:Rc::new(ResultValue{token:"result",nested:Rc::new(json!({"owner":"result"}))}),denied:Rc::new(Denied{detail:Rc::new(json!({"owner":"error"}))}),thrown:Rc::new(Thrown{nested:Rc::new(json!({"owner":"thrown"}))})});
 let router=Rc::new(tools::Router::new(definition(Rc::clone(&c))).unwrap());let success=Rc::clone(&c);let failure=Rc::clone(&c);
 let row=execute(c,router,move|r|{let tools::Results::Lookup(r)=r else{panic!("lookup result")};assert!(Rc::ptr_eq(r,&success.result));assert!(Rc::ptr_eq(&r.nested,&success.result.nested));},move|e|{let tools::Errors::Lookup(v)=e else{panic!("lookup failure")};let demlik_tea::command::Failure::Declared(v)=&v.error else{panic!("declared failure")};match v{tool::ToolFailure::Declared(d)=>{assert!(Rc::ptr_eq(d,&failure.denied));assert!(Rc::ptr_eq(&d.detail,&failure.denied.detail));},tool::ToolFailure::Thrown{cause:tool::ThrownCause::Error(x),..}=>{assert!(Rc::ptr_eq(x,&failure.thrown));assert!(Rc::ptr_eq(&x.nested,&failure.thrown.nested));},_=>panic!("original error")}}).await;println!("{row}");
 }
});
}
