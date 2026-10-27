//! Prepared, thread-local ownership of the pinned Node22/en-US collation profile.
#![forbid(unsafe_code)]

use rust_icu_common::Error as IcuError;
use rust_icu_sys::{UColAttribute, UColAttributeValue};
use rust_icu_ucol::UCollator;
use rust_icu_ustring::UChar;
use std::{cmp::Ordering, error::Error, fmt};

/// A local native handle. It is intentionally neither Send nor Sync.
/// Domain results borrow their inputs, never this handle.
#[derive(Debug)]
pub struct Collation {
    handle: UCollator,
}

/// Immutable native comparison storage. Construction checks ICU's signed32-bit
/// length before allocation, so comparison can safely satisfy sort_by's Ordering contract.
#[derive(Debug)]
pub struct CollationInput {
    text: UChar,
}

#[derive(Debug)]
pub enum CollationError {
    Initialize(IcuError),
    Configure {
        attribute: &'static str,
        source: IcuError,
    },
    InputTooLong {
        units: usize,
        maximum: usize,
    },
}
impl fmt::Display for CollationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Initialize(source) => write!(f, "cannot initialize ICU77 collation: {source}"),
            Self::Configure { attribute, source } => {
                write!(f, "cannot configure ICU77 {attribute}: {source}")
            }
            Self::InputTooLong { units, maximum } => {
                write!(
                    f,
                    "collation input has {units} UTF16 units; maximum is {maximum}"
                )
            }
        }
    }
}
impl Error for CollationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Initialize(source) | Self::Configure { source, .. } => Some(source),
            Self::InputTooLong { .. } => None,
        }
    }
}

impl CollationInput {
    fn check_length(units: usize) -> Result<(), CollationError> {
        let maximum = i32::MAX as usize;
        if units > maximum {
            return Err(CollationError::InputTooLong { units, maximum });
        }
        Ok(())
    }

    /// Copy every unit, including unpaired surrogates, into immutable native storage.
    pub fn from_utf16(units: &[u16]) -> Result<Self, CollationError> {
        Self::check_length(units.len())?;
        Ok(Self {
            text: UChar::from(units.to_vec()),
        })
    }

    /// Encode valid Rust text once. The limit is on UTF16 units, not UTF8 bytes.
    pub fn from_text(text: &str) -> Result<Self, CollationError> {
        Self::check_length(text.encode_utf16().count())?;
        Ok(Self {
            text: UChar::from(text.encode_utf16().collect::<Vec<_>>()),
        })
    }
}

impl Collation {
    /// Create the explicit pinned reference profile, independently of OS defaults.
    pub fn try_node22_en_us() -> Result<Self, CollationError> {
        let mut handle = UCollator::try_from("en-US").map_err(CollationError::Initialize)?;
        handle.set_strength(UColAttributeValue::UCOL_TERTIARY);
        for (attribute, value, name) in [
            (
                UColAttribute::UCOL_NUMERIC_COLLATION,
                UColAttributeValue::UCOL_OFF,
                "numeric",
            ),
            (
                UColAttribute::UCOL_CASE_FIRST,
                UColAttributeValue::UCOL_OFF,
                "case-first",
            ),
            (
                UColAttribute::UCOL_CASE_LEVEL,
                UColAttributeValue::UCOL_OFF,
                "case-level",
            ),
            (
                UColAttribute::UCOL_ALTERNATE_HANDLING,
                UColAttributeValue::UCOL_NON_IGNORABLE,
                "punctuation",
            ),
            (
                UColAttribute::UCOL_NORMALIZATION_MODE,
                UColAttributeValue::UCOL_ON,
                "normalization",
            ),
        ] {
            handle
                .set_attribute(attribute, value)
                .map_err(|source| CollationError::Configure {
                    attribute: name,
                    source,
                })?;
        }
        Ok(Self { handle })
    }

    /// Compare checked, immutable operands. The safe native UTF16 entrypoint
    /// returns Ordering directly; no Result is suppressed inside sorting.
    pub fn compare(&self, left: &CollationInput, right: &CollationInput) -> Ordering {
        self.handle.strcoll(&left.text, &right.text)
    }
}
