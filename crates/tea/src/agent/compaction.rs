//! Owned structured output and reserved purpose for context summaries. Policy,
//! command wiring and the agent factory are separate consumers of these facts.

use crate::{PlainData, data::JsText, llm_call::Purpose};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompactionPurpose {
    #[serde(rename = "$compact")]
    Compact,
}
pub const COMPACTION_PURPOSE: CompactionPurpose = CompactionPurpose::Compact;
impl Purpose for CompactionPurpose {
    fn key(&self) -> JsText {
        match self {
            Self::Compact => "$compact".into(),
        }
    }
}

#[derive(Deserialize)]
pub struct CompactionSummary {
    pub summary: JsText,
}
impl Serialize for CompactionSummary {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        super::types::object([("summary", PlainData::String(self.summary.clone()))])
            .serialize(serializer)
    }
}

pub fn is_compaction_summary(value: &PlainData) -> bool {
    matches!(value, PlainData::Object(fields) if matches!(fields.get("summary"), Some(PlainData::String(_))))
}
pub const COMPACTION_SUMMARY_SCHEMA: super::GuardedSchema =
    super::schema::schema_from_guard(is_compaction_summary, "a CompactionSummary");

use crate::{
    command::{CommandContractError, CommandFamily},
    js_record::JsAccessError,
    llm_call::{LlmErr, LlmOk, Request},
};
use std::{marker::PhantomData, rc::Rc};

/// A consumer's pure policy and domain-owned synthetic-turn constructor.
/// Select this profile before configuring a state-dependent stop predicate.
type Plan<'a, C> = Box<dyn Fn(&Rc<C>) -> f64 + 'a>;
type Payload<'a, C, I> = Box<dyn Fn(&Rc<C>, super::types::AgentNumber) -> I + 'a>;
type SummaryTurn<'a, O, T> = Box<dyn Fn(&O) -> Result<Rc<T>, JsAccessError> + 'a>;

pub struct CompactionPolicy<'a, C, T, I, O, E> {
    pub(crate) plan: Plan<'a, C>,
    pub(crate) payload: Payload<'a, C, I>,
    pub(crate) summary_turn: SummaryTurn<'a, O, T>,
    error: PhantomData<fn() -> E>,
}
impl<'a, C, T, I, O, E> CompactionPolicy<'a, C, T, I, O, E> {
    pub fn new(
        plan: impl Fn(&Rc<C>) -> f64 + 'a,
        payload: impl Fn(&Rc<C>, super::types::AgentNumber) -> I + 'a,
        summary_turn: impl Fn(&O) -> Result<Rc<T>, JsAccessError> + 'a,
    ) -> Self {
        Self {
            plan: Box::new(plan),
            payload: Box::new(payload),
            summary_turn: Box::new(summary_turn),
            error: PhantomData,
        }
    }
}
impl<'a, R, TE, I, E>
    CompactionPolicy<
        'a,
        super::types::Conversation<R, PlainData, TE, PlainData, super::turn_view::PlainCalls>,
        PlainData,
        I,
        Rc<PlainData>,
        E,
    >
{
    /// The existing summary schema retains this original root. This reader only
    /// builds the Source's synthetic turn; it does not parse or copy that root.
    pub fn from_plain(
        plan: impl Fn(
            &Rc<
                super::types::Conversation<
                    R,
                    PlainData,
                    TE,
                    PlainData,
                    super::turn_view::PlainCalls,
                >,
            >,
        ) -> f64
        + 'a,
        payload: impl Fn(
            &Rc<
                super::types::Conversation<
                    R,
                    PlainData,
                    TE,
                    PlainData,
                    super::turn_view::PlainCalls,
                >,
            >,
            super::types::AgentNumber,
        ) -> I
        + 'a,
    ) -> Self {
        Self::new(plan, payload, |output| {
            let summary = crate::js_record::property(output.as_ref(), "summary")?;
            Ok(Rc::new(super::types::object([
                ("content", summary),
                ("toolCalls", PlainData::Array(vec![])),
            ])))
        })
    }
}

