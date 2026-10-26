use crate::{Tagged, llm_call::RunCmd};
use serde::Serialize;
/// Precise data commands. Settlement and Runtime wiring are not part of this knob.
pub enum AgentCommand<P, I, O, E, C> {
    Brain(RunCmd<P, I, O, E>),
    Tool(C),
}
impl<P, I, O, E, C: Tagged> Tagged for AgentCommand<P, I, O, E, C> {
    fn tag(&self) -> &str {
        match self {
            Self::Brain(cmd) => cmd.tag(),
            Self::Tool(cmd) => cmd.tag(),
        }
    }
}
impl<P, I, O, E, C> Serialize for AgentCommand<P, I, O, E, C>
where
    RunCmd<P, I, O, E>: Serialize,
    C: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Brain(cmd) => cmd.serialize(s),
            Self::Tool(cmd) => cmd.serialize(s),
        }
    }
}
