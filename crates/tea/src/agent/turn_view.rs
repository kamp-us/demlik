//! Retained views over the two agent-owned turn representations.
use super::knob::TurnView;
use super::types::{AgentField, ToolCall, TurnUsage};
use crate::{
    PlainData,
    data::{JsText, JsonData},
};
use serde::{Deserialize, Serialize};
use std::{fmt, rc::Rc};

mod private {
    pub trait Sealed {}
}
/// The representation of calls retained by agent data. Both choices are owned
/// here; ordinary callers select one through AgentConfig's constructor.
pub trait CallSource<A>: private::Sealed {
    type Call;
    fn call_id(call: &Self::Call) -> &JsText;
    fn name(call: &Self::Call) -> &JsText;
}
pub struct NativeCalls;
pub struct PlainCalls;
impl private::Sealed for NativeCalls {}
impl private::Sealed for PlainCalls {}
impl<A> CallSource<A> for NativeCalls {
    type Call = ToolCall<A>;
    fn call_id(call: &Self::Call) -> &JsText {
        &call.call_id
    }
    fn name(call: &Self::Call) -> &JsText {
        &call.name
    }
}
impl CallSource<PlainData> for PlainCalls {
    type Call = PlainToolCall;
    fn call_id(call: &Self::Call) -> &JsText {
        call.call_id()
    }
    fn name(call: &Self::Call) -> &JsText {
        call.name()
    }
}
pub type CallOf<A, V> = <V as CallSource<A>>::Call;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnReadLocation {
    Turn,
    Usage(&'static str),
    ToolCalls,
    Call {
        index: Option<usize>,
        field: &'static str,
    },
}
#[derive(Debug)]
pub struct TurnReadError {
    owner: Rc<PlainData>,
    pub location: TurnReadLocation,
    pub expected: &'static str,
}
impl TurnReadError {
    fn new(owner: &Rc<PlainData>, location: TurnReadLocation, expected: &'static str) -> Self {
        Self {
            owner: Rc::clone(owner),
            location,
            expected,
        }
    }
    pub fn owner(&self) -> &Rc<PlainData> {
        &self.owner
    }
}
impl fmt::Display for TurnReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "agent turn view at {:?}: expected {}",
            self.location, self.expected
        )
    }
}
impl std::error::Error for TurnReadError {}

enum PlainCallOwner {
    Turn { owner: Rc<PlainData>, index: usize },
    Standalone(Rc<PlainData>),
}
/// A view retains the original node through its owning turn or decoded call.
/// Its bookkeeping Rc is separate from the raw node's identity.
pub struct PlainToolCall {
    source: PlainCallOwner,
}
/// A retained cursor to a call's original args, not a new PlainData owner.
pub struct PlainToolArgs {
    call: Rc<PlainToolCall>,
}
impl PlainToolArgs {
    pub fn call(&self) -> &Rc<PlainToolCall> {
        &self.call
    }
    pub fn value(&self) -> &PlainData {
        self.call.args()
    }
}
impl Serialize for PlainToolArgs {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value().serialize(serializer)
    }
}
impl PlainToolCall {
    pub fn args_owner(self: &Rc<Self>) -> Rc<PlainToolArgs> {
        Rc::new(PlainToolArgs {
            call: Rc::clone(self),
        })
    }
    pub fn owner(&self) -> &Rc<PlainData> {
        match &self.source {
            PlainCallOwner::Turn { owner, .. } | PlainCallOwner::Standalone(owner) => owner,
        }
    }
    pub fn index(&self) -> Option<usize> {
        match self.source {
            PlainCallOwner::Turn { index, .. } => Some(index),
            PlainCallOwner::Standalone(_) => None,
        }
    }
    pub fn raw_call(&self) -> &PlainData {
        match &self.source {
            PlainCallOwner::Standalone(owner) => owner,
            PlainCallOwner::Turn { owner, index } => {
                let PlainData::Object(turn) = owner.as_ref() else {
                    unreachable!("checked retained turn")
                };
                let PlainData::Array(calls) = &turn["toolCalls"] else {
                    unreachable!("checked retained calls")
                };
                &calls[*index]
            }
        }
    }
    fn field(&self, name: &str) -> &PlainData {
        let PlainData::Object(fields) = self.raw_call() else {
            unreachable!("checked retained call")
        };
        &fields[name]
    }
    pub fn call_id(&self) -> &JsText {
        let PlainData::String(value) = self.field("callId") else {
            unreachable!("checked retained call ID")
        };
        value
    }
    pub fn name(&self) -> &JsText {
        let PlainData::String(value) = self.field("name") else {
            unreachable!("checked retained call name")
        };
        value
    }
    pub fn args(&self) -> &PlainData {
        self.field("args")
    }
    pub fn same_call(&self, other: &Self) -> bool {
        std::ptr::eq(self.raw_call(), other.raw_call())
    }
}
impl Serialize for PlainToolCall {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(self.raw_call()).serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for PlainToolCall {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let owner = Rc::new(PlainData::deserialize(deserializer)?);
        read_call(&owner, &owner, None).map_err(serde::de::Error::custom)?;
        Ok(Self {
            source: PlainCallOwner::Standalone(owner),
        })
    }
}
fn read_call(
    owner: &Rc<PlainData>,
    value: &PlainData,
    index: Option<usize>,
) -> Result<(), TurnReadError> {
    let at = |field, expected| {
        TurnReadError::new(owner, TurnReadLocation::Call { index, field }, expected)
    };
    let PlainData::Object(fields) = value else {
        return Err(at("", "an object"));
    };
    if !matches!(fields.get("callId"), Some(PlainData::String(_))) {
        return Err(at("callId", "a string"));
    }
    if !matches!(fields.get("name"), Some(PlainData::String(_))) {
        return Err(at("name", "a string"));
    }
    if !fields.contains_key("args") {
        return Err(at("args", "a present value"));
    }
    Ok(())
}

