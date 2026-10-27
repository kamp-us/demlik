use crate::{data::JsText, llm_call::LlmCallError};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionalProfile {
    Compaction,
    ToolResilience,
    MissingCompaction,
    SnapshotCommand,
}
impl OptionalProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Compaction => "compaction",
            Self::ToolResilience => "toolResilience",
            Self::MissingCompaction => "missing compaction",
            Self::SnapshotCommand => "snapshot command",
        }
    }
}
#[derive(Debug)]
pub enum AgentError {
    Compaction(crate::js_record::JsAccessError),
    MissingCompactionInput,
    TurnRead(super::super::turn_view::TurnReadError),
    Llm(LlmCallError),
    UnsupportedRestoredProfile {
        profile: OptionalProfile,
        keys: Vec<JsText>,
    },
    NullUsage,
    MissingBrainOutput,
}
impl From<LlmCallError> for AgentError {
    fn from(e: LlmCallError) -> Self {
        Self::Llm(e)
    }
}
impl AgentError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Compaction(e) => e.name,
            Self::MissingCompactionInput => "TypeError",
            Self::Llm(_) => "AgentLlmError",
            Self::TurnRead(_) => "AgentTurnReadError",
            Self::UnsupportedRestoredProfile { .. } => "UnsupportedRestoredAgentProfile",
            Self::NullUsage | Self::MissingBrainOutput => "TypeError",
        }
    }
}
impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Compaction(e) => e.fmt(f),
            Self::MissingCompactionInput => f.write_str("compaction command has no request"),
            Self::Llm(e) => write!(f, "{e:?}"),
            Self::TurnRead(e) => e.fmt(f),
            Self::UnsupportedRestoredProfile { profile, keys } => write!(
                f,
                "base agent cannot resume {} ({})",
                profile.name(),
                keys.len()
            ),
            Self::NullUsage => {
                f.write_str("Cannot read properties of null (reading 'inputTokens')")
            }
            Self::MissingBrainOutput => {
                f.write_str("Cannot read properties of undefined (reading 'output')")
            }
        }
    }
}
impl std::error::Error for AgentError {}
