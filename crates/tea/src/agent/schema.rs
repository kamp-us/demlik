//! The two built-in guard schemas share the existing host-supplied parser
//! contract. Success retains the original object, including unknown fields.

use crate::{PlainData, llm_call::Schema, resilience::resilient_call::CallValue};
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

/// The source-facing error and original rejected value are both observable.
#[derive(Debug)]
pub struct StructuredOutputError {
    value: Rc<PlainData>,
    expected: &'static str,
}
impl StructuredOutputError {
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
impl fmt::Display for StructuredOutputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message().fmt(formatter)
    }
}
impl std::error::Error for StructuredOutputError {}

impl Schema for GuardedSchema {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = StructuredOutputError;

    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        if (self.guard)(&raw) {
            Ok(raw)
        } else {
            Err(CallValue::value(StructuredOutputError {
                value: raw,
                expected: self.expected,
            }))
        }
    }
}
