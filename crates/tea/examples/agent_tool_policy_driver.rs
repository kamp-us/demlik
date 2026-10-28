//! Public pure tool-policy consumer. JSON is only the test transport.
use demlik_tea::{
    PlainData as D, Tagged,
    agent::{
        self, GuardedSchema, PlainCalls, PlainToolCall, StructuredOutputError, ToolResilience,
        types::Conversation,
    },
    data::{JsText, decode_json, plain_data, stringify_json},
    llm_call::{self, LlmCall},
    resilience::deadline::deadline_exceeded,
    retry_backoff::{BackoffCurve, CountBound, DurationBound, Jitter, RetryPolicy, Unbounded},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe{($ctx:expr,$f:path $(,$arg:expr)*$(,)?)=>{{let result=$f($($arg),*);$ctx.calls.borrow_mut().push(stringify!($f));result}};}
#[derive(Deserialize)]
struct Frame {
    id: String,
    input: Box<RawValue>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default)]
    policies: Vec<Rule>,
    #[serde(default)]
    omit_selector: bool,
    concurrency: Option<f64>,
    rng: Option<Vec<f64>>,
    stages: Option<Vec<Rc<D>>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rule {
    name: JsText,
    call_id: Option<JsText>,
    policy: Option<Policy>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    timeout_ms: Option<D>,
    retry: Option<Retry>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retry {
    base_ms: D,
    factor: D,
    cap_ms: D,
    jitter: String,
    max_attempts: Option<D>,
    max_elapsed_ms: Option<D>,
    unbounded: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    mode: String,
    #[serde(default)]
    config: Config,
    actions: Vec<Box<RawValue>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Action {
    op: String,
    at: Option<D>,
    run_id: Option<JsText>,
    turn: Option<Rc<D>>,
    id: Option<JsText>,
    name: Option<JsText>,
    result: Option<Rc<D>>,
    error: Option<Rc<D>>,
    reason: Option<JsText>,
    config: Option<Box<RawValue>>,
    value: Option<D>,
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
type State = agent::StateOf<D, JsText, D, GuardedSchema, D, D, D, D, PlainCalls>;
type Knob = agent::Agent<'static, D, JsText, D, GuardedSchema, D, D, D, D, D, Tool, PlainCalls>;
#[derive(Default)]
struct Ctx {
    trace: RefCell<Vec<D>>,
    calls: RefCell<Vec<&'static str>>,
    rng: Cell<usize>,
}
fn obj(fields: impl IntoIterator<Item = (&'static str, D)>) -> D {
    D::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(s: impl Into<JsText>) -> D {
    D::String(s.into())
}
fn arr(v: impl IntoIterator<Item = D>) -> D {
    D::Array(v.into_iter().collect())
}
fn wire<T: Serialize>(v: &T) -> D {
    decode_json(&stringify_json(&plain_data(v).unwrap()).unwrap()).unwrap()
}
fn num(v: &D) -> f64 {
    match v {
        D::Number(v) => *v,
        D::String(s) => match s.as_utf8() {
            Some("NaN") => f64::NAN,
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            Some("-0") => -0.0,
            _ => panic!("numeric marker"),
        },
        D::Null | D::Undefined => 0.0,
        _ => panic!("numeric field"),
    }
}
fn name(s: &D) -> Option<&JsText> {
    match s {
        D::Object(v) => match v.get("name") {
            Some(D::String(s)) => Some(s),
            _ => None,
        },
        _ => None,
    }
}
fn make(config: Config, ctx: Rc<Ctx>) -> Knob {
    let schema = Rc::new(agent::types::AGENT_TURN_SCHEMA);
    let c = Rc::clone(&ctx);
    let values = config.rng.clone().unwrap_or(vec![0.25, 0.75, 0.5]);
    let llm = Rc::new(
        LlmCall::new(
            llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
            StructuredOutputError::describe,
        )
        .with_rng(move || {
            let index = c.rng.get();
            c.rng.set(index + 1);
            let n = values[index % values.len()];
            c.trace.borrow_mut().push(arr([text("rng"), D::Number(n)]));
            n
        }),
    );
    let stages = config.stages.unwrap_or_else(|| {
        ["collect", "check", "summarize"]
            .into_iter()
            .map(|name| Rc::new(obj([("name", text(name))])))
            .collect()
    });
    let turn = Rc::clone(&ctx);
    let tool = Rc::clone(&ctx);
    let payload = Rc::clone(&ctx);
    let mut cfg = observe!(
        &ctx,
        demlik_tea::agent::AgentConfig::from_plain_turns,
        llm,
        stages,
        move |s| {
            let p = s
                .and_then(|s| name(s))
                .cloned()
                .unwrap_or_else(|| "solo".into());
            turn.trace
                .borrow_mut()
                .push(arr([text("turnOf"), text(p.clone())]));
            p
        },
        move |call| {
            tool.trace
                .borrow_mut()
                .push(arr([text("toolOf"), text(call.call_id().clone())]));
            Tool {
                kind: "policy_tool",
                call: Rc::clone(call),
            }
        },
        move |s, conv: &Rc<Conversation<D, D, D, D, PlainCalls>>, instructions| {
            let name = s.and_then(|s| name(s)).cloned();
            let at = conv.turn_count.number().map_or(D::Null, D::Number);
            payload.trace.borrow_mut().push(arr([
                text("payloadOf"),
                name.map_or(D::Null, text),
                at.clone(),
                instructions.cloned().map_or(D::Null, text),
            ]));
            obj([
                ("stage", s.map_or(D::Null, |s| s.as_ref().clone())),
                ("turnCount", at),
                ("instructions", instructions.cloned().map_or(D::Null, text)),
            ])
        }
    )
    .tool_concurrency(config.concurrency.unwrap_or(1.0));
    if !config.omit_selector {
        let c = Rc::clone(&ctx);
        let rules = config.policies;
        cfg = observe!(
            &ctx,
            demlik_tea::agent::AgentConfig::tool_resilience_of,
            cfg,
            move |call| {
                c.trace.borrow_mut().push(arr([
                    text("policy"),
                    text(call.name().clone()),
                    text(call.call_id().clone()),
                ]));
                let rule = rules
                    .iter()
                    .find(|r| r.name == *call.name() && r.call_id.as_ref() == Some(call.call_id()))
                    .or_else(|| {
                        rules
                            .iter()
                            .find(|r| r.name == *call.name() && r.call_id.is_none())
                    })?;
                let p = rule.policy.as_ref()?;
                let mut value = ToolResilience::default();
                if let Some(ms) = &p.timeout_ms {
                    value = value.timeout_ms(num(ms))
                };
                if let Some(r) = &p.retry {
                    let curve = BackoffCurve {
                        base_ms: num(&r.base_ms),
                        factor: num(&r.factor),
                        cap_ms: num(&r.cap_ms),
                        jitter: match r.jitter.as_str() {
                            "none" => Jitter::None,
                            "full" => Jitter::Full,
                            "equal" => Jitter::Equal,
                            _ => panic!("jitter"),
                        },
                    };
                    value.retry = Some(if r.unbounded == Some(true) {
                        RetryPolicy {
                            curve,
                            budget: Unbounded,
                        }
                        .into_any()
                    } else if let Some(ms) = &r.max_elapsed_ms {
                        RetryPolicy {
                            curve,
                            budget: DurationBound {
                                max_elapsed_ms: num(ms),
                                max_attempts: r.max_attempts.as_ref().map(num),
                            },
                        }
                        .into_any()
                    } else {
                        RetryPolicy {
                            curve,
                            budget: CountBound {
                                max_attempts: num(r.max_attempts.as_ref().expect("budget")),
                            },
                        }
                        .into_any()
                    });
                }
                Some(value)
            }
        );
    }
    observe!(&ctx, demlik_tea::agent::create_agent, cfg)
}
fn patch_remaining(state: &Rc<State>, name: &JsText, id: &JsText, value: D) -> Rc<State> {
    let mut data = wire(state);
    let D::Object(ref mut s) = data else {
        unreachable!()
    };
    let D::Object(ref mut maps) = s["toolResilience"] else {
        unreachable!()
    };
    let D::Object(ref mut slice) = maps[name] else {
        unreachable!()
    };
    let D::Object(ref mut calls) = slice["calls"] else {
        unreachable!()
    };
    let key = JsText::from_units(
        [
            "$tool:".encode_utf16().collect::<Vec<_>>(),
            name.as_units().to_vec(),
            vec![35],
            id.as_units().to_vec(),
        ]
        .concat(),
    );
    let D::Object(ref mut phase) = calls[&key] else {
        unreachable!()
    };
    let D::Object(ref mut budget) = phase["budget"] else {
        unreachable!()
    };
    budget.insert("remainingMs".into(), value);
    serde_json::from_str(&stringify_json(&data).unwrap()).unwrap()
}
fn execute(input: Input) -> Result<D, String> {
    if input.mode != "pure" {
        return Err("pure mode required".into());
    }
    let ctx = Rc::new(Ctx::default());
    let mut config = input.config;
    let mut knob = make(config.clone(), Rc::clone(&ctx));
    let mut state = observe!(&ctx, demlik_tea::agent::Agent::init, &knob);
    let mut frames = vec![];
    let snapshot = |op: &str,
                    s: &Rc<State>,
                    commands: &Vec<
        agent::CommandOf<
            JsText,
            D,
            GuardedSchema,
            Tool,
            agent::compaction::NoCompaction,
            agent::snapshot::NoSnapshot,
        >,
    >,
                    error: Option<&agent::AgentError>| {
        let mut fields = vec![
            ("op", text(op)),
            ("state", wire(s)),
            ("commands", wire(commands)),
        ];
        match observe!(&ctx, demlik_tea::agent::Agent::subs, &knob, s.as_ref()) {
            Ok(v) => fields.push(("subs", wire(&v))),
            Err(e) => {
                fields.push(("subs", arr([])));
                fields.push((
                    "subsError",
                    obj([("name", text(e.name())), ("message", text(e.to_string()))]),
                ));
            }
        }
        fields.push(("trace", arr(ctx.trace.borrow().iter().cloned())));
        if let Some(e) = error {
            fields.push((
                "error",
                obj([("name", text(e.name())), ("message", text(e.to_string()))]),
            ));
        }
        obj(fields)
    };
    frames.push(snapshot("init", &state, &vec![], None));

    for raw in input.actions {
        let a: Action = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
        let at = a.at.as_ref().map_or(0.0, num);
        let mut commands = vec![];
        let mut error = None;
        let step = match a.op.as_str() {
            "start" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::start,
                &knob,
                &state,
                a.run_id.unwrap_or_else(|| "invoice-r".into()),
                at
            )),
            "turn" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::turn,
                &knob,
                &state,
                a.turn.ok_or("turn")?,
                at
            )),
            "toolOk" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::tool_ok,
                &knob,
                &state,
                a.id.ok_or("id")?,
                a.result.unwrap_or_else(|| Rc::new(D::Undefined)),
                at
            )),
            "toolErr" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::tool_err,
                &knob,
                &state,
                a.id.ok_or("id")?,
                a.error.unwrap_or_else(|| Rc::new(obj([
                    ("kind", text("error")),
                    ("reason", a.reason.map_or(D::Undefined, text))
                ]))),
                at
            )),
            "boot" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::boot,
                &knob,
                &state,
                at
            )),
            "cancel" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::cancel,
                &knob,
                &state,
                at
            )),
            "timer" => Some(observe!(
                &ctx,
                demlik_tea::agent::Agent::on_timer,
                &knob,
                &state,
                &deadline_exceeded(a.id.ok_or("id")?, at, None)
            )),
            "roundTrip" => {
                state = serde_json::from_str(&stringify_json(&wire(&state)).unwrap())
                    .map_err(|e| e.to_string())?;
                None
            }
            "cold" => {
                state = serde_json::from_str(&stringify_json(&wire(&state)).unwrap())
                    .map_err(|e| e.to_string())?;
                let mut data = serde_json::to_value(&config).map_err(|e| e.to_string())?;
                let patch: serde_json::Value =
                    serde_json::from_str(a.config.ok_or("config")?.get())
                        .map_err(|e| e.to_string())?;
                data.as_object_mut()
                    .unwrap()
                    .extend(patch.as_object().ok_or("config object")?.clone());
                config = serde_json::from_value(data).map_err(|e| e.to_string())?;
                ctx.rng.set(0);
                knob = make(config.clone(), Rc::clone(&ctx));
                None
            }
            "remaining" => {
                state = patch_remaining(
                    &state,
                    &a.name.ok_or("name")?,
                    &a.id.ok_or("id")?,
                    a.value.unwrap_or(D::Null),
                );
                None
            }
            "readSubs" => {
                let _ = observe!(&ctx, demlik_tea::agent::Agent::subs, &knob, state.as_ref());
                None
            }
            _ => return Err("unknown action".into()),
        };
        if let Some(step) = step {
            match step {
                Ok(step) => {
                    state = step.state;
                    commands = step.commands
                }
                Err(e) => error = Some(e),
            }
        }
        let mut fields = vec![
            ("op", text(a.op)),
            ("state", wire(&state)),
            ("commands", wire(&commands)),
        ];
        match observe!(&ctx, demlik_tea::agent::Agent::subs, &knob, state.as_ref()) {
            Ok(v) => fields.push(("subs", wire(&v))),
            Err(e) => {
                fields.push(("subs", arr([])));
                fields.push((
                    "subsError",
                    obj([("name", text(e.name())), ("message", text(e.to_string()))]),
                ));
            }
        }
        fields.push(("trace", arr(ctx.trace.borrow().iter().cloned())));
        if let Some(e) = error {
            fields.push((
                "error",
                obj([("name", text(e.name())), ("message", text(e.to_string()))]),
            ));
        }
        frames.push(obj(fields));
    }
    Ok(obj([
        ("view", obj([("frames", arr(frames))])),
        (
            "nativeTrace",
            arr(ctx.calls.borrow().iter().map(|s| text(*s))),
        ),
    ]))
}
fn main() {
    for line in io::stdin().lock().lines() {
        let out = (|| {
            let frame: Frame = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let input: Input =
                serde_json::from_str(frame.input.get()).map_err(|e| e.to_string())?;
            let result = execute(input)?;
            let D::Object(mut fields) = result else {
                unreachable!()
            };
            fields.insert("id".into(), text(frame.id));
            Ok::<_, String>(D::Object(fields))
        })();
        let value = out.unwrap_or_else(|e| obj([("id", D::Null), ("error", text(e))]));
        println!("{}", stringify_json(&value).unwrap());
    }
}
