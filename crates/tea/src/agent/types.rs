//! Shared agent data and its load-bearing guards. The factory, providers and
//! lifecycle projection are separate consumers.

pub use crate::data::NumberOrNull as AgentNumber;
pub use crate::work_queue::QueueField as AgentField;
use crate::{
    PlainData, Tagged,
    data::{JsText, JsonData, plain_data},
};
use serde::{Deserialize, Serialize};
use std::rc::Rc;

fn is_token_count(value: Option<&PlainData>) -> bool {
    matches!(value, Some(PlainData::Number(number))
        if number.is_finite() && number.fract() == 0.0 && *number >= 0.0
            && *number <= 9_007_199_254_740_991.0)
}

/// Validates an ordinary dense data object without rebuilding it. JavaScript
/// prototype properties and named array properties are outside PlainData.
pub fn is_turn_usage(value: &PlainData) -> bool {
    let PlainData::Object(fields) = value else {
        return false;
    };
    is_token_count(fields.get("inputTokens"))
        && is_token_count(fields.get("outputTokens"))
        && ["reasoningTokens", "cachedInputTokens"]
            .into_iter()
            .all(|key| match fields.get(key) {
                None | Some(PlainData::Undefined) => true,
                value => is_token_count(value),
            })
}
fn is_tool_call(value: &PlainData) -> bool {
    let PlainData::Object(fields) = value else {
        return false;
    };
    matches!(fields.get("callId"), Some(PlainData::String(_)))
        && matches!(fields.get("name"), Some(PlainData::String(_)))
        && matches!(
            fields.get("args"),
            Some(PlainData::Object(_) | PlainData::Array(_))
        )
}

/// Checks load-bearing fields. Provider and unknown fields remain opaque.
pub fn is_agent_turn(value: &PlainData) -> bool {
    let PlainData::Object(fields) = value else {
        return false;
    };
    matches!(fields.get("content"), Some(PlainData::String(_)))
        && matches!(fields.get("toolCalls"), Some(PlainData::Array(calls)) if calls.iter().all(is_tool_call))
        && match fields.get("usage") {
            None | Some(PlainData::Undefined) => true,
            Some(usage) => is_turn_usage(usage),
        }
}

/// Parsing retains the exact raw handle and unknown fields. It validates,
/// rather than deserializing into the separate trusted native AgentTurn DTO.
pub const AGENT_TURN_SCHEMA: super::GuardedSchema =
    super::schema::schema_from_guard(is_agent_turn, "an AgentTurn");

