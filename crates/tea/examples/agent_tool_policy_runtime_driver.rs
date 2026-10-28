//! Actual local actor/deadline/file-store tool-policy workflow.
use demlik_tea::{
    PlainData as D, Tagged,
    agent::{
        self, AgentMachineMsg, AgentToolMsg, AgentWorkError, GuardedSchema, PlainCalls,
        PlainToolCall, StructuredOutputError, ToolResilience,
        model::{Messages, NoMessages, plain_model},
        types::Conversation,
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, decode_json, plain_data, stringify_json},
    file_store::file_store,
    llm_call::{self, LlmCall},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile},
    storage::{Migrated, refuse},
    timing::{Timer, TimerCallback, TimerError},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    io::{self, BufRead},
    path::PathBuf,
    rc::{Rc, Weak},
};
use tokio::sync::Notify;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    id: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: String,
    profile: String,
    scenario: String,
    path: PathBuf,
}
#[derive(Serialize, Deserialize)]
struct Payload {
    conversation: Rc<Conversation<D, D, D, D, PlainCalls>>,
}
type State = agent::StateOf<JsText, JsText, Payload, GuardedSchema, D, D, D, D, PlainCalls>;
type Msg = AgentMachineMsg<JsText, Payload, Rc<D>, StructuredOutputError, AgentToolMsg<D>>;
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "policy_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<D>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Self::Completion, CommandContractError> {
        Ok(messages)
    }
}
struct Row {
    due: f64,
    callback: Option<TimerCallback>,
}
struct Ctx {
    directory: PathBuf,
    mode: String,
    scenario: String,
    now: Cell<f64>,
    models: Cell<usize>,
    tools: Cell<usize>,
    cursor: Cell<usize>,
    attempts: RefCell<HashMap<JsText, usize>>,
    trace: RefCell<Vec<Value>>,
    timer_log: RefCell<Vec<Value>>,
    commits: RefCell<Vec<Value>>,
    timers: RefCell<Vec<Row>>,
    entered: Notify,
    release: Notify,
    tool_entered: Cell<bool>,
    loaded: RefCell<Option<Weak<State>>>,
    decode_errors: RefCell<Vec<serde_json::Error>>,
    calls: RefCell<Vec<&'static str>>,
}
impl Ctx {
    fn fire(&self) -> bool {
        let index = self
            .timers
            .borrow()
            .iter()
            .enumerate()
            .filter(|(_, r)| r.callback.is_some())
            .min_by(|(_, a), (_, b)| a.due.total_cmp(&b.due))
            .map(|(i, _)| i);
        let Some(i) = index else { return false };
        let (due, callback) = {
            let mut rows = self.timers.borrow_mut();
            let row = &mut rows[i];
            (row.due, row.callback.take().unwrap())
        };
        self.now.set(due);
        self.timer_log.borrow_mut().push(json!(["fire", due]));
        callback().unwrap();
        true
    }
}
struct ManualTimer(Rc<Ctx>);
impl Timer for ManualTimer {
    type Handle = usize;
    fn now_ms(&self) -> f64 {
        self.0.now.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<usize, TimerError> {
        let due = self.0.now.get() + ms;
        let mut rows = self.0.timers.borrow_mut();
        let id = rows.len();
        rows.push(Row {
            due,
            callback: Some(callback),
        });
        self.0.timer_log.borrow_mut().push(json!(["arm", due]));
        Ok(id)
    }
    fn clear_timeout(&self, id: &usize) {
        let due = {
            let mut rows = self.0.timers.borrow_mut();
            let row = &mut rows[*id];
            row.callback = None;
            row.due
        };
        self.0.timer_log.borrow_mut().push(json!(["cancel", due]));
    }
}
struct Tools(Rc<Ctx>);
impl Interpreter<Tool, Msg> for Tools {
    type Error = AgentWorkError<io::Error>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<D>>, Self::Error>> {
        Some(CommandWork::new(async move {
            let ctx = &self.0;
            ctx.tools.set(ctx.tools.get() + 1);
            let id = cmd.0.call_id().clone();
            let attempt = {
                let mut attempts = ctx.attempts.borrow_mut();
                let count = attempts.entry(id.clone()).or_insert(0);
                *count += 1;
                *count
            };
            ctx.trace.borrow_mut().push(json!(["tool", id, attempt]));
            let contents = tokio::fs::read_to_string(ctx.directory.join("invoice.json"))
                .await
                .map_err(AgentWorkError::Tool)?;
            let invoice: Value = serde_json::from_str(&contents)
                .map_err(|e| AgentWorkError::Tool(io::Error::new(io::ErrorKind::InvalidData, e)))?;
            if ctx.scenario == "timeout-late" && id.as_utf8() == Some("collect-1") {
                ctx.tool_entered.set(true);
                ctx.entered.notify_waiters();
                ctx.release.notified().await;
            }
            let failed = id.as_utf8() == Some("collect-1")
                && ctx.scenario != "timeout-late"
                && ((ctx.scenario == "retry-exhaust" && attempt <= 2)
                    || (ctx.scenario != "retry-exhaust" && attempt == 1 && ctx.mode != "reader"));
            if failed {
                return Ok(vec![AgentToolMsg::Err {
                    call_id: id,
                    reason: "offline".into(),
                    at: ctx.now.get(),
                }]);
            }
            let check = matches!(cmd.0.args(),D::Object(fields)if matches!(fields.get("op"),Some(D::String(op))if op.as_utf8()==Some("check")));
            let result = if check {
                let sum: f64 = invoice["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_f64().unwrap())
                    .sum();
                json!({"valid":sum==invoice["total"].as_f64().unwrap(),"total":invoice["total"]})
            } else {
                invoice
            };
            if check {
                tokio::fs::write(
                    ctx.directory.join("checked.json"),
                    serde_json::to_string(&result).unwrap(),
                )
                .await
                .map_err(AgentWorkError::Tool)?;
            }
            Ok(vec![AgentToolMsg::Ok {
                call_id: id,
                result: Rc::new(decode_json(&serde_json::to_string(&result).unwrap()).unwrap()),
                at: ctx.now.get(),
            }])
        }))
    }
}
fn wire<T: Serialize>(v: &T) -> Value {
    serde_json::from_str(&stringify_json(&plain_data(v).unwrap()).unwrap()).unwrap()
}
macro_rules! observe{($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let value=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));value}};}
async fn execute(input: Input) -> Value {
    let mode = input.mode.clone();
    std::fs::create_dir_all(&input.path).unwrap();
    if mode != "reader" {
        tokio::fs::write(
            input.path.join("invoice.json"),
            r#"{"invoice":"inv-17","lines":[4.5,10.5],"total":15}"#,
        )
        .await
        .unwrap();
    }
    let ctx = Rc::new(Ctx {
        directory: input.path.clone(),
        mode: mode.clone(),
        scenario: input.scenario,
        now: Cell::new(if mode == "reader" { 500.25 } else { 17.25 }),
        models: Cell::new(0),
        tools: Cell::new(0),
        cursor: Cell::new(if mode == "reader" { 1 } else { 0 }),
        attempts: RefCell::new(HashMap::new()),
        trace: RefCell::new(vec![]),
        timer_log: RefCell::new(vec![]),
        commits: RefCell::new(vec![]),
        timers: RefCell::new(vec![]),
        entered: Notify::new(),
        release: Notify::new(),
        tool_entered: Cell::new(false),
        loaded: RefCell::new(None),
        decode_errors: RefCell::new(vec![]),
        calls: RefCell::new(vec![]),
    });
    let schema = Rc::new(agent::types::AGENT_TURN_SCHEMA);
    let llm = Rc::new(
        LlmCall::new(
            llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
            StructuredOutputError::describe,
        )
        .with_rng({
            let ctx = Rc::clone(&ctx);
            move || {
                ctx.trace.borrow_mut().push(json!(["rng", 0.25]));
                0.25
            }
        }),
    );
    let tool = Rc::clone(&ctx);
    let policy = Rc::clone(&ctx);
    let cfg = observe!(
        &ctx,
        demlik_tea::agent::AgentConfig::from_plain_turns,
        llm,
        ["collect", "check", "summarize"]
            .into_iter()
            .map(|s| Rc::new(JsText::from(s)))
            .collect(),
        |stage| stage.unwrap().as_ref().clone(),
        move |call| {
            tool.trace.borrow_mut().push(json!(["of", call.call_id()]));
            Tool(Rc::clone(call))
        },
        |_, conversation: &Rc<Conversation<D, D, D, D, PlainCalls>>, _| Payload {
            conversation: Rc::clone(conversation)
        }
    );
    let cfg = observe!(
        &ctx,
        demlik_tea::agent::AgentConfig::tool_resilience_of,
        cfg,
        move |call| {
            policy
                .trace
                .borrow_mut()
                .push(json!(["policy", call.name(), call.call_id()]));
            if policy.scenario == "none" {
                return None;
            }
            if policy.scenario == "empty" {
                return Some(ToolResilience::default());
            }
            let value = ToolResilience::default().timeout_ms(50.0);
            Some(if policy.scenario == "timeout-late" {
                value
            } else {
                value.retry(RetryPolicy {
                    curve: BackoffCurve {
                        base_ms: 10.0,
                        factor: 1.0,
                        cap_ms: 100.0,
                        jitter: Jitter::None,
                    },
                    budget: CountBound {
                        max_attempts: if policy.scenario == "retry-exhaust" {
                            2.0
                        } else {
                            3.0
                        },
                    },
                })
            })
        }
    );
    let knob = Rc::new(observe!(&ctx, demlik_tea::agent::create_agent, cfg));
    let model_ctx = Rc::clone(&ctx);
    let model = plain_model(async move |_: Messages<'_, ()>| {
        let index = model_ctx.cursor.get();
        model_ctx.cursor.set(index + 1);
        model_ctx.models.set(model_ctx.models.get() + 1);
        model_ctx.trace.borrow_mut().push(json!(["model", index]));
        let op = if index == 0 {
            Some("collect")
        } else if index == 2 {
            Some("check")
        } else {
            None
        };
        let raw = if let Some(op) = op {
            json!({"content":op,"toolCalls":[{"callId":format!("{op}-1"),"name":"lookup","args":{"op":op,"file":"invoice.json"}}]})
        } else {
            json!({"content":if index==4{"invoice verified:15"}else{"stage complete"},"toolCalls":[]})
        };
        Ok::<_, demlik_tea::resilience::resilient_call::CallValue<StructuredOutputError>>(Rc::new(
            decode_json(&serde_json::to_string(&raw).unwrap()).unwrap(),
        ))
    });
    let wired = observe!(
        &ctx,
        demlik_tea::agent::Agent::to_machine,
        Rc::clone(&knob),
        model,
        NoMessages,
        Tools(Rc::clone(&ctx)),
        Rc::new(ManualTimer(Rc::clone(&ctx)))
    );
    let parse = Rc::clone(&ctx);
    let store = file_store(input.path.join("state.json"), move |raw| {
        if demlik_tea::storage::Nullish::is_nullish(&raw) {
            return Migrated::Fresh;
        }
        match serde_json::from_str::<State>(&stringify_json(&raw).unwrap()) {
            Ok(state) => {
                let state = Rc::new(state);
                parse.loaded.replace(Some(Rc::downgrade(&state)));
                Migrated::State(state)
            }
            Err(error) => {
                let refusal = refuse(format!("tool-policy fixture State decoder: {error}"));
                parse.decode_errors.borrow_mut().push(error);
                Migrated::Refused(refusal)
            }
        }
    });
    let mut options = Options::new(if input.profile == "effect" {
        Profile::Effect
    } else {
        Profile::Promise
    });
    options.store = Some(runtime::Persistence::new(store));
    let clock = Rc::clone(&ctx);
    options.clock = Rc::new(move || clock.now.get());
    options.terminal = Some(Rc::new(|s: &Rc<State>| s.is_settled()));
    let run = observe!(
        &ctx,
        demlik_tea::runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        options
    );
    observe!(&ctx, demlik_tea::runtime::Runtime::ready, &run)
        .await
        .unwrap();
    let ready = run.get_state().unwrap();
    let ready_view = wire(ready.as_ref());
    let loaded_identity = match ctx.loaded.borrow().as_ref() {
        None => json!({"status":"not-applicable","checks":0,"same":null}),
        Some(weak) => {
            json!({"status":"tracked","checks":1,"same":weak.upgrade().is_some_and(|s|Rc::ptr_eq(&s,ready.as_ref()))})
        }
    };
    let observer = Rc::clone(&ctx);
    let _off=run.observe(move|msg,state|{let model = wire(state);observer.commits.borrow_mut().push(json!({"tag":msg.tag(),"run":model["run"]["phase"],"lifecycle":model["lifecycle"],"awaiting":state.conversation.as_ref().map(|c|wire(&c.awaiting)),"records":state.conversation.as_ref().map_or_else(||json!([]),|c|wire(&c.tool_records))}));});
    let message: Msg = if mode == "reader" {
        Msg::boot(ctx.now.get())
    } else {
        AgentMachineMsg::Start {
            run_id: "policy-run".into(),
            at: ctx.now.get(),
        }
    };
    if ctx.scenario == "timeout-late" {
        let pending = run.dispatch(message);
        tokio::pin!(pending);
        while !ctx.tool_entered.get() {
            let entered = ctx.entered.notified();
            tokio::select! {answer=&mut pending=>panic!("held tool escaped {answer:?}"),_=entered=>{}}
        }
        assert!(ctx.fire());
        ctx.release.notify_one();
        pending.await.unwrap();
        run.idle().await.unwrap();
    } else {
        observe!(&ctx, demlik_tea::runtime::Runtime::dispatch, &run, message)
            .await
            .unwrap();
        run.idle().await.unwrap();
    }
    if mode == "writer" {
        let bytes = tokio::fs::read_to_string(input.path.join("state.json"))
            .await
            .unwrap();
        let state = wire(run.get_state().unwrap().as_ref());
        run.stop().await;
        return json!({"view":{"ready":ready_view,"loadedIdentity":loaded_identity,"state":state,"checkpointBytes":bytes,"models":ctx.models.get(),"tools":ctx.tools.get(),"trace":ctx.trace.borrow().clone(),"timerLog":ctx.timer_log.borrow().clone(),"commits":ctx.commits.borrow().clone(),"reports":[]},"nativeTrace":ctx.calls.borrow().clone()});
    }
    if ctx.scenario == "cancel-waiting" {
        ctx.now.set(ctx.now.get() + 1.0);
        observe!(
            &ctx,
            demlik_tea::runtime::Runtime::dispatch,
            &run,
            Msg::cancel(ctx.now.get())
        )
        .await
        .unwrap();
        run.idle().await.unwrap();
    }
    let mut fires = 0;
    while run.result().is_none() && fires < 8 {
        if !ctx.fire() {
            break;
        }
        fires += 1;
        run.idle().await.unwrap();
    }
    let final_state = if run.result().is_some() {
        run.done().await.unwrap()
    } else {
        run.get_state().unwrap()
    };
    run.stop().await;
    let checked = tokio::fs::read_to_string(input.path.join("checked.json"))
        .await
        .ok()
        .map(|s| serde_json::from_str::<Value>(&s).unwrap());
    let reports = run
        .reports()
        .iter()
        .map(|r| format!("{:?}", r.error))
        .collect::<Vec<_>>();
    assert!(ctx.decode_errors.borrow().is_empty());
    json!({"view":{"ready":ready_view,"loadedIdentity":loaded_identity,"state":wire(final_state.as_ref()),"models":ctx.models.get(),"tools":ctx.tools.get(),"trace":ctx.trace.borrow().clone(),"timerLog":ctx.timer_log.borrow().clone(),"commits":ctx.commits.borrow().clone(),"reports":reports,"checked":checked,"liveTimers":ctx.timers.borrow().iter().filter(|r|r.callback.is_some()).count()},"nativeTrace":ctx.calls.borrow().clone()})
}
fn main() {
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        for line in io::stdin().lock().lines() {
            let frame: Frame = serde_json::from_str(&line.unwrap()).unwrap();
            let mut out = execute(frame.input).await;
            out.as_object_mut()
                .unwrap()
                .insert("id".into(), json!(frame.id));
            println!("{out}");
        }
    });
}
