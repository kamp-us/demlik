use demlik_tea::{
    PlainData, Step, Tagged,
    agent::{
        Agent, AgentCommand, AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError,
        GuardedSchema, PlainCalls, PlainToolCall, StateOf, StructuredOutputError,
        compaction::{
            COMPACTION_SUMMARY_SCHEMA, CompactErr, CompactMessage, CompactOk, CompactRun,
            CompactionPolicy, CompactionPurpose, WithCompaction,
        },
        create_agent,
        model::{MessageLoader, Messages},
        types::{AGENT_TURN_SCHEMA, AgentNumber, Conversation},
    },
    command::{CommandContractError, CommandFamily, Outcome},
    data::{JsText, JsonData, plain_data},
    llm_call::{self, LlmCall, LlmCause, LlmErr, LlmOk, Rejected, Request, Schema},
    resilience::{
        deadline::deadline_exceeded,
        resilient_call::{CallValue, RunError},
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile},
    timing::{Timer, TimerCallback, TimerError},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::{Rc, Weak},
};
#[path = "runtime.rs"]
mod runtime_case;
macro_rules! observe {($calls:expr,$f:path $(,$a:expr)*$(,)?)=>{{let value=$f($($a),*);$calls.borrow_mut().push(stringify!($f).to_owned());value}};}
pub(super) use observe;
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum Number {
    Finite(f64),
    Special(String),
}
impl Number {
    fn value(&self) -> f64 {
        match self {
            Self::Finite(v) => *v,
            Self::Special(s) => match s.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => panic!("unknown numeric test encoding"),
            },
        }
    }
}
fn default_folding() -> Number {
    Number::Finite(2.0)
}
fn threshold() -> usize {
    2
}
fn yes() -> bool {
    true
}
fn draws() -> Vec<f64> {
    vec![0.25, 0.75]
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_folding")]
    folding: Number,
    #[serde(default = "threshold")]
    threshold: usize,
    #[serde(default)]
    retry: Option<f64>,
    #[serde(default)]
    max_turns: Option<f64>,
    #[serde(default = "yes")]
    payload: bool,
    #[serde(default = "draws")]
    rng: Vec<f64>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            folding: default_folding(),
            threshold: threshold(),
            retry: None,
            max_turns: None,
            payload: true,
            rng: draws(),
        }
    }
}
pub enum Action {
    Start {
        at: f64,
    },
    Turn {
        turn: Rc<PlainData>,
        at: f64,
    },
    ToolOk {
        id: JsText,
        result: Rc<PlainData>,
        at: f64,
    },
    CompactOk {
        output: Rc<PlainData>,
        at: f64,
    },
    CompactErr {
        cause: Rc<PlainData>,
        at: f64,
    },
    BrainErr {
        cause: Rc<PlainData>,
        at: f64,
    },
    Timer {
        id: JsText,
        at: f64,
    },
    Cancel {
        at: f64,
    },
    Boot {
        at: f64,
    },
    RoundTrip,
}
fn present_raw<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Box<serde_json::value::RawValue>>, D::Error> {
    Box::<serde_json::value::RawValue>::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionFields {
    op: String,
    at: Option<f64>,
    id: Option<JsText>,
    #[serde(default, deserialize_with = "present_raw")]
    turn: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, deserialize_with = "present_raw")]
    result: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, deserialize_with = "present_raw")]
    output: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, deserialize_with = "present_raw")]
    cause: Option<Box<serde_json::value::RawValue>>,
}
impl<'de> Deserialize<'de> for Action {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = Box::<serde_json::value::RawValue>::deserialize(d)?;
        let fields: ActionFields = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        let data = |value: Option<Box<serde_json::value::RawValue>>,
                    field: &str|
         -> Result<Rc<PlainData>, D::Error> {
            let raw = value.ok_or_else(|| D::Error::custom(format!("missing {field}")))?;
            demlik_tea::data::decode_json(raw.get())
                .map(Rc::new)
                .map_err(D::Error::custom)
        };
        let at = fields.at.unwrap_or(0.0);
        Ok(match fields.op.as_str() {
            "start" => Self::Start { at },
            "turn" => Self::Turn {
                turn: data(fields.turn, "turn")?,
                at,
            },
            "toolOk" => Self::ToolOk {
                id: fields.id.ok_or_else(|| D::Error::custom("missing id"))?,
                result: data(fields.result, "result")?,
                at,
            },
            "compactOk" => Self::CompactOk {
                output: data(fields.output, "output")?,
                at,
            },
            "compactErr" => Self::CompactErr {
                cause: data(fields.cause, "cause")?,
                at,
            },
            "brainErr" => Self::BrainErr {
                cause: data(fields.cause, "cause")?,
                at,
            },
            "timer" => Self::Timer {
                id: fields.id.ok_or_else(|| D::Error::custom("missing id"))?,
                at,
            },
            "cancel" => Self::Cancel { at },
            "boot" => Self::Boot { at },
            "roundTrip" => Self::RoundTrip,
            op => return Err(D::Error::custom(format!("unknown operation {op}"))),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Input {
    pub id: String,
    pub mode: String,
    #[serde(default)]
    pub config: Config,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub scenario: Option<String>,
    #[serde(default)]
    pub path: Option<PathBuf>,
}
pub type History = Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls>;
#[derive(Serialize, Deserialize)]
pub struct BrainPayload {
    pub conversation: Rc<History>,
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum CompactPayload {
    History {
        conversation: Rc<History>,
        folding: AgentNumber,
    },
    Null,
}
impl<'de> Deserialize<'de> for CompactPayload {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = Box::<serde_json::value::RawValue>::deserialize(d)?;
        if raw.get().trim() == "null" {
            return Ok(Self::Null);
        }
        #[derive(Deserialize)]
        struct Stored {
            conversation: Rc<History>,
            folding: AgentNumber,
        }
        let value: Stored = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        Ok(Self::History {
            conversation: value.conversation,
            folding: value.folding,
        })
    }
}
pub type Mode = WithCompaction<CompactPayload, Rc<PlainData>, StructuredOutputError>;
pub type State = StateOf<
    (),
    JsText,
    BrainPayload,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
    Mode,
>;
pub type Msg = AgentMachineMsg<
    JsText,
    BrainPayload,
    Rc<PlainData>,
    StructuredOutputError,
    AgentToolMsg<PlainData>,
    CompactMessage<Rc<PlainData>, StructuredOutputError>,
>;
pub type Knob = Agent<
    'static,
    (),
    JsText,
    BrainPayload,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    Tool,
    PlainCalls,
    Mode,
>;
pub struct Tool(pub Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl Serialize for Tool {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut v = s.serialize_struct("Tool", 2)?;
        v.serialize_field("type", "invoice_tool")?;
        v.serialize_field("call", &self.0)?;
        v.end()
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<PlainData>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        outputs: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(outputs)
    }
}
pub fn wire<T: Serialize>(v: &T) -> Value {
    let plain = plain_data(v).unwrap();
    serde_json::to_value(JsonData(&plain)).unwrap()
}
pub fn wire_text<T: Serialize>(v: &T) -> String {
    demlik_tea::data::stringify_json(&plain_data(v).unwrap()).expect("structured JSON value")
}
pub fn plain(v: Value) -> PlainData {
    demlik_tea::data::decode_json(&v.to_string()).unwrap()
}
pub struct Shared {
    pub log: RefCell<Vec<Value>>,
    pub calls: RefCell<Vec<String>>,
    pub rng_index: Cell<usize>,
    pub plan_owner: RefCell<Option<Weak<History>>>,
    pub payload_same: Cell<bool>,
    pub summary: RefCell<Option<Weak<PlainData>>>,
}
impl Shared {
    pub fn new() -> Rc<Self> {
        Rc::new(Self {
            log: RefCell::new(vec![]),
            calls: RefCell::new(vec![]),
            rng_index: Cell::new(0),
            plan_owner: RefCell::new(None),
            payload_same: Cell::new(true),
            summary: RefCell::new(None),
        })
    }
}
pub fn agent(config: Config, ctx: Rc<Shared>) -> Rc<Knob> {
    let schemas = Rc::new(AGENT_TURN_SCHEMA);
    let rng_ctx = Rc::clone(&ctx);
    let samples = config.rng.clone();
    let mut cfg = llm_call::Config::new(move |_: &JsText| Rc::clone(&schemas));
    if let Some(max) = config.retry {
        cfg.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 10.0,
                factor: 2.0,
                cap_ms: 1000.0,
                jitter: Jitter::Full,
            },
            budget: CountBound { max_attempts: max },
        });
    }
    let llm = Rc::new(
        LlmCall::new(cfg, StructuredOutputError::describe).with_rng(move || {
            let i = rng_ctx.rng_index.get();
            rng_ctx.rng_index.set(i + 1);
            let draw = samples[i % samples.len()];
            rng_ctx.log.borrow_mut().push(json!(["rng", draw]));
            draw
        }),
    );
    let plan_ctx = Rc::clone(&ctx);
    let payload_ctx = Rc::clone(&ctx);
    let threshold = config.threshold;
    let folding = config.folding.value();
    let with_payload = config.payload;
    let max_turns = config.max_turns;
    let policy = CompactionPolicy::from_plain(
        move |conversation: &Rc<History>| {
            plan_ctx.log.borrow_mut().push(json!([
                "plan",
                conversation.turns.len(),
                conversation.turn_count.number_or_zero()
            ]));
            plan_ctx
                .plan_owner
                .replace(Some(Rc::downgrade(conversation)));
            if conversation.turns.len() >= threshold {
                folding
            } else {
                0.0
            }
        },
        move |conversation, folding| {
            let prior = payload_ctx
                .plan_owner
                .borrow()
                .as_ref()
                .and_then(Weak::upgrade);
            if let Some(prior) = prior
                && !matches!(
                    conversation.awaiting,
                    demlik_tea::agent::types::Awaiting::Compacting { .. }
                )
            {
                payload_ctx
                    .payload_same
                    .set(payload_ctx.payload_same.get() && Rc::ptr_eq(&prior, conversation));
            }
            payload_ctx.log.borrow_mut().push(json!([
                "payload",
                conversation.turns.len(),
                wire(&folding)
            ]));
            if with_payload {
                CompactPayload::History {
                    conversation: Rc::clone(conversation),
                    folding,
                }
            } else {
                CompactPayload::Null
            }
        },
    );
    let mut config = AgentConfig::from_plain_turns(
        llm,
        vec![Rc::new(())],
        |_| "invoice".into(),
        |call| Tool(Rc::clone(call)),
        |_, history, _| BrainPayload {
            conversation: Rc::clone(history),
        },
    )
    .with_compaction(policy)
    .expect("profile before state-dependent predicates");
    if let Some(max) = max_turns {
        config = config.max_turns(max);
    }
    Rc::new(create_agent(config))
}