#[derive(Deserialize)]
#[serde(bound(deserialize = "A: Deserialize<'de>"), rename_all = "camelCase")]
pub struct ToolCall<A = PlainData> {
    pub call_id: JsText,
    pub name: JsText,
    pub args: Rc<A>,
}
#[derive(Deserialize)]
#[serde(
    bound(deserialize = "A: Deserialize<'de>, P: Deserialize<'de>"),
    rename_all = "camelCase"
)]
pub struct AgentTurn<A = PlainData, P = PlainData> {
    pub content: JsText,
    pub tool_calls: Vec<Rc<ToolCall<A>>>,
    #[serde(default)]
    pub provider: AgentField<Rc<P>>,
    #[serde(default)]
    pub usage: AgentField<Rc<TurnUsage>>,
}
impl<A, P> AgentTurn<A, P> {
    pub fn new(content: JsText, tool_calls: Vec<Rc<ToolCall<A>>>) -> Self {
        Self {
            content,
            tool_calls,
            provider: AgentField::Absent,
            usage: AgentField::Absent,
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub input_tokens: AgentNumber,
    pub output_tokens: AgentNumber,
    #[serde(default)]
    pub reasoning_tokens: AgentField<AgentNumber>,
    #[serde(default)]
    pub cached_input_tokens: AgentField<AgentNumber>,
}
impl TurnUsage {
    pub fn new(input_tokens: f64, output_tokens: f64) -> Self {
        Self {
            input_tokens: input_tokens.into(),
            output_tokens: output_tokens.into(),
            reasoning_tokens: AgentField::Absent,
            cached_input_tokens: AgentField::Absent,
        }
    }
}
pub enum ToolOutcome<R, E = PlainData> {
    Ok(Rc<R>),
    /// The original failed outcome. A transcript does not inspect or keep it.
    Error(Rc<E>),
}
#[derive(Deserialize)]
#[serde(bound(
    deserialize = "R: serde::de::DeserializeOwned,E: serde::de::DeserializeOwned,A: serde::de::DeserializeOwned"
))]
pub struct ToolRecord<R, E = PlainData, A = PlainData> {
    pub call: Rc<ToolCall<A>>,
    pub outcome: Rc<ToolOutcome<R, E>>,
    pub turn: AgentNumber,
}
#[derive(Clone)]
pub enum Awaiting {
    Llm,
    Tools { batch_turn: AgentNumber },
    Compacting { folding: AgentNumber },
}
#[derive(Deserialize)]
#[serde(
    bound(
        deserialize = "R: serde::de::DeserializeOwned,T: serde::de::DeserializeOwned,E: serde::de::DeserializeOwned,A: serde::de::DeserializeOwned"
    ),
    rename_all = "camelCase"
)]
pub struct Conversation<R, T = AgentTurn, E = PlainData, A = PlainData> {
    pub turns: Rc<Vec<Rc<T>>>,
    pub tool_records: Rc<Vec<Rc<ToolRecord<R, E, A>>>>,
    pub turn_count: AgentNumber,
    pub awaiting: Awaiting,
    /// Preserves a missing legacy field separately from an explicit null.
    #[serde(default)]
    pub context_tokens: AgentField<AgentNumber>,
    /// A persisted pre-354 conversation may still carry the run total here.
    #[serde(default, rename = "usage")]
    pub legacy_usage: AgentField<Option<Rc<TurnUsage>>>,
}
impl<R, T, E, A> Clone for Conversation<R, T, E, A> {
    fn clone(&self) -> Self {
        Self {
            turns: Rc::clone(&self.turns),
            tool_records: Rc::clone(&self.tool_records),
            turn_count: self.turn_count,
            awaiting: self.awaiting.clone(),
            context_tokens: self.context_tokens.clone(),
            legacy_usage: self.legacy_usage.clone(),
        }
    }
}
/// An ended run cannot carry a running status. A done run may have no output.
/// The terminal failure value stays caller-typed until the factory binds it.
///
/// ```compile_fail,E0599
/// use demlik_tea::agent::types::AgentEndedStatus;
/// let status = AgentEndedStatus::<(), ()>::Running;
/// ```
pub enum AgentEndedStatus<T = AgentTurn, F = PlainData> {
    Done {
        output: AgentField<Option<Rc<T>>>,
        usage: Rc<TurnUsage>,
    },
    Failed {
        failure: AgentField<Rc<F>>,
    },
    Cancelled {
        at: AgentNumber,
    },
}
#[derive(Clone)]
pub struct AgentEventHead {
    pub run_id: JsText,
    pub at: f64,
}
impl Serialize for AgentEventHead {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([
            ("runId", PlainData::String(self.run_id.clone())),
            ("at", PlainData::Number(self.at)),
        ]))
        .serialize(serializer)
    }
}
pub enum AgentEvent<R, T = AgentTurn, F = PlainData, P = PlainData, A = PlainData, E = PlainData> {
    BrainStarted {
        head: AgentEventHead,
        turn: f64,
        purpose: JsText,
        model: Option<JsText>,
        payload: Rc<P>,
    },
    TurnSettled {
        head: AgentEventHead,
        turn: Rc<T>,
        usage: AgentField<Rc<TurnUsage>>,
    },
    ToolStarted {
        head: AgentEventHead,
        call_id: JsText,
        name: JsText,
        args: Rc<A>,
    },
    ToolSettled {
        head: AgentEventHead,
        call_id: JsText,
        result: Rc<R>,
    },
    ToolFailed {
        head: AgentEventHead,
        call_id: JsText,
        name: JsText,
        failure: Rc<E>,
    },
    RunDone {
        head: AgentEventHead,
        status: Rc<AgentEndedStatus<T, F>>,
    },
}
pub const AGENT_EVENT_TYPES: [&str; 6] = [
    "BrainStarted",
    "TurnSettled",
    "ToolStarted",
    "ToolSettled",
    "ToolFailed",
    "RunDone",
];
impl<R, T, F, P, A, E> Tagged for AgentEvent<R, T, F, P, A, E> {
    fn tag(&self) -> &str {
        match self {
            Self::BrainStarted { .. } => AGENT_EVENT_TYPES[0],
            Self::TurnSettled { .. } => AGENT_EVENT_TYPES[1],
            Self::ToolStarted { .. } => AGENT_EVENT_TYPES[2],
            Self::ToolSettled { .. } => AGENT_EVENT_TYPES[3],
            Self::ToolFailed { .. } => AGENT_EVENT_TYPES[4],
            Self::RunDone { .. } => AGENT_EVENT_TYPES[5],
        }
    }
}

