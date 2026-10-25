//! Shared data carried by agent events and conversation seeds. The factory,
//! schema guards, providers and lifecycle projection are separate consumers.

pub use crate::work_queue::QueueField as AgentField;
use crate::{
    PlainData, Tagged,
    data::{JsText, JsonData, plain_data},
};
use serde::Serialize;
use std::rc::Rc;

pub struct ToolCall<A = PlainData> {
    pub call_id: JsText,
    pub name: JsText,
    pub args: Rc<A>,
}
pub struct AgentTurn<A = PlainData, P = PlainData> {
    pub content: JsText,
    pub tool_calls: Vec<Rc<ToolCall<A>>>,
    pub provider: AgentField<Rc<P>>,
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
pub struct TurnUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_tokens: AgentField<f64>,
    pub cached_input_tokens: AgentField<f64>,
}
impl TurnUsage {
    pub fn new(input_tokens: f64, output_tokens: f64) -> Self {
        Self {
            input_tokens,
            output_tokens,
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
pub struct ToolRecord<R, E = PlainData, A = PlainData> {
    pub call: Rc<ToolCall<A>>,
    pub outcome: ToolOutcome<R, E>,
    pub turn: f64,
}
pub enum Awaiting {
    Llm,
    Tools { batch_turn: f64 },
    Compacting { folding: f64 },
}
pub struct Conversation<R, T = AgentTurn, E = PlainData, A = PlainData> {
    pub turns: Vec<Rc<T>>,
    pub tool_records: Vec<Rc<ToolRecord<R, E, A>>>,
    pub turn_count: f64,
    pub awaiting: Awaiting,
    /// Preserves a missing legacy field separately from an explicit null.
    pub context_tokens: AgentField<Option<f64>>,
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
        output: Option<Rc<T>>,
        usage: Rc<TurnUsage>,
    },
    Failed {
        failure: Rc<F>,
    },
    Cancelled {
        at: f64,
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
            ("inputTokens", PlainData::Number(self.input_tokens)),
            ("outputTokens", PlainData::Number(self.output_tokens)),
        ];
        if let AgentField::Value(value) = self.reasoning_tokens {
            fields.push(("reasoningTokens", PlainData::Number(value)));
        }
        if let AgentField::Value(value) = self.cached_input_tokens {
            fields.push(("cachedInputTokens", PlainData::Number(value)));
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
                        Some(value) => field::<S, _>(value)?,
                        None => PlainData::Null,
                    },
                ),
                ("usage", field::<S, _>(usage)?),
            ]),
            Self::Failed { failure } => object([
                ("kind", PlainData::String("failed".into())),
                ("failure", field::<S, _>(failure)?),
            ]),
            Self::Cancelled { at } => object([
                ("kind", PlainData::String("cancelled".into())),
                ("at", PlainData::Number(*at)),
            ]),
        };
        JsonData(&fields).serialize(serializer)
    }
}