fn pure(input: Input) -> Value {
    let ctx = Shared::new();
    let knob = agent(input.config, Rc::clone(&ctx));
    let mut state = observe!(ctx.calls, Knob::init, &knob);
    let mut frames = vec![];
    let mut last_brain = None;
    for action in input.actions {
        let step = match action {
            Action::Start { at } => {
                observe!(ctx.calls, Knob::start, &knob, &state, "invoice-run", at)
            }
            Action::Turn { turn, at } => {
                let turn = observe!(ctx.calls, Schema::parse, &AGENT_TURN_SCHEMA, turn)
                    .unwrap_or_else(|_| panic!("valid turn"));
                observe!(ctx.calls, Knob::turn, &knob, &state, turn, at)
            }
            Action::ToolOk { id, result, at } => {
                observe!(ctx.calls, Knob::tool_ok, &knob, &state, &id, result, at)
            }
            Action::CompactOk { output, at } => {
                let root = observe!(ctx.calls, Schema::parse, &COMPACTION_SUMMARY_SCHEMA, output)
                    .unwrap_or_else(|_| panic!("valid summary"));
                ctx.summary.replace(Some(Rc::downgrade(&root)));
                let message = CompactOk {
                    key: "$compact".into(),
                    result: Rc::new(LlmOk {
                        key: "$compact".into(),
                        purpose: CompactionPurpose::Compact,
                        output: root,
                    }),
                    at,
                };
                observe!(
                    ctx.calls,
                    Knob::compact_ok,
                    &knob,
                    &state,
                    &message.key,
                    &message,
                    at
                )
            }
            Action::CompactErr { cause, at } => {
                let message = CompactErr {
                    key: "$compact".into(),
                    error: Rc::new(LlmErr {
                        key: "$compact".into(),
                        purpose: CompactionPurpose::Compact,
                        reason: "provider rejected".into(),
                        error: LlmCause::Value(Rc::new(StructuredOutputError::Plain(cause))),
                    }),
                    at,
                };
                observe!(
                    ctx.calls,
                    Knob::compact_err,
                    &knob,
                    &state,
                    &message.key,
                    &message,
                    at
                )
            }
            Action::BrainErr { cause, at } => {
                let command = last_brain.take().expect("actual preceding brain command");
                let messages = observe!(
                    ctx.calls,
                    CommandFamily::settle,
                    command,
                    Some(Outcome::err(RunError::port_rejected(Rejected::new(
                        CallValue::value(StructuredOutputError::Plain(cause))
                    )))),
                    at
                )
                .unwrap();
                observe!(ctx.calls, Knob::fail, &knob, &state, &messages[0], at)
            }
            Action::Timer { id, at } => {
                let msg = deadline_exceeded(id, at, None);
                observe!(ctx.calls, Knob::on_timer, &knob, &state, &msg)
            }
            Action::Cancel { at } => observe!(ctx.calls, Knob::cancel, &knob, &state, at),
            Action::Boot { at } => observe!(ctx.calls, Knob::boot, &knob, &state, at),
            Action::RoundTrip => Ok(Step::new(
                Rc::new(serde_json::from_str::<State>(&wire_text(&state)).unwrap()),
                vec![],
            )),
        }
        .unwrap();
        let commands = wire(&step.commands);
        state = step.state;
        let deadlines = observe!(ctx.calls, Knob::subs, &knob, &state).unwrap();
        frames.push(json!({"state":wire(&state),"cmds":commands,"subs":wire(&deadlines),"log":ctx.log.borrow().clone()}));
        for command in step.commands {
            if let AgentCommand::Brain(command) = command {
                last_brain = Some(command);
            }
        }
    }
    let same=ctx.summary.borrow().as_ref().is_none_or(|weak| {
        let Some(root)=weak.upgrade() else{return false};
        let Some(slice)=state.compaction.value() else{return false};
        matches!(slice.call("$compact"),Some(demlik_tea::resilience::resilient_call::CallPhase::Succeeded{result:CallValue::Shared(value)}) if Rc::ptr_eq(&value.output,&root))
    });
    json!({"id":input.id,"view":{"frames":frames,"laws":{"payloadSame":ctx.payload_same.get(),"summarySame":same}},"observedCalls":ctx.calls.borrow().clone()})
}
pub async fn execute(input: Input) -> Value {
    if input.mode == "pure" {
        pure(input)
    } else {
        runtime_case::run(input).await
    }
}