pub(crate) fn field<S: serde::Serializer, V: Serialize + ?Sized>(
    value: &V,
) -> Result<PlainData, S::Error> {
    plain_data(value).map_err(serde::ser::Error::custom)
}
pub(crate) fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
impl<A: Serialize> Serialize for ToolCall<A> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([
            ("callId", PlainData::String(self.call_id.clone())),
            ("name", PlainData::String(self.name.clone())),
            ("args", field::<S, _>(&self.args)?),
        ]))
        .serialize(serializer)
    }
}
impl<A: Serialize, P: Serialize> Serialize for AgentTurn<A, P> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = vec![
            ("content", PlainData::String(self.content.clone())),
            ("toolCalls", field::<S, _>(&self.tool_calls)?),
        ];
        if let AgentField::Value(value) = &self.provider {
            fields.push(("provider", field::<S, _>(value)?));
        }
        if let AgentField::Value(value) = &self.usage {
            fields.push(("usage", field::<S, _>(value)?));
        }
        JsonData(&object(fields)).serialize(serializer)
    }
}
impl Serialize for TurnUsage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = vec![
            ("inputTokens", field::<S, _>(&self.input_tokens)?),
            ("outputTokens", field::<S, _>(&self.output_tokens)?),
        ];
        if let AgentField::Value(value) = self.reasoning_tokens {
            fields.push(("reasoningTokens", field::<S, _>(&value)?));
        }
        if let AgentField::Value(value) = self.cached_input_tokens {
            fields.push(("cachedInputTokens", field::<S, _>(&value)?));
        }
        JsonData(&object(fields)).serialize(serializer)
    }
}
impl<R: Serialize, E: Serialize> Serialize for ToolOutcome<R, E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ok(result) => JsonData(&object([
                ("kind", PlainData::String("ok".into())),
                ("result", field::<S, _>(result)?),
            ]))
            .serialize(serializer),
            Self::Error(error) => error.serialize(serializer),
        }
    }
}
impl<R: Serialize, E: Serialize, A: Serialize> Serialize for ToolRecord<R, E, A> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([
            ("call", field::<S, _>(&self.call)?),
            ("outcome", field::<S, _>(&self.outcome)?),
            ("turn", field::<S, _>(&self.turn)?),
        ]))
        .serialize(serializer)
    }
}
impl Serialize for Awaiting {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = match self {
            Self::Llm => object([("kind", PlainData::String("llm".into()))]),
            Self::Tools { batch_turn } => object([
                ("kind", PlainData::String("tools".into())),
                ("batchTurn", field::<S, _>(&batch_turn)?),
            ]),
            Self::Compacting { folding } => object([
                ("kind", PlainData::String("compacting".into())),
                ("folding", field::<S, _>(&folding)?),
            ]),
        };
        JsonData(&fields).serialize(serializer)
    }
}
impl<R: Serialize, T: Serialize, E: Serialize, A: Serialize> Serialize
    for Conversation<R, T, E, A>
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = vec![
            ("turns", field::<S, _>(&self.turns)?),
            ("toolRecords", field::<S, _>(&self.tool_records)?),
            ("turnCount", field::<S, _>(&self.turn_count)?),
            ("awaiting", field::<S, _>(&self.awaiting)?),
        ];
        if let AgentField::Value(value) = self.context_tokens {
            fields.push(("contextTokens", field::<S, _>(&value)?));
        }
        if let AgentField::Value(value) = &self.legacy_usage {
            fields.push(("usage", field::<S, _>(value)?));
        }
        JsonData(&object(fields)).serialize(serializer)
    }
}
impl<T: Serialize, F: Serialize> Serialize for AgentEndedStatus<T, F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = match self {
            Self::Done { output, usage } => object([
                ("kind", PlainData::String("done".into())),
                (
                    "output",
                    match output {
                        AgentField::Value(Some(value)) => field::<S, _>(value)?,
                        AgentField::Value(None) => PlainData::Null,
                        AgentField::Absent | AgentField::Undefined => PlainData::Undefined,
                    },
                ),
                ("usage", field::<S, _>(usage)?),
            ]),
            Self::Failed { failure } => object([
                ("kind", PlainData::String("failed".into())),
                (
                    "failure",
                    match failure {
                        AgentField::Value(value) => field::<S, _>(value)?,
                        AgentField::Absent | AgentField::Undefined => PlainData::Undefined,
                    },
                ),
            ]),
            Self::Cancelled { at } => object([
                ("kind", PlainData::String("cancelled".into())),
                ("at", field::<S, _>(at)?),
            ]),
        };
        JsonData(&fields).serialize(serializer)
    }
}

