use crate::{Tagged, llm_call::RunCmd};
use serde::Serialize;
/// Precise data commands. Settlement and Runtime wiring are not part of this knob.
pub enum AgentCommand<P, I, O, E, C, CC = super::super::compaction::NoCompactCommand> {
    Brain(RunCmd<P, I, O, E>),
    Tool(C),
    Compact(CC),
}
impl<P, I, O, E, C: Tagged, CC: Tagged> Tagged for AgentCommand<P, I, O, E, C, CC> {
    fn tag(&self) -> &str {
        match self {
            Self::Brain(cmd) => cmd.tag(),
            Self::Tool(cmd) => cmd.tag(),
            Self::Compact(cmd) => cmd.tag(),
        }
    }
}
impl<P, I, O, E, C, CC> Serialize for AgentCommand<P, I, O, E, C, CC>
where
    RunCmd<P, I, O, E>: Serialize,
    C: Serialize,
    CC: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Brain(cmd) => cmd.serialize(s),
            Self::Tool(cmd) => cmd.serialize(s),
            Self::Compact(cmd) => cmd.serialize(s),
        }
    }
}
