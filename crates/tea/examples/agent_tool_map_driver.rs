//! Actual finite public mapping consumer. JSON is only the fixture transport.
use demlik_tea::{
    Machine, PlainData as D, Step, Tagged, TryUpdate,
    agent::{
        self, AgentCommand, AgentError, GuardedSchema, PlainCalls, PlainToolCall,
        StructuredOutputError, ToolResilience, tool::ToolError, types::Conversation,
    },
    command::{CommandContractError, CommandFamily},
    core::try_subscriptions,
    data::{JsText, Sub, decode_json, plain_data, stringify_json},
    flow::fan_out::{FanOut, FanOutConfig},
    llm_call::{self, LlmCall},
    resilience::{deadline::deadline_exceeded, resilient_call::CallValue},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{
        self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence,
        Profile, RuntimeError,
    },
    storage::{Migrated, Store},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe {($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let result=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));result}};}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    fail_at: usize,
    concurrency: f64,
    policy: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    kind: String,
    profile: Option<String>,
    config: Config,
    actions: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    op: String,
    at: Option<f64>,
    ids: Option<Vec<String>>,
    id: Option<JsText>,
    turn: Option<Rc<D>>,
}
struct Ctx {
    trace: RefCell<Vec<D>>,
    calls: RefCell<Vec<&'static str>>,
    count: Cell<usize>,
    cause: Rc<ToolError>,
    owners: RefCell<BTreeMap<JsText, Rc<D>>>,
    work: Cell<usize>,
    saves: Cell<usize>,
}
impl Ctx {
    fn new() -> Self {
        Self {
            trace: RefCell::new(vec![]),
            calls: RefCell::new(vec![]),
            count: Cell::new(0),
            cause: Rc::new(ToolError::Reserved {
                name: "map_fault".into(),
            }),
            owners: RefCell::new(BTreeMap::new()),
            work: Cell::new(0),
            saves: Cell::new(0),
        }
    }
    fn mapped(&self, id: &JsText, fail: usize) -> Result<(), Rc<ToolError>> {
        self.trace
            .borrow_mut()
            .push(arr([text("toolOf"), text(id.clone())]));
        self.count.set(self.count.get() + 1);
        if self.count.get() == fail {
            Err(Rc::clone(&self.cause))
        } else {
            Ok(())
        }
    }
}
fn obj(v: impl IntoIterator<Item = (&'static str, D)>) -> D {
    D::Object(v.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(v: impl Into<JsText>) -> D {
    D::String(v.into())
}
fn arr(v: impl IntoIterator<Item = D>) -> D {
    D::Array(v.into_iter().collect())
}
fn wire<T: Serialize>(v: &T) -> D {
    decode_json(&stringify_json(&plain_data(v).unwrap()).unwrap()).unwrap()
}
fn trace(ctx: &Ctx) -> D {
    arr(ctx.trace.borrow().iter().cloned())
}
fn error(ctx: &Ctx, e: &AgentError) -> D {
    let same = matches!(e,AgentError::ToolMapping(cause)if Rc::ptr_eq(cause,&ctx.cause));
    obj([
        ("name", text(e.name())),
        ("message", text(e.to_string())),
        ("originalSame", D::Bool(same)),
    ])
}
#[derive(Serialize)]
struct Tool {
    #[serde(rename = "type")]
    kind: &'static str,
    call: Rc<PlainToolCall>,
}
impl Tagged for Tool {
    fn tag(&self) -> &str {
        self.kind
    }
}
enum Message {
    Turn { turn: Rc<D>, at: f64 },
}
impl Tagged for Message {
    fn tag(&self) -> &str {
        "mapping_turn"
    }
}
impl demlik_tea::core::Message for Message {
    const TYPES: &'static [&'static str] = &["mapping_turn"];
}
impl CommandFamily for Tool {
    type Msg = Message;
    type Completion = Vec<Message>;
    fn settle(self, v: Vec<Message>, _: f64) -> Result<Vec<Message>, CommandContractError> {
        Ok(v)
    }
}
type State = agent::StateOf<D, JsText, D, GuardedSchema, D, D, D, D, PlainCalls>;
type Knob = agent::Agent<'static, D, JsText, D, GuardedSchema, D, D, D, D, D, Tool, PlainCalls>;
type Command = agent::CommandOf<JsText, D, GuardedSchema, Tool>;
fn make(c: &Config, ctx: Rc<Ctx>) -> Knob {
    let schema = Rc::new(agent::types::AGENT_TURN_SCHEMA);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
        StructuredOutputError::describe,
    ));
    let mapper = Rc::clone(&ctx);
    let selector = Rc::clone(&ctx);
    let fail = c.fail_at;
    let policy = c.policy;
    let config = observe!(
        &ctx,
        demlik_tea::agent::AgentConfig::try_from_plain_turns,
        llm,
        vec![Rc::new(text("collect"))],
        |stage| match stage.map(Rc::as_ref) {
            Some(D::String(v)) => v.clone(),
            _ => "collect".into(),
        },
        move |call| {
            mapper.mapped(call.call_id(), fail)?;
            Ok(Tool {
                kind: "map_tool",
                call: Rc::clone(call),
            })
        },
        |stage, conv: &Rc<Conversation<D, D, D, D, PlainCalls>>, _| obj([
            ("stage", stage.map_or(D::Null, |v| v.as_ref().clone())),
            (
                "turnCount",
                conv.turn_count.number().map_or(D::Null, D::Number)
            )
        ])
    )
    .tool_concurrency(c.concurrency)
    .tool_resilience_of(move |call| {
        selector.trace.borrow_mut().push(arr([
            text("policy"),
            text(call.name().clone()),
            text(call.call_id().clone()),
        ]));
        policy.then(|| {
            ToolResilience::default().retry(RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 5.,
                    factor: 1.,
                    cap_ms: 5.,
                    jitter: Jitter::None,
                },
                budget: CountBound { max_attempts: 3. },
            })
        })
    });
    observe!(&ctx, demlik_tea::agent::create_agent, config)
}
fn remember(ctx: &Ctx, turn: &Rc<D>) {
    let D::Object(fields) = turn.as_ref() else {
        panic!("fixture turn")
    };
    let D::Array(calls) = &fields["toolCalls"] else {
        panic!("fixture calls")
    };
    for call in calls {
        let D::Object(call) = call else {
            panic!("fixture call")
        };
        let D::String(id) = &call["callId"] else {
            panic!("fixture id")
        };
        ctx.owners.borrow_mut().insert(id.clone(), Rc::clone(turn));
    }
}
fn identities(ctx: &Ctx, state: &State) -> D {
    let calls = state
        .tools
        .pending
        .iter()
        .chain(&state.tools.running)
        .chain(state.tools.done.iter().map(|v| &v.item))
        .chain(state.tools.failed.iter().map(|v| &v.item))
        .collect::<Vec<_>>();
    let same = calls.iter().all(|call| {
        ctx.owners
            .borrow()
            .get(call.call_id())
            .is_some_and(|root| Rc::ptr_eq(root, call.owner()))
    });
    obj([
        ("checks", D::Number(calls.len() as f64)),
        (
            "originalSame",
            if calls.is_empty() {
                D::Null
            } else {
                D::Bool(same)
            },
        ),
    ])
}
fn frame(
    ctx: &Ctx,
    knob: &Knob,
    op: &str,
    state: &Rc<State>,
    before: &Rc<State>,
    commands: &[Command],
    failure: Option<&AgentError>,
) -> D {
    obj([
        ("op", text(op)),
        ("state", wire(state)),
        ("commands", wire(&commands)),
        ("error", failure.map_or(D::Null, |e| error(ctx, e))),
        ("stateSame", D::Bool(Rc::ptr_eq(state, before))),
        ("trace", trace(ctx)),
        ("subs", wire(&knob.subs(state).unwrap())),
        ("inputIdentity", identities(ctx, state)),
    ])
}
#[derive(Serialize)]
struct Item {
    id: JsText,
}
#[derive(Serialize)]
struct FanResult {
    value: &'static str,
}
#[derive(Serialize)]
struct FanCall {
    #[serde(rename = "callId")]
    id: JsText,
    name: &'static str,
    args: BTreeMap<String, D>,
}
#[derive(Serialize)]
struct FanCommand {
    #[serde(rename = "type")]
    kind: &'static str,
    call: FanCall,
}
impl Tagged for FanCommand {
    fn tag(&self) -> &str {
        self.kind
    }
}
fn fan(spec: &Input, ctx: &Rc<Ctx>) -> D {
    let fan = FanOut::new(FanOutConfig::try_new(
        spec.config.concurrency,
        |i: &Item| i.id.clone(),
        |i| -> Result<FanCommand, Rc<ToolError>> {
            ctx.mapped(&i.id, spec.config.fail_at)?;
            Ok(FanCommand {
                kind: "map_tool",
                call: FanCall {
                    id: i.id.clone(),
                    name: "invoice",
                    args: BTreeMap::new(),
                },
            })
        },
    ));
    let mut state: Rc<demlik_tea::flow::fan_out::FanOutState<Item, FanResult>> = fan.init();
    let mut frames = vec![];
    for a in &spec.actions {
        let before = Rc::clone(&state);
        let step = match a.op.as_str() {
            "scatter" => observe!(
                ctx,
                demlik_tea::flow::fan_out::FanOut::try_scatter,
                &fan,
                &state,
                a.ids.as_ref().unwrap().iter().map(|id| Rc::new(Item {
                    id: id.as_str().into()
                }))
            ),
            "ok" => observe!(
                ctx,
                demlik_tea::flow::fan_out::FanOut::try_item_ok,
                &fan,
                &state,
                a.id.as_ref().unwrap(),
                Rc::new(FanResult { value: "checked" })
            ),
            _ => panic!("fixture fan action"),
        };
        let mut commands = vec![];
        let mut failure = None;
        match step {
            Ok(s) => {
                state = s.state;
                commands = s.commands
            }
            Err(e) => failure = Some(e),
        };
        frames.push(obj([
            ("op", text(a.op.clone())),
            ("state", wire(&state)),
            ("commands", wire(&commands)),
            (
                "error",
                failure.map_or(D::Null, |e| {
                    obj([
                        ("name", text(e.name())),
                        ("message", text(e.to_string())),
                        ("originalSame", D::Bool(Rc::ptr_eq(&e, &ctx.cause))),
                    ])
                }),
            ),
            ("stateSame", D::Bool(Rc::ptr_eq(&state, &before))),
            ("trace", trace(ctx)),
        ]));
    }
    obj([
        ("frames", arr(frames)),
        ("handlerWork", D::Number(0.)),
        ("saves", D::Number(0.)),
    ])
}
struct Retained {
    state: Rc<State>,
    ctx: Rc<Ctx>,
}
impl Store<Rc<State>> for Retained {
    type Raw = Rc<State>;
    type Error = Infallible;
    async fn load(&self) -> Result<Rc<State>, Infallible> {
        Ok(Rc::clone(&self.state))
    }
    async fn save(&self, _: &Rc<State>) -> Result<(), Infallible> {
        self.ctx.saves.set(self.ctx.saves.get() + 1);
        Ok(())
    }
    fn migrate(&self, raw: Rc<State>) -> Migrated<Rc<State>> {
        Migrated::State(raw)
    }
}
struct Handler(Rc<Ctx>);
impl Interpreter<Tool> for Handler {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Tool,
        _: CommandContext<Message, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Message>, Infallible>> {
        Some(CommandWork::new(async move {
            self.0.work.set(self.0.work.get() + 1);
            Ok(vec![])
        }))
    }
}
async fn runtime_case(spec: &Input, ctx: Rc<Ctx>, knob: Rc<Knob>) -> D {
    let started = knob.start(&knob.init(), "invoice-r", 10.).unwrap();
    let loaded = started.state;
    ctx.trace.borrow_mut().clear();
    ctx.count.set(0);
    let expected = Rc::clone(&loaded);
    let reducer = Rc::clone(&knob);
    let machine: Machine<'static, Rc<State>, Message, Tool, Sub<()>, (), AgentError> = Machine {
        init: Box::new(move |s, _| Step::new(s.unwrap_or_else(|| Rc::clone(&expected)), vec![])),
        update: TryUpdate::try_reducer(move |state, message| {
            let Message::Turn { turn, at } = message;
            reducer.turn(state, Rc::clone(turn), *at).map(|s| {
                Step::new(
                    s.state,
                    s.commands
                        .into_iter()
                        .filter_map(|c| {
                            if let AgentCommand::Tool(c) = c {
                                Some(c)
                            } else {
                                None
                            }
                        })
                        .collect(),
                )
            })
        }),
        subscriptions: try_subscriptions(|_| Ok(vec![])),
    };
    let profile = if spec.profile.as_deref() == Some("promise") {
        Profile::Promise
    } else {
        Profile::Effect
    };
    let mut options: Options<
        Rc<State>,
        Message,
        Infallible,
        Infallible,
        runtime::NoEvent,
        AgentError,
    > = Options::new(profile);
    options.clock = Rc::new(|| 11.);
    options.store = Some(Persistence::new(Retained {
        state: Rc::clone(&loaded),
        ctx: Rc::clone(&ctx),
    }));
    let reports = Rc::new(Cell::new(0));
    let same = Rc::new(Cell::new(true));
    let diagnostics = Rc::new(RefCell::new(vec![]));
    let rc = Rc::clone(&reports);
    let rs = Rc::clone(&same);
    let rd = Rc::clone(&diagnostics);
    let cc = Rc::clone(&ctx);
    options.on_error = Some(Rc::new(move |e, _phase| {
        rc.set(rc.get() + 1);
        let original = matches!(e,RuntimeError::Reduce(AgentError::ToolMapping(cause))if Rc::ptr_eq(cause,&cc.cause));
        rs.set(rs.get() && original);
        rd.borrow_mut().push(obj([
            ("name", text(e.name())),
            ("message", text(e.to_string())),
        ]));
    }));
    let live = observe!(
        &ctx,
        demlik_tea::runtime::try_launch,
        machine,
        (),
        Handler(Rc::clone(&ctx)),
        NoSubscriptions::new(),
        options
    );
    live.ready().await.unwrap();
    let before = ctx.saves.get();
    let action = &spec.actions[0];
    let turn = Rc::clone(action.turn.as_ref().unwrap());
    remember(&ctx, &turn);
    let rejected = live
        .dispatch(Message::Turn {
            turn,
            at: action.at.unwrap(),
        })
        .await
        .is_err();
    live.idle().await.unwrap();
    let state = Rc::clone(live.get_state().unwrap().as_ref());
    let transition_saves = ctx.saves.get() - before;
    live.stop().await;
    let stop_saves = ctx.saves.get() - before - transition_saves;
    obj([
        (
            "frames",
            arr([obj([
                ("op", text("dispatch")),
                ("state", wire(&state)),
                ("commands", arr([])),
                ("stateSame", D::Bool(Rc::ptr_eq(&state, &loaded))),
                ("trace", trace(&ctx)),
                (
                    "error",
                    obj([
                        ("rejected", D::Bool(rejected)),
                        ("reports", D::Number(reports.get() as f64)),
                        ("reportedSame", D::Bool(same.get())),
                    ]),
                ),
            ])]),
        ),
        ("handlerWork", D::Number(ctx.work.get() as f64)),
        ("saves", D::Number((transition_saves + stop_saves) as f64)),
        ("transitionSaves", D::Number(transition_saves as f64)),
        ("stopSaves", D::Number(stop_saves as f64)),
        ("diagnostics", arr(diagnostics.borrow().iter().cloned())),
    ])
}
async fn execute(spec: &Input, ctx: Rc<Ctx>) -> D {
    if spec.kind == "fan" {
        return fan(spec, &ctx);
    }
    let knob = Rc::new(make(&spec.config, Rc::clone(&ctx)));
    if spec.kind == "runtime" {
        return runtime_case(spec, ctx, knob).await;
    }
    let mut state = knob.init();
    let mut frames = vec![];
    let mut brain = None;
    for a in &spec.actions {
        let before = Rc::clone(&state);
        let at = a.at.unwrap_or(0.);
        let step = match a.op.as_str() {
            "start" => observe!(
                &ctx,
                demlik_tea::agent::Agent::start,
                knob.as_ref(),
                &state,
                "invoice-r",
                at
            ),
            "turn" => {
                let turn = Rc::clone(a.turn.as_ref().unwrap());
                remember(&ctx, &turn);
                observe!(
                    &ctx,
                    demlik_tea::agent::Agent::turn,
                    knob.as_ref(),
                    &state,
                    turn,
                    at
                )
            }
            "succeed" => {
                let command: llm_call::RunCmd<JsText, D, Rc<D>, StructuredOutputError> =
                    brain.take().unwrap();
                let turn = Rc::clone(a.turn.as_ref().unwrap());
                remember(&ctx, &turn);
                let value = llm_call::LlmOk {
                    key: command.input().key.clone(),
                    purpose: "collect".into(),
                    output: turn,
                };
                let msg = knob
                    .brain()
                    .ok(command, CallValue::shared(Rc::new(value)), Some(at));
                observe!(
                    &ctx,
                    demlik_tea::agent::Agent::succeed,
                    knob.as_ref(),
                    &state,
                    &msg,
                    at
                )
            }
            "toolOk" => observe!(
                &ctx,
                demlik_tea::agent::Agent::tool_ok,
                knob.as_ref(),
                &state,
                a.id.as_ref().unwrap(),
                Rc::new(obj([("value", text("checked"))])),
                at
            ),
            "toolErr" => observe!(
                &ctx,
                demlik_tea::agent::Agent::tool_err,
                knob.as_ref(),
                &state,
                a.id.as_ref().unwrap(),
                Rc::new(obj([
                    ("kind", text("error")),
                    ("reason", text("business failure"))
                ])),
                at
            ),
            "boot" => observe!(
                &ctx,
                demlik_tea::agent::Agent::boot,
                knob.as_ref(),
                &state,
                at
            ),
            "timer" => observe!(
                &ctx,
                demlik_tea::agent::Agent::on_timer,
                knob.as_ref(),
                &state,
                &deadline_exceeded(a.id.as_ref().unwrap().clone(), at, None)
            ),
            _ => panic!("fixture agent action"),
        };
        let mut commands = vec![];
        let mut failure = None;
        match step {
            Ok(s) => {
                state = s.state;
                commands = s.commands
            }
            Err(e) => failure = Some(e),
        };
        frames.push(frame(
            &ctx,
            &knob,
            &a.op,
            &state,
            &before,
            &commands,
            failure.as_ref(),
        ));
        if a.op == "start" {
            for c in commands {
                if let AgentCommand::Brain(cmd) = c {
                    brain = Some(cmd);
                }
            }
        }
    }
    obj([
        ("frames", arr(frames)),
        ("handlerWork", D::Number(0.)),
        ("saves", D::Number(0.)),
    ])
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let line = line.unwrap();
                let spec: Input = serde_json::from_str(&line).unwrap();
                let ctx = Rc::new(Ctx::new());
                let output = execute(&spec, Rc::clone(&ctx)).await;
                println!(
                    "{}",
                    serde_json::to_string(&obj([
                        ("id", text(spec.id)),
                        ("ok", D::Bool(true)),
                        ("output", output),
                        ("observedCalls", wire(&ctx.calls.borrow().as_slice()))
                    ]))
                    .unwrap()
                );
            }
        })
        .await;
}
