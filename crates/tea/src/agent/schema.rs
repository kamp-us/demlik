//! The two built-in guard schemas share the existing host-supplied parser
//! contract. Success retains the original object, including unknown fields.

use crate::{
    PlainData,
    data::{JsText, JsonData},
    describe_error::{ErrorView, describe_error},
    js_record::JsAccessError,
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use serde::{Deserialize, Serialize, ser::SerializeMap};
use std::{fmt, rc::Rc};

/// An owned agent schema. Construction stays internal; host schemas implement
/// [`Schema`] directly rather than learning another schema framework.
pub struct GuardedSchema {
    guard: fn(&PlainData) -> bool,
    expected: &'static str,
}
pub(crate) const fn schema_from_guard(
    guard: fn(&PlainData) -> bool,
    expected: &'static str,
) -> GuardedSchema {
    GuardedSchema { guard, expected }
}

/// A retained guard rejection or an actual plain cause restored from JSON.
///
/// A live guard Error serializes as `{}`. Decoding never recreates its old
/// message or rejected root. Use [`Self::describe`] for the source's fallible
/// Error-message-versus-String rule; Rust Debug is diagnostic presentation.
#[derive(Debug)]
pub enum StructuredOutputError {
    Live(StructuredOutputRejection),
    Plain(Rc<PlainData>),
}

/// Live-only guard diagnostics, including the exact original rejected root.
#[derive(Debug)]
pub struct StructuredOutputRejection {
    value: Rc<PlainData>,
    expected: &'static str,
}
impl StructuredOutputRejection {
    pub fn name(&self) -> &'static str {
        "Error"
    }
    pub fn message(&self) -> String {
        format!("structured-output parse failed: not {}", self.expected)
    }
    pub fn value(&self) -> &Rc<PlainData> {
        &self.value
    }
}
impl fmt::Display for StructuredOutputRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message().fmt(formatter)
    }
}
impl std::error::Error for StructuredOutputRejection {}

impl StructuredOutputError {
    pub fn describe(&self) -> Result<JsText, JsAccessError> {
        match self {
            Self::Live(rejection) => {
                describe_error(ErrorView::ErrorMessage(&rejection.message().into()))
            }
            Self::Plain(value) => describe_error(ErrorView::Value(value)),
        }
    }
}
impl Serialize for StructuredOutputError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Live(_) => serializer.serialize_map(Some(0))?.end(),
            Self::Plain(value) => JsonData(value).serialize(serializer),
        }
    }
}
impl<'de> Deserialize<'de> for StructuredOutputError {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        PlainData::deserialize(deserializer).map(|value| Self::Plain(Rc::new(value)))
    }
}

impl Schema for GuardedSchema {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = StructuredOutputError;

    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        if (self.guard)(&raw) {
            Ok(raw)
        } else {
            Err(CallValue::value(StructuredOutputError::Live(
                StructuredOutputRejection {
                    value: raw,
                    expected: self.expected,
                },
            )))
        }
    }
}
