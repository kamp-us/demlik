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
    ToolMapping(std::rc::Rc<super::super::tool::ToolError>),
    ToolResilience(super::super::tool_resilience::ToolResilienceError),
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
    EventRead(super::super::events::AgentEventReadError),
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
            Self::ToolMapping(e) => e.name(),
            Self::MissingCompactionInput => "TypeError",
            Self::EventRead(_) => "AgentEventReadError",
            Self::Llm(_) => "AgentLlmError",
            Self::TurnRead(_) => "AgentTurnReadError",
            Self::UnsupportedRestoredProfile { .. } => "UnsupportedRestoredAgentProfile",
            Self::ToolResilience(error) => error.name(),
            Self::NullUsage | Self::MissingBrainOutput => "TypeError",
        }
    }
}
impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ToolResilience(error) => error.fmt(f),
            Self::ToolMapping(error) => error.fmt(f),
            Self::Compaction(e) => e.fmt(f),
            Self::MissingCompactionInput => f.write_str("compaction command has no request"),
            Self::EventRead(error) => error.fmt(f),
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
impl std::error::Error for AgentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ToolMapping(error) => Some(error.as_ref()),
            Self::EventRead(error) => Some(error),
            _ => None,
        }
    }
}
impl From<super::super::events::AgentEventReadError> for AgentError {
    fn from(error: super::super::events::AgentEventReadError) -> Self {
        Self::EventRead(error)
    }
}
impl From<std::rc::Rc<super::super::tool::ToolError>> for AgentError {
    fn from(error: std::rc::Rc<super::super::tool::ToolError>) -> Self {
        Self::ToolMapping(error)
    }
}
impl From<super::super::tool_resilience::ToolResilienceError> for AgentError {
    fn from(error: super::super::tool_resilience::ToolResilienceError) -> Self {
        match error {
            super::super::tool_resilience::ToolResilienceError::ToolMapping(error) => {
                Self::ToolMapping(error)
            }
            error => Self::ToolResilience(error),
        }
    }
}
