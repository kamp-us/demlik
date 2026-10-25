//! A live event collector with fresh snapshot arrays and retained values.
//! Native sequences are dense and ordered. Sparse/prototype/custom-iterator JS
//! arrays are outside this interface; no JavaScript array runtime is installed.

use super::types::{
    AgentEndedStatus, AgentEvent, AgentTurn, Conversation, ToolOutcome, field, object,
};
use crate::{
    PlainData,
    data::{JsText, JsonData},
    js_record::property,
};
use serde::Serialize;
use std::{cell::RefCell, convert::Infallible, fmt, rc::Rc};

pub struct TranscriptToolResult<R> {
    pub call_id: JsText,
    pub result: Rc<R>,
}
pub struct RunningStatus;
pub enum TranscriptOutcome<T = AgentTurn, F = PlainData> {
    Running(Rc<RunningStatus>),
    Ended(Rc<AgentEndedStatus<T, F>>),
}
impl<T, F> Clone for TranscriptOutcome<T, F> {
    fn clone(&self) -> Self {
        match self {
            Self::Running(value) => Self::Running(Rc::clone(value)),
            Self::Ended(value) => Self::Ended(Rc::clone(value)),
        }
    }
}
impl<T, F> TranscriptOutcome<T, F> {
    pub fn ended(&self) -> Option<&Rc<AgentEndedStatus<T, F>>> {
        match self {
            Self::Running(_) => None,
            Self::Ended(value) => Some(value),
        }
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Running(a), Self::Running(b)) => Rc::ptr_eq(a, b),
            (Self::Ended(a), Self::Ended(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}
pub struct TranscriptSnapshot<R, T = AgentTurn, F = PlainData> {
    pub turns: Vec<Rc<T>>,
    pub tools: Vec<Rc<TranscriptToolResult<R>>>,
    pub outcome: TranscriptOutcome<T, F>,
}
pub struct TranscriptSeed<'a, R, T = AgentTurn, E = PlainData, A = PlainData> {
    pub conversation: Option<&'a Conversation<R, T, E, A>>,
}
struct Buffer<R, T, F> {
    turns: Vec<Rc<T>>,
    tools: Vec<Rc<TranscriptToolResult<R>>>,
    outcome: TranscriptOutcome<T, F>,
}
pub struct Transcript<R, T = AgentTurn, F = PlainData> {
    inner: Rc<RefCell<Buffer<R, T, F>>>,
}
impl<R, T, F> Clone for Transcript<R, T, F> {
    fn clone(&self) -> Self {
        Self {
            inner: Rc::clone(&self.inner),
        }
    }
}
impl<R, T, F> Default for Transcript<R, T, F> {
    fn default() -> Self {
        Self::new()
    }
}
fn seed_tools<I, R, E>(
    records: I,
    mut is_ok: impl FnMut(&I::Item) -> Result<bool, E>,
    mut settled: impl FnMut(I::Item) -> Result<(JsText, Rc<R>), E>,
) -> Result<Vec<Rc<TranscriptToolResult<R>>>, E>
where
    I: IntoIterator,
{
    let mut tools = Vec::new();
    for record in records {
        if is_ok(&record)? {
            let (call_id, result) = settled(record)?;
            tools.push(Rc::new(TranscriptToolResult { call_id, result }));
        }
    }
    Ok(tools)
}
impl<R, T, F> Transcript<R, T, F> {
    pub fn new() -> Self {
        Self {
            inner: Rc::new(RefCell::new(Buffer {
                turns: Vec::new(),
                tools: Vec::new(),
                outcome: TranscriptOutcome::Running(Rc::new(RunningStatus)),
            })),
        }
    }
    pub fn from_seed<E, A>(seed: TranscriptSeed<'_, R, T, E, A>) -> Self {
        let this = Self::new();
        if let Some(conversation) = seed.conversation {
            let tools = seed_tools(
                conversation.tool_records.iter(),
                |record| Ok::<_, Infallible>(matches!(record.outcome.as_ref(), ToolOutcome::Ok(_))),
                |record| {
                    let ToolOutcome::Ok(result) = record.outcome.as_ref() else {
                        unreachable!("only an OK record is read")
                    };
                    Ok((record.call.call_id.clone(), Rc::clone(result)))
                },
            )
            .unwrap_or_else(|never| match never {});
            let mut state = this.inner.borrow_mut();
            state.turns = conversation.turns.clone();
            state.tools = tools;
        }
        this
    }
    pub fn on_event<P, A, E>(&self, event: &AgentEvent<R, T, F, P, A, E>) {
        match event {
            AgentEvent::TurnSettled { turn, .. } => {
                self.inner.borrow_mut().turns.push(Rc::clone(turn))
            }
            AgentEvent::ToolSettled {
                call_id, result, ..
            } => self
                .inner
                .borrow_mut()
                .tools
                .push(Rc::new(TranscriptToolResult {
                    call_id: call_id.clone(),
                    result: Rc::clone(result),
                })),
            AgentEvent::RunDone { status, .. } => {
                // Release the state borrow before dropping a caller-owned cause.
                let old = std::mem::replace(
                    &mut self.inner.borrow_mut().outcome,
                    TranscriptOutcome::Ended(Rc::clone(status)),
                );
                drop(old);
            }
            AgentEvent::BrainStarted { .. }
            | AgentEvent::ToolStarted { .. }
            | AgentEvent::ToolFailed { .. } => {}
        }
    }
    /// An owned binding that remains live when the original handle is dropped.
    pub fn listener<P, A, E>(
        &self,
    ) -> impl Fn(&AgentEvent<R, T, F, P, A, E>) + Clone + use<R, T, F, P, A, E> {
        let collector = self.clone();
        move |event| collector.on_event(event)
    }
    pub fn read(&self) -> TranscriptSnapshot<R, T, F> {
        let state = self.inner.borrow();
        TranscriptSnapshot {
            turns: state.turns.clone(),
            tools: state.tools.clone(),
            outcome: state.outcome.clone(),
        }
    }
}
#[derive(Debug)]
pub struct TranscriptSeedError {
    pub name: &'static str,
    pub message: JsText,
    pub value: Box<PlainData>,
}
impl fmt::Display for TranscriptSeedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message.as_utf8().unwrap_or("transcript seed refusal"))
    }
}
impl std::error::Error for TranscriptSeedError {}
impl Transcript<PlainData, PlainData, PlainData> {
    /// Decode a raw JSON-shaped seed. This boundary owns no generic codecs and
    /// cannot add serde bounds to a typed or borrowed collector. Call IDs must
    /// be strings here; malformed Source seeds can retain other values instead.
    pub fn from_plain_seed(seed: &PlainData) -> Result<Self, TranscriptSeedError> {
        fn access(value: &PlainData, key: &str) -> Result<PlainData, TranscriptSeedError> {
            property(value, key).map_err(|cause| TranscriptSeedError {
                name: cause.name,
                message: cause.message.into(),
                value: Box::new(value.clone()),
            })
        }
        fn nullish(value: &PlainData) -> bool {
            matches!(value, PlainData::Null | PlainData::Undefined)
        }
        let conversation = if nullish(seed) {
            PlainData::Undefined
        } else {
            access(seed, "conversation")?
        };
        let turns = if nullish(&conversation) {
            PlainData::Undefined
        } else {
            access(&conversation, "turns")?
        };
        let turn_values = match &turns {
            PlainData::Array(values) => values.iter().cloned().map(Rc::new).collect(),
            PlainData::String(text) => std::char::decode_utf16(text.as_units().iter().copied())
                .map(|unit| {
                    Rc::new(PlainData::String(match unit {
                        Ok(value) => value.to_string().into(),
                        Err(value) => JsText::from_units(vec![value.unpaired_surrogate()]),
                    }))
                })
                .collect(),
            value if nullish(value) => Vec::new(),
            value => {
                return Err(TranscriptSeedError {
                    name: "TypeError",
                    message: "((intermediate value) ?? []) is not iterable".into(),
                    value: Box::new(value.clone()),
                });
            }
        };
        let records = if nullish(&conversation) {
            PlainData::Undefined
        } else {
            access(&conversation, "toolRecords")?
        };
        let records = match &records {
            PlainData::Array(values) => values.as_slice(),
            value if nullish(value) => &[],
            value => {
                return Err(TranscriptSeedError {
                    name: "TypeError",
                    message: "((intermediate value) ?? []).flatMap is not a function".into(),
                    value: Box::new(value.clone()),
                });
            }
        };
        let tools = seed_tools(
            records,
            |record| {
                let outcome = access(record, "outcome")?;
                Ok(
                    matches!(access(&outcome,"kind")?,PlainData::String(kind) if kind==JsText::from("ok")),
                )
            },
            |record| {
                let call = access(record, "call")?;
                let call_id = access(&call, "callId")?;
                let PlainData::String(call_id) = call_id else {
                    return Err(TranscriptSeedError {
                        name: "TypeError",
                        message: "transcript tool callId must be a string".into(),
                        value: Box::new(call_id),
                    });
                };
                let outcome = access(record, "outcome")?;
                Ok((call_id, Rc::new(access(&outcome, "result")?)))
            },
        )?;
        let this = Self::new();
        {
            let mut state = this.inner.borrow_mut();
            state.turns = turn_values;
            state.tools = tools;
        }
        Ok(this)
    }
}
impl<R: Serialize> Serialize for TranscriptToolResult<R> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([
            ("callId", PlainData::String(self.call_id.clone())),
            ("result", field::<S, _>(&self.result)?),
        ]))
        .serialize(serializer)
    }
}
impl<T: Serialize, F: Serialize> Serialize for TranscriptOutcome<T, F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Running(_) => JsonData(&object([("kind", PlainData::String("running".into()))]))
                .serialize(serializer),
            Self::Ended(status) => status.serialize(serializer),
        }
    }
}
impl<R: Serialize, T: Serialize, F: Serialize> Serialize for TranscriptSnapshot<R, T, F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([
            ("turns", field::<S, _>(&self.turns)?),
            ("tools", field::<S, _>(&self.tools)?),
            ("outcome", field::<S, _>(&self.outcome)?),
        ]))
        .serialize(serializer)
    }
}
