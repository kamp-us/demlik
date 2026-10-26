use demlik_tea::{
    PlainData, Tagged,
    agent::{
        Agent, AgentCommand, AgentError, BrainCommandOf, StateOf,
        types::{
            AgentFailure, AgentField, AgentLifecycleNote, AgentNumber, AgentTurn, Awaiting,
            Conversation, ToolCall, ToolOutcome,
        },
    },
    data::{JsText, decode_json, plain_data, stringify_json},
    llm_call::{self, LlmCall, LlmCause, Rejected, Schema},
    resilience::{
        deadline::{DeadlineExceeded, deadline_exceeded},
        resilient_call::{CallValue, RunError, RunInput},
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "non_null")]
    stages: Option<Vec<Rc<PlainData>>>,
    #[serde(default, deserialize_with = "non_null")]
    instructions: Option<JsText>,
    tool_concurrency: Option<PlainData>,
    #[serde(default, deserialize_with = "non_null")]
    deadline_ms: Option<f64>,
    #[serde(default, deserialize_with = "non_null")]
    retry: Option<f64>,
    #[serde(default, deserialize_with = "non_null")]
    max_turns: Option<f64>,
    #[serde(default, deserialize_with = "non_null")]
    max_elapsed_ms: Option<f64>,
    #[serde(default, deserialize_with = "non_null")]
    stop_after: Option<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    #[serde(default)]
    config: Config,
    actions: Vec<Box<RawValue>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    id: String,
    script: Script,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Action {
    op: String,
    at: Option<f64>,
    run_id: Option<JsText>,
    #[serde(default, deserialize_with = "parse_turn")]
    turn: Option<Rc<AgentTurn>>,
    id: Option<JsText>,
    #[serde(default)]
    result: AgentField<Rc<PlainData>>,
    #[serde(default)]
    error: AgentField<Rc<PlainData>>,
    reason: Option<JsText>,
    #[serde(default)]
    first: bool,
    usage: Option<String>,
    legacy: Option<String>,
    context: Option<String>,
    instructions: Option<String>,
    turn_count: Option<String>,
    profile: Option<String>,
}
fn non_null<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
fn parse_turn<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Rc<AgentTurn>>, D::Error> {
    use serde::de::Error;
    let raw = Box::<RawValue>::deserialize(d)?;
    let value = decode_json(raw.get()).map_err(D::Error::custom)?;
    let PlainData::Object(fields) = &value else {
        return Err(D::Error::custom("turn object required"));
    };
    for key in fields.keys() {
        if !["content", "toolCalls", "provider", "usage"]
            .iter()
            .any(|s| key.as_utf8() == Some(s))
        {
            return Err(D::Error::custom("unknown DTO turn field"));
        }
    }
    if let Some(PlainData::Array(calls)) = fields.get("toolCalls") {
        for call in calls {
            let PlainData::Object(call) = call else {
                return Err(D::Error::custom("call object required"));
            };
            for key in call.keys() {
                if !["callId", "name", "args"]
                    .iter()
                    .any(|s| key.as_utf8() == Some(s))
                {
                    return Err(D::Error::custom("unknown DTO call field"));
                }
            }
        }
    }
    if let Some(PlainData::Object(usage)) = fields.get("usage") {
        for key in usage.keys() {
            if ![
                "inputTokens",
                "outputTokens",
                "reasoningTokens",
                "cachedInputTokens",
            ]
            .iter()
            .any(|s| key.as_utf8() == Some(s))
            {
                return Err(D::Error::custom("unknown DTO usage field"));
            }
        }
    }
    serde_json::from_str::<AgentTurn>(raw.get())
        .map(|t| Some(Rc::new(t)))
        .map_err(D::Error::custom)
}
struct Parser;
impl Schema for Parser {
    type Raw = Rc<AgentTurn>;
    type Output = Rc<AgentTurn>;
    type Error = PlainData;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
#[derive(Serialize)]
struct ToolCommand {
    #[serde(rename = "type")]
    kind: &'static str,
    call: Rc<ToolCall>,
    #[serde(skip)]
    serial: usize,
}
impl Tagged for ToolCommand {
    fn tag(&self) -> &str {
        self.kind
    }
}
type Model =
    StateOf<PlainData, JsText, PlainData, Parser, PlainData, PlainData, PlainData, AgentTurn>;
type Knob<'a> = Agent<
    'a,
    PlainData,
    JsText,
    PlainData,
    Parser,
    PlainData,
    PlainData,
    PlainData,
    AgentTurn,
    PlainData,
    ToolCommand,
>;
type Brain = BrainCommandOf<JsText, PlainData, Parser>;
fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(v: impl Into<JsText>) -> PlainData {
    PlainData::String(v.into())
}
fn n(v: usize) -> PlainData {
    PlainData::Number(v as f64)
}
fn number(v: f64) -> PlainData {
    PlainData::Number(v)
}
fn arr(v: impl IntoIterator<Item = PlainData>) -> PlainData {
    PlainData::Array(v.into_iter().collect())
}
fn wire<T: Serialize>(v: &T) -> PlainData {
    decode_json(&stringify_json(&plain_data(v).unwrap()).unwrap()).unwrap()
}
fn name(stage: &PlainData) -> Option<&JsText> {
    match stage {
        PlainData::Object(fields) => match fields.get("name") {
            Some(PlainData::String(name)) => Some(name),
            _ => None,
        },
        _ => None,
    }
}
fn marker(v: Option<PlainData>, fallback: f64) -> Result<f64, String> {
    match v {
        None => Ok(fallback),
        Some(PlainData::Number(n)) => Ok(n),
        Some(PlainData::String(s)) if s.as_utf8() == Some("nan") => Ok(f64::NAN),
        Some(PlainData::String(s)) if s.as_utf8() == Some("infinity") => Ok(f64::INFINITY),
        _ => Err("number marker required".into()),
    }
}
fn primitive_equal(a: &PlainData, b: &PlainData) -> bool {
    match (a, b) {
        (PlainData::Null, PlainData::Null) | (PlainData::Undefined, PlainData::Undefined) => true,
        (PlainData::Bool(a), PlainData::Bool(b)) => a == b,
        (PlainData::Number(a), PlainData::Number(b)) => a == b,
        (PlainData::String(a), PlainData::String(b)) => a == b,
        _ => false,
    }
}
fn index<T>(values: &[Rc<T>], value: &Rc<T>) -> PlainData {
    number(
        values
            .iter()
            .position(|v| Rc::ptr_eq(v, value))
            .map_or(-1.0, |i| i as f64),
    )
}
fn data_index(values: &[Rc<PlainData>], value: &Rc<PlainData>) -> PlainData {
    number(
        values
            .iter()
            .position(|v| Rc::ptr_eq(v, value) || primitive_equal(v, value))
            .map_or(-1.0, |i| i as f64),
    )
}
fn rc_field<T>(a: &AgentField<Option<Rc<T>>>, b: Option<&AgentField<Option<Rc<T>>>>) -> bool {
    match (a, b) {
        (
            AgentField::Absent | AgentField::Undefined,
            None | Some(AgentField::Absent | AgentField::Undefined),
        ) => true,
        (AgentField::Value(None), Some(AgentField::Value(None))) => true,
        (AgentField::Value(Some(a)), Some(AgentField::Value(Some(b)))) => Rc::ptr_eq(a, b),
        _ => false,
    }
}
fn field_rc<T>(a: &AgentField<Rc<T>>, b: Option<&AgentField<Rc<T>>>) -> bool {
    match (a, b) {
        (
            AgentField::Absent | AgentField::Undefined,
            None | Some(AgentField::Absent | AgentField::Undefined),
        ) => true,
        (AgentField::Value(a), Some(AgentField::Value(b))) => Rc::ptr_eq(a, b),
        _ => false,
    }
}
fn required<T>(v: Option<T>, name: &str) -> Result<T, String> {
    v.ok_or_else(|| format!("missing {name}"))
}
fn validate(a: &Action) -> Result<(), String> {
    match a.op.as_str() {
        "start" | "turn" | "succeed" | "fail" | "toolOk" | "toolErr" | "boot" | "cancel"
        | "timer" => {
            required(a.at, "at")?;
        }
        "roundtrip" | "legacy" | "optional" => {}
        _ => return Err("unknown op".into()),
    }
    match a.op.as_str() {
        "turn" | "succeed" => {
            required(a.turn.as_ref(), "turn")?;
        }
        "toolOk" => {
            required(a.id.as_ref(), "id")?;
            if !matches!(a.result, AgentField::Value(_)) {
                return Err("missing result".into());
            }
        }
        "toolErr" => {
            required(a.id.as_ref(), "id")?;
            if !matches!(a.error, AgentField::Value(_)) && a.reason.is_none() {
                return Err("missing reported failure".into());
            }
        }
        "fail" => {
            if !matches!(a.error, AgentField::Value(_)) {
                return Err("missing cause".into());
            }
        }
        "timer" => {
            required(a.id.as_ref(), "id")?;
        }
        "optional" => {
            required(a.profile.as_ref(), "profile")?;
        }
        _ => {}
    }
    if a.op == "legacy" {
        for value in [&a.usage, &a.legacy] {
            if !matches!(
                value.as_deref(),
                Some("absent" | "undefined" | "null" | "value")
            ) {
                return Err("legacy usage selector".into());
            }
        }
        if !matches!(a.context.as_deref(), Some("absent" | "undefined" | "null")) {
            return Err("legacy context selector".into());
        }
        if a.turn_count
            .as_deref()
            .is_some_and(|v| !["null", "nan"].contains(&v))
        {
            return Err("legacy counter selector".into());
        }
        if a.instructions.as_deref().is_some_and(|v| v != "absent") {
            return Err("legacy instructions selector".into());
        }
    }
    if a.op == "optional" && !matches!(a.profile.as_deref(), Some("compacting" | "tool-ladder")) {
        return Err("optional profile selector".into());
    }
    if a.op == "toolErr"
        && let AgentField::Value(error) = &a.error
    {
        let PlainData::Object(fields) = error.as_ref() else {
            return Err("structured tool failure required".into());
        };
        if !matches!(fields.get("kind"),Some(PlainData::String(s))if s.as_utf8()==Some("error"))
            || !matches!(fields.get("reason"), Some(PlainData::String(_)))
        {
            return Err("structured tool failure fields required".into());
        }
    }
    Ok(())
}
struct Observer {
    calls: Rc<RefCell<Vec<&'static str>>>,
    callbacks: Rc<RefCell<Vec<PlainData>>>,
    turns: Vec<Rc<AgentTurn>>,
    results: Vec<Rc<PlainData>>,
    failures: Vec<Rc<PlainData>>,
    last: Option<Brain>,
    first: Option<Brain>,
    snapshots: Vec<PlainData>,
    retained_notes: Rc<RefCell<Vec<Rc<AgentLifecycleNote>>>>,
    stages: Vec<Rc<PlainData>>,
}
impl Observer {
    fn snapshot(
        &mut self,
        agent: &Knob<'_>,
        state: &Rc<Model>,
        commands: &[AgentCommand<JsText, PlainData, Rc<AgentTurn>, PlainData, ToolCommand>],
        action: &str,
        before: Option<&Rc<Model>>,
        error: Option<&AgentError>,
    ) {
        for cmd in commands {
            if let AgentCommand::Brain(cmd) = cmd {
                self.last = Some(replay(cmd));
                if self.first.is_none() {
                    self.first = Some(replay(cmd));
                }
            }
        }
        let stage = observe!(
            &self.calls,
            demlik_tea::agent::Agent::current_stage,
            agent,
            state
        );
        let conv = state.conversation.as_ref();
        let old = before.and_then(|s| s.conversation.as_ref());
        let same = |v| PlainData::Bool(v);
        let mut fields = vec![
            ("action", text(action)),
            ("currentStage", stage.as_ref().map_or(PlainData::Null, wire)),
            (
                "currentStageRef",
                stage
                    .as_ref()
                    .map_or(number(-1.0), |s| data_index(&self.stages, s)),
            ),
            ("state", wire(state)),
            ("commands", wire(&commands)),
            ("callbacks", wire(&self.callbacks.replace(vec![]))),
            (
                "toolSources",
                arr(commands.iter().filter_map(|cmd| match cmd {
                    AgentCommand::Tool(cmd) => Some(n(cmd.serial)),
                    _ => None,
                })),
            ),
            (
                "owners",
                object([
                    ("state", same(before.is_some_and(|s| Rc::ptr_eq(state, s)))),
                    (
                        "run",
                        same(before.is_some_and(|s| Rc::ptr_eq(&state.run, &s.run))),
                    ),
                    (
                        "resilience",
                        same(before.is_some_and(|s| state.resilience.same(&s.resilience))),
                    ),
                    (
                        "tools",
                        same(before.is_some_and(|s| Rc::ptr_eq(&state.tools, &s.tools))),
                    ),
                    (
                        "usage",
                        same(rc_field(&state.usage, before.map(|s| &s.usage))),
                    ),
                    (
                        "conversation",
                        same(match (conv, old, before) {
                            (None, None, Some(_)) => true,
                            (Some(a), Some(b), _) => Rc::ptr_eq(a, b),
                            _ => false,
                        }),
                    ),
                    (
                        "turns",
                        same(match (conv, old) {
                            (None, None) => true,
                            (Some(a), Some(b)) => Rc::ptr_eq(&a.turns, &b.turns),
                            _ => false,
                        }),
                    ),
                    (
                        "records",
                        same(match (conv, old) {
                            (None, None) => true,
                            (Some(a), Some(b)) => Rc::ptr_eq(&a.tool_records, &b.tool_records),
                            _ => false,
                        }),
                    ),
                    (
                        "output",
                        same(rc_field(&state.output, before.map(|s| &s.output))),
                    ),
                    (
                        "failure",
                        same(rc_field(&state.failure, before.map(|s| &s.failure))),
                    ),
                    (
                        "lifecycle",
                        same(field_rc(&state.lifecycle, before.map(|s| &s.lifecycle))),
                    ),
                ]),
            ),
            (
                "lifecycleRefs",
                arr(state
                    .lifecycle
                    .value()
                    .into_iter()
                    .flat_map(|n| n.iter())
                    .map(|note| index(&self.retained_notes.borrow(), note))),
            ),
            (
                "turnRefs",
                arr(conv
                    .into_iter()
                    .flat_map(|c| c.turns.iter())
                    .map(|t| index(&self.turns, t))),
            ),
            (
                "outputRef",
                state
                    .output
                    .value()
                    .and_then(Option::as_ref)
                    .map_or(number(-1.0), |t| index(&self.turns, t)),
            ),
            (
                "recordResults",
                arr(conv
                    .into_iter()
                    .flat_map(|c| c.tool_records.iter())
                    .map(|r| match r.outcome.as_ref() {
                        ToolOutcome::Ok(v) => data_index(&self.results, v),
                        _ => number(-1.0),
                    })),
            ),
            (
                "recordFailures",
                arr(conv
                    .into_iter()
                    .flat_map(|c| c.tool_records.iter())
                    .map(|r| match r.outcome.as_ref() {
                        ToolOutcome::Error(v) => data_index(&self.failures, v),
                        _ => number(-1.0),
                    })),
            ),
            (
                "llmCauseRef",
                match &state.failure {
                    AgentField::Value(Some(f)) => match f.as_ref() {
                        AgentFailure::Llm {
                            error: AgentField::Value(e),
                            ..
                        } => match &e.error {
                            LlmCause::Value(v) => data_index(&self.failures, v),
                            _ => number(-1.0),
                        },
                        _ => number(-1.0),
                    },
                    _ => number(-1.0),
                },
            ),
            (
                "settled",
                same(observe!(
                    &self.calls,
                    demlik_tea::agent::Agent::is_settled,
                    agent,
                    state
                )),
            ),
        ];
        match observe!(&self.calls, demlik_tea::agent::Agent::subs, agent, state) {
            Ok(deadlines) => fields.push(("deadlines", wire(&deadlines))),
            Err(e) => {
                fields.push(("deadlines", arr([])));
                fields.push(("subsError", error_data(&e)));
            }
        }
        fields.push((
            "projectedStatus",
            wire(&observe!(
                &self.calls,
                demlik_tea::agent::status,
                state.as_ref()
            )),
        ));
        if let Some(e) = error {
            fields.push(("error", error_data(e)));
        }
        self.snapshots.push(object(fields));
    }
}
fn replay(cmd: &Brain) -> Brain {
    cmd.definition().from_record(RunInput {
        key: cmd.input().key.clone(),
        input: cmd.input().input.clone(),
    })
}
fn error_data(error: &AgentError) -> PlainData {
    match error {
        AgentError::UnsupportedRestoredProfile { profile, keys } => object([
            ("name", text(error.name())),
            ("profile", text(profile.name())),
            ("keys", wire(keys)),
        ]),
        _ => object([
            ("name", text(error.name())),
            ("message", text(error.to_string())),
        ]),
    }
}
fn execute(frame: Frame) -> Result<PlainData, String> {
    let actions = frame
        .script
        .actions
        .iter()
        .map(|raw| serde_json::from_str::<Action>(raw.get()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    for action in &actions {
        validate(action)?;
    }
    let config = frame.script.config;
    if config
        .stages
        .as_ref()
        .is_some_and(|v| v.iter().any(|s| name(s).is_none()))
    {
        return Err("stage name required".into());
    }

    let calls = Rc::new(RefCell::new(vec![]));
    let callbacks = Rc::new(RefCell::new(vec![]));
    let serial = Rc::new(Cell::new(0usize));
    let retained_notes = Rc::new(RefCell::new(Vec::new()));
    let mut llm_config = llm_call::Config::new(|_: &JsText| Rc::new(Parser));
    llm_config.retry = config.retry.map(|max_attempts| RetryPolicy {
        curve: BackoffCurve {
            base_ms: 10.0,
            factor: 2.0,
            cap_ms: 100.0,
            jitter: Jitter::None,
        },
        budget: CountBound { max_attempts },
    });
    let llm = Rc::new(
        LlmCall::new(llm_config, |error| {
            demlik_tea::describe_error::describe_error(
                demlik_tea::describe_error::ErrorView::Value(error),
            )
        })
        .with_rng(|| 0.0),
    );
    let stage_list = config.stages.unwrap_or_else(|| {
        ["collect", "check", "summarize"]
            .into_iter()
            .map(|s| Rc::new(object([("name", text(s))])))
            .collect()
    });
    let original_stages = stage_list.clone();
    let cb = Rc::clone(&callbacks);
    let tc = Rc::clone(&callbacks);
    let pc = Rc::clone(&callbacks);
    let counter = Rc::clone(&serial);
    let mut cfg = observe!(
        &calls,
        demlik_tea::agent::AgentConfig::new,
        Rc::clone(&llm),
        stage_list,
        move |stage| {
            let purpose = stage.and_then(|s| name(s));
            cb.borrow_mut().push(arr([
                text("turnOf"),
                purpose.map_or(PlainData::Null, |v| text(v.clone())),
            ]));
            purpose.cloned().unwrap_or_else(|| "solo".into())
        },
        move |call| {
            tc.borrow_mut()
                .push(arr([text("toolOf"), text(call.call_id.clone())]));
            counter.set(counter.get() + 1);
            ToolCommand {
                kind: "base_tool",
                call: Rc::clone(call),
                serial: counter.get(),
            }
        },
        move |stage,
              conv: &Rc<Conversation<PlainData, AgentTurn, PlainData, PlainData>>,
              prompt| {
            let stage_name = stage.and_then(|s| name(s));
            pc.borrow_mut().push(arr([
                text("payloadOf"),
                stage_name.map_or(PlainData::Null, |v| text(v.clone())),
                conv.turn_count.number().map_or(PlainData::Null, number),
                prompt.map_or(PlainData::Null, |v| text(v.clone())),
            ]));
            object([
                (
                    "stage",
                    stage.map_or(PlainData::Null, |s| s.as_ref().clone()),
                ),
                (
                    "turnCount",
                    conv.turn_count.number().map_or(PlainData::Null, number),
                ),
                (
                    "instructions",
                    prompt.map_or(PlainData::Null, |v| text(v.clone())),
                ),
            ])
        },
        |turn: &AgentTurn| turn
    );
    if let Some(v) = config.instructions {
        cfg = cfg.instructions(v);
    }
    cfg = cfg.tool_concurrency(marker(config.tool_concurrency, 1.0)?);
    if let Some(v) = config.deadline_ms {
        cfg = cfg.deadline_ms(v);
    }
    if let Some(v) = config.max_turns {
        cfg = cfg.max_turns(v);
    }
    if let Some(v) = config.max_elapsed_ms {
        cfg = cfg.max_elapsed_ms(v);
    }
    if let Some(limit) = config.stop_after {
        let cb = Rc::clone(&callbacks);
        let kept = Rc::clone(&retained_notes);
        cfg = cfg.stop_when(move |s| {
            let count = s.conversation.as_ref().unwrap().turn_count.number_or_zero();
            cb.borrow_mut().push(arr([text("stopWhen"), number(count)]));
            if let Some(note) = s.lifecycle.value().and_then(|n| n.first()) {
                kept.borrow_mut().push(Rc::clone(note));
            }
            count >= limit
        });
    }
    let agent = observe!(&calls, demlik_tea::agent::create_agent, cfg);
    let mut state = observe!(&calls, demlik_tea::agent::Agent::init, &agent);
    let mut observer = Observer {
        calls: Rc::clone(&calls),
        callbacks,
        turns: vec![],
        results: vec![],
        failures: vec![],
        last: None,
        first: None,
        snapshots: vec![],
        retained_notes,
        stages: original_stages,
    };
    observer.snapshot(&agent, &state, &[], "init", None, None);
    for action in actions {
        let before = Rc::clone(&state);
        let at = action.at.unwrap_or(0.0);
        let mut commands = vec![];
        let step = match action.op.as_str() {
            "start" => Some(observe!(
                &calls,
                demlik_tea::agent::Agent::start,
                &agent,
                &state,
                action.run_id.unwrap_or_else(|| "r".into()),
                at
            )),
            "turn" => {
                let turn = action.turn.unwrap();
                observer.turns.push(Rc::clone(&turn));
                Some(observe!(
                    &calls,
                    demlik_tea::agent::Agent::turn,
                    &agent,
                    &state,
                    turn,
                    at
                ))
            }
            "succeed" => {
                let cmd = if action.first {
                    observer.first.as_ref()
                } else {
                    observer.last.as_ref()
                }
                .ok_or("no brain command")?;
                let cmd = replay(cmd);
                let turn = action.turn.unwrap();
                observer.turns.push(Rc::clone(&turn));
                let msg = agent.brain().ok(
                    cmd,
                    CallValue::value(llm_call::LlmOk {
                        key: if action.first {
                            observer.first.as_ref()
                        } else {
                            observer.last.as_ref()
                        }
                        .unwrap()
                        .input()
                        .key
                        .clone(),
                        purpose: if let CallValue::Shared(req) = &if action.first {
                            observer.first.as_ref()
                        } else {
                            observer.last.as_ref()
                        }
                        .unwrap()
                        .input()
                        .input
                        {
                            req.purpose.clone()
                        } else {
                            unreachable!()
                        },
                        output: turn,
                    }),
                    Some(at),
                );
                Some(observe!(
                    &calls,
                    demlik_tea::agent::Agent::succeed,
                    &agent,
                    &state,
                    &msg,
                    at
                ))
            }
            "fail" => {
                let cmd = if action.first {
                    observer.first.as_ref()
                } else {
                    observer.last.as_ref()
                }
                .ok_or("no brain command")?;
                let cmd = replay(cmd);
                let error = action.error.value().unwrap();
                observer.failures.push(Rc::clone(error));
                let msg = agent.brain().err(
                    cmd,
                    RunError::port_rejected(Rejected::new(CallValue::shared(Rc::clone(error)))),
                    Some(at),
                );
                Some(observe!(
                    &calls,
                    demlik_tea::agent::Agent::fail,
                    &agent,
                    &state,
                    &msg,
                    at
                ))
            }
            "toolOk" => {
                let value = action.result.value().unwrap();
                observer.results.push(Rc::clone(value));
                Some(observe!(
                    &calls,
                    demlik_tea::agent::Agent::tool_ok,
                    &agent,
                    &state,
                    action.id.clone().unwrap(),
                    Rc::clone(value),
                    at
                ))
            }
            "toolErr" => Some(if let AgentField::Value(error) = &action.error {
                observer.failures.push(Rc::clone(error));
                observe!(
                    &calls,
                    demlik_tea::agent::Agent::tool_err,
                    &agent,
                    &state,
                    action.id.clone().unwrap(),
                    Rc::clone(error),
                    at
                )
            } else {
                observe!(
                    &calls,
                    demlik_tea::agent::Agent::tool_err_reason,
                    &agent,
                    &state,
                    action.id.clone().unwrap(),
                    action.reason.unwrap(),
                    at
                )
            }),
            "boot" => Some(observe!(
                &calls,
                demlik_tea::agent::Agent::boot,
                &agent,
                &state,
                at
            )),
            "cancel" => Some(observe!(
                &calls,
                demlik_tea::agent::Agent::cancel,
                &agent,
                &state,
                at
            )),
            "timer" => {
                let msg: DeadlineExceeded = deadline_exceeded(action.id.clone().unwrap(), at, None);
                Some(observe!(
                    &calls,
                    demlik_tea::agent::Agent::on_timer,
                    &agent,
                    &state,
                    &msg
                ))
            }
            "roundtrip" => {
                let raw = serde_json::to_string(&state).map_err(|e| e.to_string())?;
                state = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                None
            }
            "legacy" => {
                let mut next = state.as_ref().clone();
                let usage = || Rc::new(demlik_tea::agent::types::TurnUsage::new(4.0, 3.0));
                next.usage = match action.usage.as_deref() {
                    Some("absent") => AgentField::Absent,
                    Some("undefined") => AgentField::Undefined,
                    Some("null") => AgentField::Value(None),
                    Some("value") => {
                        let mut u = demlik_tea::agent::types::TurnUsage::new(0.0, 2.0);
                        u.input_tokens = AgentNumber(None);
                        AgentField::Value(Some(Rc::new(u)))
                    }
                    _ => next.usage,
                };
                if let Some(conv) = &next.conversation {
                    let mut conv = conv.as_ref().clone();
                    conv.legacy_usage = match action.legacy.as_deref() {
                        Some("absent") => AgentField::Absent,
                        Some("undefined") => AgentField::Undefined,
                        Some("null") => AgentField::Value(None),
                        Some("value") => AgentField::Value(Some(usage())),
                        _ => conv.legacy_usage,
                    };
                    conv.context_tokens = match action.context.as_deref() {
                        Some("absent") => AgentField::Absent,
                        Some("undefined") => AgentField::Undefined,
                        Some("null") => AgentField::Value(AgentNumber(None)),
                        _ => conv.context_tokens,
                    };
                    conv.turn_count = match action.turn_count.as_deref() {
                        Some("null") => AgentNumber(None),
                        Some("nan") => f64::NAN.into(),
                        _ => 0.0.into(),
                    };
                    next.conversation = Some(Rc::new(conv));
                }
                if action.instructions.as_deref() == Some("absent") {
                    next.instructions = AgentField::Absent;
                }
                state = Rc::new(next);
                None
            }
            "optional" => {
                let mut next = state.as_ref().clone();
                let mut conv = next.conversation.as_ref().unwrap().as_ref().clone();
                conv.awaiting = if action.profile.as_deref() == Some("compacting") {
                    Awaiting::Compacting {
                        folding: 2.0.into(),
                    }
                } else {
                    Awaiting::Tools {
                        batch_turn: 0.0.into(),
                    }
                };
                next.conversation = Some(Rc::new(conv));
                if action.profile.as_deref() == Some("tool-ladder") {
                    let map = demlik_tea::js_record::JsRecord::from_text_entries(
                        [(
                            "scan".into(),
                            demlik_tea::resilience::resilient_call::ResilientCall::<
                                ToolCall,
                                (),
                                PlainData,
                            >::new(Default::default())
                            .init(),
                        )]
                        .into_iter()
                        .collect(),
                    );
                    next.tool_resilience = AgentField::Value(Rc::new(map));
                }
                state = Rc::new(next);
                None
            }
            _ => return Err("unknown op".into()),
        };
        let mut error = None;
        if let Some(step) = step {
            match step {
                Ok(step) => {
                    state = step.state;
                    commands = step.commands;
                }
                Err(e) => error = Some(e),
            }
        }
        if action.op == "toolErr"
            && matches!(action.error, AgentField::Absent | AgentField::Undefined)
            && let Some(failure) = state
                .conversation
                .as_ref()
                .and_then(|c| {
                    c.tool_records
                        .iter()
                        .find(|r| Some(&r.call.call_id) == action.id.as_ref())
                })
                .and_then(|r| match r.outcome.as_ref() {
                    ToolOutcome::Error(e) => Some(Rc::clone(e)),
                    _ => None,
                })
        {
            observer.failures.push(failure);
        }
        observer.snapshot(
            &agent,
            &state,
            &commands,
            &action.op,
            Some(&before),
            error.as_ref(),
        );
        if error.is_some() {
            break;
        }
    }
    Ok(object([
        ("snapshots", arr(observer.snapshots)),
        (
            "observedCalls",
            arr(calls.borrow().iter().map(|s| text(*s))),
        ),
    ]))
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let result = serde_json::from_str::<Frame>(&line)
            .map_err(|e| e.to_string())
            .and_then(|f| {
                let id = f.id.clone();
                execute(f).map(|out| (id, out))
            });
        let output = match result {
            Ok((id, output)) => object([
                ("id", text(id)),
                ("ok", PlainData::Bool(true)),
                ("output", output),
            ]),
            Err(message) => object([
                ("ok", PlainData::Bool(false)),
                ("error", text(message)),
                ("observedCalls", arr([])),
            ]),
        };
        println!("{}", stringify_json(&output).unwrap());
    }
}
