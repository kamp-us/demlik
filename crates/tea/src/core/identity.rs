use std::{convert::Infallible, ops::Deref};

use super::Machine;
use crate::data::{PlainData, structural_hash};

pub struct Identity<'a, S, M> {
    of_state: Box<dyn Fn(&S) -> PlainData + 'a>,
    of_msg: Box<dyn Fn(&M) -> PlainData + 'a>,
}
impl<'a, S, M> Identity<'a, S, M> {
    pub fn new(
        of_state: impl Fn(&S) -> PlainData + 'a,
        of_msg: impl Fn(&M) -> PlainData + 'a,
    ) -> Self {
        Self {
            of_state: Box::new(of_state),
            of_msg: Box::new(of_msg),
        }
    }
    pub fn misaddressed(&self, state: &S, message: &M) -> bool {
        let addressed = (self.of_msg)(message);
        if matches!(addressed, PlainData::Undefined) {
            return false;
        }
        let own = (self.of_state)(state);
        !matches!(own, PlainData::Undefined) && structural_hash(&addressed) != structural_hash(&own)
    }
}

/// Authored metadata stays with the machine; runtimes consume this declaration.
pub struct AuthoredMachine<'a, S, M, C, U, X = (), RE = Infallible> {
    machine: Machine<'a, S, M, C, U, X, RE>,
    identity: Option<Identity<'a, S, M>>,
}
impl<'a, S, M, C, U, X, RE> Machine<'a, S, M, C, U, X, RE> {
    pub fn with_identity(
        self,
        identity: Identity<'a, S, M>,
    ) -> AuthoredMachine<'a, S, M, C, U, X, RE> {
        AuthoredMachine {
            machine: self,
            identity: Some(identity),
        }
    }
}
impl<'a, S, M, C, U, X, RE> From<Machine<'a, S, M, C, U, X, RE>>
    for AuthoredMachine<'a, S, M, C, U, X, RE>
{
    fn from(machine: Machine<'a, S, M, C, U, X, RE>) -> Self {
        Self {
            machine,
            identity: None,
        }
    }
}
type MachineParts<'a, S, M, C, U, X, RE> =
    (Machine<'a, S, M, C, U, X, RE>, Option<Identity<'a, S, M>>);
impl<'a, S, M, C, U, X, RE> AuthoredMachine<'a, S, M, C, U, X, RE> {
    pub(crate) fn into_parts(self) -> MachineParts<'a, S, M, C, U, X, RE> {
        (self.machine, self.identity)
    }
}
impl<'a, S, M, C, U, X, RE> Deref for AuthoredMachine<'a, S, M, C, U, X, RE> {
    type Target = Machine<'a, S, M, C, U, X, RE>;
    fn deref(&self) -> &Self::Target {
        &self.machine
    }
}
