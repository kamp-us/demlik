use super::PlainData;
use serde::{Deserialize, Serialize};

/// Numeric data, including a null retained after JSON restoration.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(transparent)]
pub struct NumberOrNull(pub Option<f64>);
impl<'de> Deserialize<'de> for NumberOrNull {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match PlainData::deserialize(deserializer)? {
            PlainData::Number(value) => Ok(Self(Some(value))),
            PlainData::Null => Ok(Self(None)),
            _ => Err(serde::de::Error::custom(
                "expected a number or restored JSON null",
            )),
        }
    }
}
impl From<f64> for NumberOrNull {
    fn from(value: f64) -> Self {
        Self(Some(value))
    }
}
impl NumberOrNull {
    pub fn number(self) -> Option<f64> {
        self.0
    }
    /// Numeric arithmetic treats a stored JSON null as zero. Serialization
    /// keeps the original null until an operation produces a new number.
    pub fn number_or_zero(self) -> f64 {
        self.0.unwrap_or(0.0)
    }
}
impl PartialEq<f64> for NumberOrNull {
    fn eq(&self, other: &f64) -> bool {
        self.0.is_some_and(|value| value == *other)
    }
}
