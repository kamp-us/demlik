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
/// A plain checkpoint command whose handler returns caller-owned messages.
/// The original write remains in its existing owner; M is never serialized.
///
/// This is an additive runtime capability: Source's published snapshot handler
/// type requires an outcome or void, while its actual unregistered command edge
/// accepts plain message returns. The runtime-only comparison keeps that type
/// contradiction explicit; raw JavaScript values and live arrays remain separate.
pub struct AgentSnapshotMessages<M> {
    write: AgentSnapshotWrite,
    marker: std::marker::PhantomData<fn() -> M>,
}
impl<M> AgentSnapshotMessages<M> {
    pub fn command(&self) -> &SnapshotWriteCmd<PlainData> {
        self.write.command()
    }
    pub fn into_command(self) -> SnapshotWriteCmd<PlainData> {
        self.write.into_command()
    }
}
impl<M> From<AgentSnapshotWrite> for AgentSnapshotMessages<M> {
    fn from(write: AgentSnapshotWrite) -> Self {
        Self {
            write,
            marker: std::marker::PhantomData,
        }
    }
}
impl<M> Tagged for AgentSnapshotMessages<M> {
    fn tag(&self) -> &str {
        self.write.tag()
    }
}
impl<M> Serialize for AgentSnapshotMessages<M> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.write.serialize(serializer)
    }
}
impl<M> CommandFamily for AgentSnapshotMessages<M> {
    type Msg = M;
    type Completion = Vec<M>;
    fn settle(self, messages: Vec<M>, _: f64) -> Result<Vec<M>, CommandContractError> {
        Ok(messages)
    }
    fn settle_in(self, messages: Vec<M>, _: &CommandEdge) -> Result<Vec<M>, CommandContractError> {
        Ok(messages)
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