pub struct CompactOk<O> {
    pub key: JsText,
    pub result: Rc<LlmOk<CompactionPurpose, O>>,
    pub at: f64,
}
pub struct CompactErr<E> {
    pub key: JsText,
    pub error: Rc<LlmErr<CompactionPurpose, E>>,
    pub at: f64,
}
pub enum CompactMessage<O, E> {
    Ok(CompactOk<O>),
    Err(CompactErr<E>),
}
impl<O, E> crate::Tagged for CompactMessage<O, E> {
    fn tag(&self) -> &str {
        match self {
            Self::Ok(_) => "compact_ok",
            Self::Err(_) => "compact_err",
        }
    }
}
impl<O, E> crate::core::Message for CompactMessage<O, E> {
    const TYPES: &'static [&'static str] = &["compact_ok", "compact_err"];
}
/// Data for the caller-owned plain `compact_run` handler. The engine does not
/// mint or retimestamp the returned compaction messages.
pub struct CompactRun<I, O, E> {
    pub key: JsText,
    pub input: Rc<Request<CompactionPurpose, I>>,
    output: PhantomData<fn() -> (O, E)>,
}
impl<I, O, E> CompactRun<I, O, E> {
    pub fn new(key: JsText, input: Rc<Request<CompactionPurpose, I>>) -> Self {
        Self {
            key,
            input,
            output: PhantomData,
        }
    }
}
impl<I, O, E> crate::Tagged for CompactRun<I, O, E> {
    fn tag(&self) -> &str {
        "compact_run"
    }
}
impl<I: Serialize, O, E> Serialize for CompactRun<I, O, E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("CompactRun", 3)?;
        value.serialize_field("type", "compact_run")?;
        value.serialize_field("key", &self.key)?;
        value.serialize_field("input", &self.input)?;
        value.end()
    }
}
impl<I, O, E> CommandFamily for CompactRun<I, O, E> {
    type Msg = CompactMessage<O, E>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(messages)
    }
}

mod private {
    pub trait Sealed {}
}
pub struct NoCompaction;
pub struct WithCompaction<I, O, E> {
    input: PhantomData<fn() -> I>,
    output: PhantomData<fn() -> O>,
    error: PhantomData<fn() -> E>,
}
pub enum NoCompactCommand {}
pub enum NoCompactMessage {}
impl crate::Tagged for NoCompactCommand {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl crate::Tagged for NoCompactMessage {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl Serialize for NoCompactCommand {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}
impl CommandFamily for NoCompactCommand {
    type Msg = NoCompactMessage;
    type Completion = NoCompactMessage;
    fn settle(self, _: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        match self {}
    }
}
impl private::Sealed for NoCompaction {}
impl<I, O, E> private::Sealed for WithCompaction<I, O, E> {}
/// The two Agent-owned profiles select typed data and a constructible command.
/// This sealed trait is not a general compaction extension framework.
pub trait CompactionProfile: private::Sealed {
    type Input;
    type Output;
    type Error;
    type Command: CommandFamily;
    const ENABLED: bool;
    fn command(
        input: CompactRun<Self::Input, Self::Output, Self::Error>,
    ) -> Result<Self::Command, super::AgentError>;
    fn message(
        message: &<Self::Command as CommandFamily>::Msg,
    ) -> &CompactMessage<Self::Output, Self::Error>;
}
impl CompactionProfile for NoCompaction {
    type Input = PlainData;
    type Output = CompactionSummary;
    type Error = PlainData;
    type Command = NoCompactCommand;
    const ENABLED: bool = false;
    fn command(
        _: CompactRun<Self::Input, Self::Output, Self::Error>,
    ) -> Result<Self::Command, super::AgentError> {
        Err(super::AgentError::UnsupportedRestoredProfile {
            profile: super::OptionalProfile::Compaction,
            keys: vec!["$compact".into()],
        })
    }
    fn message(message: &NoCompactMessage) -> &CompactMessage<Self::Output, Self::Error> {
        match *message {}
    }
}
impl<I, O, E> CompactionProfile for WithCompaction<I, O, E> {
    type Input = I;
    type Output = O;
    type Error = E;
    type Command = CompactRun<I, O, E>;
    const ENABLED: bool = true;
    fn command(command: Self::Command) -> Result<Self::Command, super::AgentError> {
        Ok(command)
    }
    fn message(message: &CompactMessage<O, E>) -> &CompactMessage<O, E> {
        message
    }
}

impl<'a, C, T, O, E> CompactionPolicy<'a, C, T, PlainData, O, E> {
    /// Omitted Source payload: no caller callback, and literal null data.
    pub fn without_payload(
        plan: impl Fn(&Rc<C>) -> f64 + 'a,
        summary_turn: impl Fn(&O) -> Result<Rc<T>, JsAccessError> + 'a,
    ) -> Self {
        Self::new(plan, |_, _| PlainData::Null, summary_turn)
    }
}