/// Agent-owned terminal annotations, separate from monitored-run failures.
pub enum AgentFailure<E = PlainData> {
    TurnLimit {
        at: AgentNumber,
    },
    ElapsedLimit {
        at: AgentNumber,
    },
    Llm {
        error: AgentField<Rc<E>>,
        at: AgentNumber,
    },
}
pub enum AgentLifecycleNote<A = PlainData, E = PlainData> {
    BrainStarted {
        turn: AgentNumber,
        purpose: JsText,
        model: Option<JsText>,
        at: AgentNumber,
    },
    ToolStarted {
        call: Rc<ToolCall<A>>,
        at: AgentNumber,
    },
    ToolFailed {
        call: Rc<ToolCall<A>>,
        failure: Rc<E>,
        at: AgentNumber,
    },
    RunEnded {
        at: AgentNumber,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AwaitingKind {
    Llm,
    Tools,
    Compacting,
}
impl Awaiting {
    pub fn kind(&self) -> AwaitingKind {
        match self {
            Self::Llm => AwaitingKind::Llm,
            Self::Tools { .. } => AwaitingKind::Tools,
            Self::Compacting { .. } => AwaitingKind::Compacting,
        }
    }
}

type LifecycleNotes<A, E> = Rc<Vec<Rc<AgentLifecycleNote<A, E>>>>;
type ToolLadders<A, E> =
    Rc<crate::js_record::JsRecord<crate::resilience::resilient_call::State<ToolCall<A>, (), E>>>;
type ToolLedger<R, E, A> = Rc<crate::flow::fan_out::FanOutState<ToolCall<A>, ToolOutcome<R, E>, E>>;
/// Existing composed owners and retained agent facts. Legacy presence is data;
/// constructing or copying this model does not initialize any composed knob.
#[derive(Deserialize)]
#[serde(
    rename_all = "camelCase",
    bound(
        deserialize = "Stage:serde::de::DeserializeOwned,P:serde::de::DeserializeOwned,O:serde::de::DeserializeOwned,R:serde::de::DeserializeOwned,I:serde::de::DeserializeOwned,LE:serde::de::DeserializeOwned,TE:serde::de::DeserializeOwned,SE:serde::de::DeserializeOwned,A:serde::de::DeserializeOwned,T:serde::de::DeserializeOwned,CI:serde::de::DeserializeOwned,CO:serde::de::DeserializeOwned,CE:serde::de::DeserializeOwned,FE:serde::de::DeserializeOwned"
    )
)]
pub struct AgentState<
    Stage,
    P,
    O,
    R,
    I = PlainData,
    LE = PlainData,
    TE = PlainData,
    SE = PlainData,
    A = PlainData,
    T = AgentTurn<A>,
    CI = PlainData,
    CO = super::compaction::CompactionSummary,
    CE = PlainData,
    FE = PlainData,
