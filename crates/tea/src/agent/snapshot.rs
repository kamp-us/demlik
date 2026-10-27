//! The low-level Agent's optional, caller-owned plain checkpoint effect.

use crate::{
    PlainData, Tagged,
    command::{CommandContractError, CommandEdge, CommandFamily},
    persistence::snapshot::SnapshotWriteCmd,
};
use serde::Serialize;

/// Retains the actual command emitted by monitored-run. Agent does not register
/// this definition or mint an acknowledgment; the caller owns named IO.
pub struct AgentSnapshotWrite {
    command: SnapshotWriteCmd<PlainData>,
}
impl AgentSnapshotWrite {
    pub(crate) fn new(command: SnapshotWriteCmd<PlainData>) -> Self {
        Self { command }
    }
    pub fn command(&self) -> &SnapshotWriteCmd<PlainData> {
        &self.command
    }
    pub fn into_command(self) -> SnapshotWriteCmd<PlainData> {
        self.command
    }
}
impl Tagged for AgentSnapshotWrite {
    fn tag(&self) -> &str {
        self.command.tag()
    }
}
impl Serialize for AgentSnapshotWrite {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.command.serialize(serializer)
    }
}
/// The initial plain-writer profile returns no messages. Arbitrary returned
/// Source messages remain OPEN; the unchanged host context can dispatch.
pub enum NoSnapshotMessage {}
impl CommandFamily for AgentSnapshotWrite {
    type Msg = NoSnapshotMessage;
    type Completion = ();
    fn settle(self, _: (), _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(vec![])
    }
    fn settle_in(self, _: (), _: &CommandEdge) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(vec![])
    }
}

pub enum NoSnapshotCommand {}
impl Tagged for NoSnapshotCommand {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl Serialize for NoSnapshotCommand {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}
impl CommandFamily for NoSnapshotCommand {
    type Msg = NoSnapshotMessage;
    type Completion = NoSnapshotMessage;
    fn settle(self, _: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        match self {}
    }
}
mod private {
    pub trait Sealed {}
}
pub struct NoSnapshot;
pub struct WithSnapshot;
impl private::Sealed for NoSnapshot {}
impl private::Sealed for WithSnapshot {}
/// The Agent config fixes whether a snapshot command is constructible. It does
/// not change the canonical State or add a storage/runtime policy.
pub trait SnapshotProfile: private::Sealed {
    type Command: CommandFamily<Msg = NoSnapshotMessage>;
    const ENABLED: bool;
    fn command(command: SnapshotWriteCmd<PlainData>) -> Result<Self::Command, super::AgentError>;
}
impl SnapshotProfile for NoSnapshot {
    type Command = NoSnapshotCommand;
    const ENABLED: bool = false;
    fn command(_: SnapshotWriteCmd<PlainData>) -> Result<Self::Command, super::AgentError> {
        Err(super::AgentError::UnsupportedRestoredProfile {
            profile: super::OptionalProfile::SnapshotCommand,
            keys: vec![],
        })
    }
}
impl SnapshotProfile for WithSnapshot {
    type Command = AgentSnapshotWrite;
    const ENABLED: bool = true;
    fn command(command: SnapshotWriteCmd<PlainData>) -> Result<Self::Command, super::AgentError> {
        Ok(AgentSnapshotWrite::new(command))
    }
}
