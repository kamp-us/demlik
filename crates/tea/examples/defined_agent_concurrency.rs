//! Controlled public tools prove overlap and ordered durable settlement.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        DefinedAgentRunOptions, DefinedAgentState, DefinedAgentTools, PlainToolArgs,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::{self, ErrorFamily, Raised, ToolDefinition, ToolSpec},
        types::ToolOutcome,
    },
    command::{Outcome, SchemaError},
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
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};
use tokio::sync::Notify;
demlik_tea::tool_router! { mod tools { First(first), Second(second) } }
macro_rules! called { ($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let value=$function($($argument),*);$calls.borrow_mut().push(stringify!($function));value}}; }
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
struct Broken;
impl Tagged for Broken {
    fn tag(&self) -> &str {
        "broken"
    }
}
struct Control {
    log: RefCell<Vec<String>>,
    active: Cell<usize>,
    max: Cell<usize>,
    gates: Vec<Notify>,
    hook: Notify,
    stop: Notify,
    stop_started: Cell<bool>,
    turn: Rc<PlainData>,
    results: Vec<Rc<ResultValue>>,
}
fn definition(
    name: &'static str,
    control: Rc<Control>,
    failure: bool,
) -> Rc<
    impl ToolDefinition<
        Host = (),
        RawArgs = PlainToolArgs,
        Args = Args,
        RawResult = Rc<ResultValue>,
        Ok = ResultValue,
        Error = Broken,
        Thrown = (),
        ContentError = Infallible,
    >,