> {
    pub run: Rc<crate::flow::monitored_run::MonitoredRunState<Stage, SE>>,
    pub resilience: crate::llm_call::State<P, I, O, LE>,
    pub tools: ToolLedger<R, TE, A>,
    #[serde(deserialize_with = "super::wire::required_nullable")]
    pub conversation: Option<Rc<Conversation<R, T, TE, A>>>,
    #[serde(default)]
    pub usage: AgentField<Option<Rc<TurnUsage>>>,
    #[serde(default)]
    pub compaction:
        AgentField<crate::llm_call::State<super::compaction::CompactionPurpose, CI, CO, CE>>,
    #[serde(default)]
    pub tool_resilience: AgentField<ToolLadders<A, TE>>,
    #[serde(default)]
    pub refused_calls: AgentField<Rc<Vec<JsText>>>,
    #[serde(default)]
    pub lifecycle: AgentField<LifecycleNotes<A, TE>>,
    #[serde(default)]
    pub failure: AgentField<Option<Rc<AgentFailure<FE>>>>,
    #[serde(default)]
    pub output: AgentField<Option<Rc<T>>>,
    #[serde(default)]
    pub instructions: AgentField<Option<JsText>>,
}
impl<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE> Clone
    for AgentState<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE>
{
    fn clone(&self) -> Self {
        Self {
            run: Rc::clone(&self.run),
            resilience: self.resilience.clone(),
            tools: Rc::clone(&self.tools),
            conversation: self.conversation.as_ref().map(Rc::clone),
            usage: self.usage.clone(),
            compaction: self.compaction.clone(),
            tool_resilience: self.tool_resilience.clone(),
            refused_calls: self.refused_calls.clone(),
            lifecycle: self.lifecycle.clone(),
            failure: self.failure.clone(),
            output: self.output.clone(),
            instructions: self.instructions.clone(),
        }
    }
}

/// The original failure from either canonical agent channel.
pub enum AgentTerminalFailure<Stage, SE = PlainData, FE = PlainData> {
    Agent(Rc<AgentFailure<FE>>),
    Run(Rc<crate::flow::monitored_run::RunFailure<Stage, SE>>),
}
impl<Stage: Serialize, SE: Serialize, FE: Serialize> Serialize
    for AgentTerminalFailure<Stage, SE, FE>
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Agent(value) => value.serialize(serializer),
            Self::Run(value) => value.serialize(serializer),
        }
    }
}
/// A live view borrows the exact running collection, including its empty owner.
/// Moving the Ended value out retains terminal facts independently of the state.
pub enum AgentStatus<'s, T = AgentTurn, F = PlainData, A = PlainData> {
    Idle,
    Running,
    Suspended { pending: &'s Vec<Rc<ToolCall<A>>> },
    Ended(AgentEndedStatus<T, F>),
}
impl<T: Serialize, F: Serialize, A: Serialize> Serialize for AgentStatus<'_, T, F, A> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ended(value) => value.serialize(serializer),
            Self::Idle => JsonData(&object([("kind", PlainData::String("idle".into()))]))
                .serialize(serializer),
            Self::Running => JsonData(&object([("kind", PlainData::String("running".into()))]))
                .serialize(serializer),
            Self::Suspended { pending } => JsonData(&object([
                ("kind", PlainData::String("suspended".into())),
                ("pending", field::<S, _>(pending)?),
            ]))
            .serialize(serializer),
        }
    }
}
