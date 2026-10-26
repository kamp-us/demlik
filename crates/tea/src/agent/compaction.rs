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