> {
    let spec = ToolSpec::new(
        Rc::new(Input),
        Rc::new(Identity),
        ErrorFamily::new(["broken"], |_: &Broken| {
            Ok(decode_json(r#"{"_tag":"broken"}"#).unwrap())
        }),
    )
    .raised::<()>();
    tool::tool(name, spec, move |a: &Rc<Args>, _| {
        let control = Rc::clone(&control);
        Box::pin(async move {
            assert!(Rc::ptr_eq(a.raw.call().owner(), &control.turn));
            let PlainData::Object(turn) = control.turn.as_ref() else {
                panic!("object turn")
            };
            let PlainData::Array(calls) = &turn["toolCalls"] else {
                panic!("array calls")
            };
            let PlainData::Object(call) = &calls[a.index] else {
                panic!("object call")
            };
            let PlainData::Object(original) = &call["args"] else {
                panic!("object arguments")
            };
            let PlainData::Object(actual) = a.raw.value() else {
                panic!("object cursor")
            };
            assert!(std::ptr::eq(&actual["nested"], &original["nested"]));
            control.log.borrow_mut().push(format!("start:{}", a.index));
            control.active.set(control.active.get() + 1);
            control.max.set(control.max.get().max(control.active.get()));
            control.gates[a.index].notified().await;
            control.active.set(control.active.get() - 1);
            control.log.borrow_mut().push(format!("end:{}", a.index));
            if failure && a.index == 0 {
                return Err(Raised::Declared(Rc::new(Broken)));
            }
            Ok(Outcome::ok(Rc::clone(&control.results[a.index])))
        })
    })
    .unwrap()
}
struct RecordingStore<S> {
    saves: Rc<RefCell<Vec<S>>>,
    wires: Rc<RefCell<Vec<String>>>,
    settlements: Rc<RefCell<Vec<String>>>,
}
impl<R: DefinedAgentTools> Store<Rc<DefinedAgentState<R>>>
    for RecordingStore<Rc<DefinedAgentState<R>>>
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    type Raw = Option<Rc<DefinedAgentState<R>>>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(None)
    }
    async fn save(&self, state: &Rc<DefinedAgentState<R>>) -> Result<(), Self::Error> {
        self.wires
            .borrow_mut()
            .push(serde_json::to_string(state).unwrap());
        self.saves.borrow_mut().push(Rc::clone(state));
        if let Some(c) = &state.conversation {
            for r in c.tool_records.iter() {
                let id = r.call.call_id().as_utf8().unwrap().to_owned();
                if !self.settlements.borrow().contains(&id) {
                    self.settlements.borrow_mut().push(id);
                }
            }
        }
        Ok(())
    }
    fn migrate(&self, _: Self::Raw) -> Migrated<Rc<DefinedAgentState<R>>> {
        Migrated::Fresh
    }
}
fn prompt<R: DefinedAgentTools>(messages: &[DefinedAgentMessage<R>]) -> Value
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    Value::Array(messages.iter().map(|m|match m {DefinedAgentMessage::<R>::System(c)=>json!({"role":"system","content":c}),DefinedAgentMessage::<R>::User(c)=>json!({"role":"user","content":c}),DefinedAgentMessage::<R>::Assistant(t)=>{let t=serde_json::to_value(t).unwrap();json!({"role":"assistant","content":t["content"],"toolCalls":t["toolCalls"],"provider":t["provider"]})},DefinedAgentMessage::<R>::Tool{record,parts}=>{assert!(parts.is_none());json!({"role":"tool","callId":record.call.call_id(),"name":record.call.name(),"outcome":record.outcome})}}).collect())
}
async fn until(predicate: impl Fn() -> bool, label: &str) {
    for _ in 0..2000 {
        if predicate() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("{label}");
}
#[derive(Clone, Copy)]
struct Case {
    id: &'static str,
    limit: Option<f64>,
    count: usize,
    failure: bool,
    raw: bool,
    stop: bool,
}
#[expect(
    clippy::result_large_err,
    reason = "The real raw machine retains its canonical reducer failure channel."
)]
async fn execute<R>(
    c: Case,
    router: Rc<R>,
    control: Rc<Control>,
    check: impl Fn(&R::Result) + 'static,
) -> Value
where
    R: DefinedAgentTools<Host = ()>,
    R::Result: Serialize,
    R::Error: Serialize,
{
    let calls = Rc::new(Cell::new(0));
    let prompts = Rc::new(RefCell::new(Vec::new()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let saves = Rc::new(RefCell::new(Vec::new()));
    let wires = Rc::new(RefCell::new(Vec::new()));
    let settlements = Rc::new(RefCell::new(Vec::new()));
    let trace = Rc::new(RefCell::new(Vec::new()));
    let next = Rc::clone(&calls);
    let seen = Rc::clone(&prompts);
    let state = Rc::clone(&control);
    let model = plain_model(
        async move |messages: Messages<'_, DefinedAgentMessage<R>>| -> Result<
            Rc<PlainData>,
            CallValue<DefinedAgentModelError<R::ContentError>>,
        > {
            for m in messages.as_ref() {
                if let DefinedAgentMessage::<R>::Tool { record, .. } = m {
                    assert!(Rc::ptr_eq(record.call.owner(), &state.turn));
                    if let ToolOutcome::Ok(result) = record.outcome.as_ref() {
                        check(result.as_ref());
                    }
                }
            }
            let p = prompt::<R>(messages.as_ref());
            next.set(next.get() + 1);
            if next.get() == 2 {
                assert_eq!(state.active.get(), 0);
                assert_eq!(
                    p.as_array()
                        .unwrap()
                        .iter()
                        .filter(|m| m["role"] == "tool")
                        .map(|m| m["callId"].clone())
                        .collect::<Vec<_>>(),
                    (0..c.count)
                        .map(|i| json!(format!("c{i}")))
                        .collect::<Vec<_>>()
                );
            }
            seen.borrow_mut().push(p);
            assert!(next.get() <= 2);
            Ok(if next.get() == 1 {
                Rc::clone(&state.turn)
            } else {
                Rc::new(
                    decode_json(r#"{"content":"done","toolCalls":[],"provider":{"opaque":17}}"#)
                        .unwrap(),
                )
            })
        },
    );
    let hook = Rc::clone(&control);
    let mut config = called!(
        trace,
        demlik_tea::agent::DefineAgentConfig::new,
        model,
        Rc::clone(&router),
        "Run the tools."
    )
    .on_tool_error(move |f| {
        let hook = Rc::clone(&hook);
        let id = f.context.call_id.as_utf8().unwrap().to_owned();
        Box::pin(async move {
            hook.log.borrow_mut().push(format!("hook:{id}"));
            hook.hook.notified().await;
            hook.log.borrow_mut().push(format!("hook-end:{id}"));
        })
    });
    if let Some(limit) = c.limit {
        config = called!(
            trace,
            demlik_tea::agent::DefineAgentConfig::tool_concurrency,
            config,
            limit
        );
    }
    let agent = called!(trace, demlik_tea::agent::define_agent, config);
    let store = RecordingStore {
        saves: Rc::clone(&saves),
        wires: Rc::clone(&wires),
        settlements: Rc::clone(&settlements),
    };
    let capture = Rc::clone(&events);
    let drive_trace = Rc::clone(&trace);
    let stop_control = Rc::clone(&control);
    let drive = async move {
        if c.raw {
            let w = called!(
                drive_trace,
                demlik_tea::agent::DefinedAgent::machine,
                &agent,
                "Complete.".into(),
                Rc::new(()),
                Rc::new(TokioTimer::with_clock(|| 50.0, |_| {}))
            );
            let mut options = Options::new(Profile::Promise);
            options.clock = Rc::new(|| 50.0);
            options.store = Some(Persistence::new(store));
            options.terminal = Some(Rc::new(|s: &Rc<DefinedAgentState<R>>| s.is_settled()));
            let projection = demlik_tea::agent::plain_agent_events();
            let routes = router.bind(Rc::new(()));
            let options = options.with_checked_events(move |msg, s| {
                projection
                    .project_routed::<_, _, _, _, _, _, _, _, _, _, _, R::Command, _>(
                        msg, s, &routes,
                    )
                    .map_err(demlik_tea::agent::AgentMachineError::from)
            });
            let h = runtime::try_launch(w.machine, (), w.interpret, w.subscribe, options);
            let listeners: Vec<_> = demlik_tea::agent::types::AGENT_EVENT_TYPES
                .into_iter()
                .map(|kind| {
                    let capture = Rc::clone(&capture);
                    h.on(
                        kind,
                        Rc::new(move |e| {
                            capture.borrow_mut().push(serde_json::to_value(e).unwrap())
                        }),
                    )
                })
                .collect();
            if c.stop {
                h.dispatch_once(demlik_tea::agent::AgentMachineMsg::Start {
                    run_id: "concurrency-run".into(),
                    at: 50.0,
                })
                .await
                .unwrap();
                stop_control.stop.notified().await;
                stop_control.stop_started.set(true);
                h.stop().await;
                let state = h.get_state().unwrap().as_ref().clone();
                for off in listeners {
                    off();
                }
                return state;
            }
            let result = runtime::drive_to_done(
                &h,
                demlik_tea::agent::AgentMachineMsg::Start {
                    run_id: "concurrency-run".into(),
                    at: 50.0,
                },
                |s| s.is_settled(),
                DriveOptions::default(),
            )
            .await
            .unwrap()
            .as_ref()
            .clone();
            for off in listeners {
                off();
            }
            result
        } else {
            called!(
                drive_trace,
                demlik_tea::agent::DefinedAgent::run,
                &agent,
                "Complete.",
                DefinedAgentRunOptions::new(Rc::new(()))
                    .store(store)
                    .clock(|| 50.0)
                    .run_id("concurrency-run")
                    .on_event(move |e| capture.borrow_mut().push(serde_json::to_value(e).unwrap()))
            )
            .await
            .unwrap()
        }
    };
    let task = tokio::task::spawn_local(drive);
    let width = c.limit.unwrap_or(1.0) as usize;
    for base in (0..c.count).step_by(width) {
        let end = (base + width).min(c.count);
        until(
            || control.log.borrow().contains(&format!("start:{}", end - 1)),
            "admitted handlers must overlap before release",
        )
        .await;
        assert_eq!(calls.get(), 1);
        assert_eq!(settlements.borrow().len(), base);
        for index in (base..end).rev() {
            control.gates[index].notify_one();
            until(
                || control.log.borrow().contains(&format!("end:{index}")),
                "handler completes",
            )
            .await;
            if index > base {
                assert_eq!(calls.get(), 1);
                assert_eq!(settlements.borrow().len(), base);
                if c.stop {
                    control.stop.notify_one();
                    until(
                        || control.stop_started.get(),
                        "stop starts while a follower is parked",
                    )
                    .await;
                }
            }
        }
        if c.failure && base == 0 {
            until(
                || control.log.borrow().contains(&"hook:c0".into()),
                "failure hook",
            )
            .await;
            assert_eq!(calls.get(), 1);
            assert!(settlements.borrow().is_empty());
            control.hook.notify_one();
        }
        if c.stop {
            break;
        }
        until(|| settlements.borrow().len() >= end, "ordered folds").await;
    }
    let final_state = task.await.unwrap();
    if c.stop {
        assert!(settlements.borrow().is_empty());
        assert!(control.stop_started.get());
        assert_eq!(control.active.get(), 0);
    }
    assert_eq!(calls.get(), if c.stop { 1 } else { 2 });
    assert_eq!(control.max.get(), width.min(c.count));
    assert!(Rc::ptr_eq(&final_state, saves.borrow().last().unwrap()));
    json!({"nativeTrace":trace.borrow().clone(),"log":control.log.borrow().clone(),"maxActive":control.max.get(),"calls":calls.get(),"settlements":settlements.borrow().clone(),"prompts":prompts.borrow().clone(),"events":events.borrow().clone(),"saves":wires.borrow().iter().map(|w|serde_json::from_str::<Value>(w).unwrap()).collect::<Vec<_>>(),"saveWires":wires.borrow().clone(),"final":final_state,"finalWire":serde_json::to_string(&final_state).unwrap()})
}
fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&rt,async{let stopping=std::env::args().any(|a|a=="--stop");for c in [Case{id:"unset",limit:None,count:2,failure:false,raw:false,stop:false},Case{id:"one",limit:Some(1.0),count:2,failure:false,raw:false,stop:false},Case{id:"two",limit:Some(2.0),count:2,failure:false,raw:false,stop:false},Case{id:"waves",limit:Some(2.0),count:5,failure:false,raw:false,stop:false},Case{id:"failure",limit:Some(2.0),count:2,failure:true,raw:false,stop:false},Case{id:"raw",limit:Some(2.0),count:2,failure:false,raw:true,stop:false},Case{id:"stop",limit:Some(2.0),count:2,failure:false,raw:true,stop:true}].into_iter().filter(|c|c.stop==stopping){let turn=Rc::new(decode_json(&json!({"content":"tools","toolCalls":(0..c.count).map(|i|json!({"callId":format!("c{i}"),"name":if i%2==0{"first"}else{"second"},"args":{"index":i,"nested":{"owner":format!("arg-{i}")}}})).collect::<Vec<_>>(),"provider":{"opaque":17},"extra":{"kept":true}}).to_string()).unwrap());let control=Rc::new(Control{log:RefCell::new(vec![]),active:Cell::new(0),max:Cell::new(0),gates:(0..c.count).map(|_|Notify::new()).collect(),hook:Notify::new(),stop:Notify::new(),stop_started:Cell::new(false),turn,results:(0..c.count).map(|i|Rc::new(ResultValue{index:i,nested:Rc::new(json!({"owner":format!("result-{i}")}))})).collect()});let router=Rc::new(tools::Router::new(definition("first",Rc::clone(&control),c.failure),definition("second",Rc::clone(&control),c.failure)).unwrap());let owners=Rc::clone(&control);let phase=execute(c,router,control,move|result|{let value=match result{tools::Results::First(v)=>v,tools::Results::Second(v)=>v,_=>panic!("no rejected tools")};let original=&owners.results[value.index];assert!(Rc::ptr_eq(value,original));assert!(Rc::ptr_eq(&value.nested,&original.nested));}).await;println!("{}",json!({"id":c.id,"phase":phase}));}});
}
