use crate::{Tagged, llm_call::RunCmd};
use serde::Serialize;
/// Precise data commands. Settlement and Runtime wiring are not part of this knob.
pub enum AgentCommand<
    P,
    I,
    O,
    E,
    C,
    CC = super::super::compaction::NoCompactCommand,
    SC = super::super::snapshot::NoSnapshotCommand,
> {
    Brain(RunCmd<P, I, O, E>),
    Tool(C),
    Compact(CC),
    Snapshot(SC),
}
impl<P, I, O, E, C, CC, SC> AgentCommand<P, I, O, E, C, CC, SC> {
    pub(crate) fn map_snapshot<D>(
        self,
        map: impl FnOnce(SC) -> D,
    ) -> AgentCommand<P, I, O, E, C, CC, D> {
        match self {
            Self::Brain(command) => AgentCommand::Brain(command),
            Self::Tool(command) => AgentCommand::Tool(command),
            Self::Compact(command) => AgentCommand::Compact(command),
            Self::Snapshot(command) => AgentCommand::Snapshot(map(command)),
        }
    }
}
impl<P, I, O, E, C: Tagged, CC: Tagged, SC: Tagged> Tagged for AgentCommand<P, I, O, E, C, CC, SC> {
    fn tag(&self) -> &str {
        match self {
            Self::Brain(cmd) => cmd.tag(),
            Self::Tool(cmd) => cmd.tag(),
            Self::Compact(cmd) => cmd.tag(),
            Self::Snapshot(cmd) => cmd.tag(),
        }
    }
}
impl<P, I, O, E, C, CC, SC> Serialize for AgentCommand<P, I, O, E, C, CC, SC>
where
    RunCmd<P, I, O, E>: Serialize,
    C: Serialize,
    CC: Serialize,
    SC: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Brain(cmd) => cmd.serialize(s),
            Self::Tool(cmd) => cmd.serialize(s),
            Self::Compact(cmd) => cmd.serialize(s),
            Self::Snapshot(cmd) => cmd.serialize(s),
        }
    }
}