pub(crate) struct TurnRead<C> {
    pub calls: Vec<Rc<C>>,
    pub usage: Option<TurnUsage>,
}
type ReadFunction<T, A, P, V> =
    fn(&Rc<T>, Option<TurnView<T, A, P>>) -> Result<TurnRead<CallOf<A, V>>, TurnReadError>;
pub(crate) struct TurnReader<T, A, P, V: CallSource<A>> {
    pub native: Option<TurnView<T, A, P>>,
    pub read: ReadFunction<T, A, P, V>,
}
impl<T, A, P, V: CallSource<A>> TurnReader<T, A, P, V> {
    pub fn read(&self, value: &Rc<T>) -> Result<TurnRead<CallOf<A, V>>, TurnReadError> {
        (self.read)(value, self.native)
    }
}
pub(crate) fn read_native<T, A, P>(
    value: &Rc<T>,
    view: Option<TurnView<T, A, P>>,
) -> Result<TurnRead<ToolCall<A>>, TurnReadError> {
    let fields = view.expect("native reader owns its view function")(value);
    Ok(TurnRead {
        calls: fields.tool_calls.iter().map(Rc::clone).collect(),
        usage: fields.usage.value().map(|v| v.as_ref().clone()),
    })
}
pub(crate) fn read_plain(value: &Rc<PlainData>) -> Result<TurnRead<PlainToolCall>, TurnReadError> {
    let PlainData::Object(fields) = value.as_ref() else {
        return Err(TurnReadError::new(
            value,
            TurnReadLocation::Turn,
            "an object",
        ));
    };
    let usage = match fields.get("usage") {
        None | Some(PlainData::Undefined) => None,
        Some(PlainData::Object(usage)) => {
            let number = |key| match usage.get(key) {
                Some(PlainData::Number(v)) => Ok(v),
                _ => Err(TurnReadError::new(
                    value,
                    TurnReadLocation::Usage(key),
                    "a number",
                )),
            };
            let optional = |key| match usage.get(key) {
                None | Some(PlainData::Undefined) => Ok(None),
                Some(PlainData::Number(v)) => Ok(Some(v)),
                _ => Err(TurnReadError::new(
                    value,
                    TurnReadLocation::Usage(key),
                    "a number or undefined",
                )),
            };
            Some(TurnUsage {
                input_tokens: (*number("inputTokens")?).into(),
                output_tokens: (*number("outputTokens")?).into(),
                reasoning_tokens: optional("reasoningTokens")?
                    .map_or(AgentField::Absent, |v| AgentField::Value((*v).into())),
                cached_input_tokens: optional("cachedInputTokens")?
                    .map_or(AgentField::Absent, |v| AgentField::Value((*v).into())),
            })
        }
        Some(_) => {
            return Err(TurnReadError::new(
                value,
                TurnReadLocation::Usage(""),
                "an object or undefined",
            ));
        }
    };
    let Some(PlainData::Array(calls)) = fields.get("toolCalls") else {
        return Err(TurnReadError::new(
            value,
            TurnReadLocation::ToolCalls,
            "an array",
        ));
    };
    let mut projected = Vec::with_capacity(calls.len());
    for (index, call) in calls.iter().enumerate() {
        read_call(value, call, Some(index))?;
        projected.push(Rc::new(PlainToolCall {
            source: PlainCallOwner::Turn {
                owner: Rc::clone(value),
                index,
            },
        }));
    }
    Ok(TurnRead {
        calls: projected,
        usage,
    })
}
