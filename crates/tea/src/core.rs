mod identity;
pub use identity::{AuthoredMachine, Identity};
mod subscriptions;
pub use subscriptions::{
    ProjectionError, ProjectionFailure, SubEntry, SubEvaluation, SubscriptionEntries,
    SubscriptionProjection, Subscriptions, subscriptions, try_subscriptions,
};

use std::collections::HashSet;
use std::convert::Infallible;
use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::Subscription;

pub trait Tagged {
    fn tag(&self) -> &str;
}
impl<T: Tagged + ?Sized> Tagged for Arc<T> {
    fn tag(&self) -> &str {
        (**self).tag()
    }
}

pub trait Message: Tagged {
    const TYPES: &'static [&'static str];
}

/// Declare enum messages and their tags from one list.
#[macro_export]
macro_rules! messages {
    ($(#[$attribute:meta])* $visibility:vis enum $name:ident {
        $($variant:ident $({ $($field:ident: $field_type:ty),* $(,)? })?),* $(,)?
    }) => {
        $(#[$attribute])* $visibility enum $name {
            $($variant $({ $($field: $field_type),* })?),*
        }
        impl $crate::Tagged for $name {
            fn tag(&self) -> &str {
                match self { $(Self::$variant $({ $($field: _),* })? => stringify!($variant)),* }
            }
        }
        impl $crate::core::Message for $name {
            const TYPES: &'static [&'static str] = &[$(stringify!($variant)),*];
        }
    };
}

#[derive(Debug, Serialize)]
pub struct Step<S, C> {
    pub state: S,
    #[serde(rename = "cmds")]
    pub commands: Vec<C>,
}

impl<S, C> Step<S, C> {
    pub fn new(state: S, commands: Vec<C>) -> Self {
        Self { state, commands }
    }
    pub fn map<T, D>(self, state: impl FnOnce(S) -> T, command: impl FnMut(C) -> D) -> Step<T, D> {
        Step {
            state: state(self.state),
            commands: self.commands.into_iter().map(command).collect(),
        }
    }
}

pub type Cell<'a, S, M, C> = Box<dyn Fn(&S, &M) -> Step<S, C> + 'a>;
pub type Row<'a, S, M, C> = IndexMap<String, Cell<'a, S, M, C>>;
type TryCell<'a, S, M, C, E> = Box<dyn Fn(&S, &M) -> Result<Step<S, C>, E> + 'a>;

#[derive(Debug)]
pub enum ApplyError<E> {
    NoCell(NoCellError),
    Reduce(E),
}

pub enum TryUpdate<'a, S, M, C, E> {
    RawReducer(Row<'a, S, M, C>),
    RawTransitions(IndexMap<String, Row<'a, S, M, C>>),
    Exhaustive {
        cell: Cell<'a, S, M, C>,
        accepted_types: &'static [&'static str],
    },
    Fallible {
        cell: TryCell<'a, S, M, C, E>,
        accepted_types: &'static [&'static str],
    },
}

/// The existing infallible interface keeps raw-table inference and NoCell results.
pub type Update<'a, S, M, C> = TryUpdate<'a, S, M, C, Infallible>;

impl<'a, S, M: Message, C> Update<'a, S, M, C> {
    /// A pure function over enum messages uses Rust's exhaustive match checking.
    /// Raw tables are available for external wire dispatch through `RawReducer`.
    ///
    /// ```compile_fail,E0004
    /// use demlik_tea::{messages, Step, Update};
    /// messages! { enum Msg { Added, Reset } }
    /// let update: Update<'_, (), Msg, ()> = Update::reducer(|_, msg| match msg {
    ///     Msg::Added => Step::new((), vec![]),
    /// });
    /// ```
    pub fn reducer(cell: impl Fn(&S, &M) -> Step<S, C> + 'a) -> Self {
        Self::Exhaustive {
            cell: Box::new(cell),
            accepted_types: M::TYPES,
        }
    }
}

impl<'a, S, M: Message, C, E> TryUpdate<'a, S, M, C, E> {
    /// A typed failure is returned without imposing bounds on its owned cause.
    ///
    /// ```compile_fail,E0308
    /// use demlik_tea::{messages, TryUpdate};
    /// messages! { enum Msg { Rejected } }
    /// let update: TryUpdate<'_, (), Msg, (), &'static str> =
    ///     TryUpdate::try_reducer(|_, _| Err(7_u8));
    /// ```
    pub fn try_reducer(cell: impl Fn(&S, &M) -> Result<Step<S, C>, E> + 'a) -> Self {
        Self::Fallible {
            cell: Box::new(cell),
            accepted_types: M::TYPES,
        }
    }
}

impl<S: Tagged, M: Tagged, C, E> TryUpdate<'_, S, M, C, E> {
    fn row(&self, state: &S) -> Option<&Row<'_, S, M, C>> {
        match self {
            Self::RawReducer(row) => Some(row),
            Self::RawTransitions(rows) => rows.get(state.tag()),
            Self::Exhaustive { .. } | Self::Fallible { .. } => None,
        }
    }

    pub fn accepted_types(&self, state: Option<&S>) -> Vec<String> {
        if state.is_none() {
            return vec![];
        }
        if let Self::Exhaustive { accepted_types, .. } | Self::Fallible { accepted_types, .. } =
            self
        {
            return accepted_types.iter().map(|kind| (*kind).into()).collect();
        }
        state
            .and_then(|state| self.row(state))
            .map(|row| row.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn try_apply(&self, state: &S, message: &M) -> Result<Step<S, C>, ApplyError<E>> {
        match self {
            Self::Exhaustive { cell, .. } => return Ok(cell(state, message)),
            Self::Fallible { cell, .. } => {
                return cell(state, message).map_err(ApplyError::Reduce);
            }
            _ => {}
        }
        match self.row(state).and_then(|row| row.get(message.tag())) {
            Some(cell) => Ok(cell(state, message)),
            None => Err(ApplyError::NoCell(NoCellError::new(
                message.tag(),
                state.tag(),
                self.accepted_types(Some(state)),
            ))),
        }
    }
}

impl<S: Tagged, M: Tagged, C> Update<'_, S, M, C> {
    pub fn apply(&self, state: &S, message: &M) -> Result<Step<S, C>, NoCellError> {
        match self.try_apply(state, message) {
            Ok(step) => Ok(step),
            Err(ApplyError::NoCell(error)) => Err(error),
            Err(ApplyError::Reduce(never)) => match never {},
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoCellError {
    pub message: String,
    pub msg_type: String,
    pub state_name: String,
    pub accepted_types: Vec<String>,
}

impl NoCellError {
    pub fn new(msg_type: &str, state_name: &str, accepted_types: Vec<String>) -> Self {
        let clause = if accepted_types.is_empty() {
            " This state accepts no Msg at all.".into()
        } else {
            format!(
                " This state accepts: {}.",
                accepted_types
                    .iter()
                    .map(|name| format!("\"{name}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        Self {
            msg_type: msg_type.into(),
            state_name: state_name.into(),
            accepted_types,
            message: format!(
                "@demlik/tea: no update cell for msg.type \"{msg_type}\" in state \"{state_name}\" — the machine's update does not handle this Msg (an unknown wire msg.type, or a missing cell reached by bypassing the mapped types).{clause}"
            ),
        }
    }
    pub fn name(&self) -> &'static str {
        "NoCellError"
    }
}

impl Serialize for NoCellError {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use serde::ser::SerializeStruct;
        let mut error = serializer.serialize_struct("NoCellError", 6)?;
        error.serialize_field("name", self.name())?;
        error.serialize_field("_tag", self.name())?;
        error.serialize_field("message", &self.message)?;
        error.serialize_field("msgType", &self.msg_type)?;
        error.serialize_field("stateName", &self.state_name)?;
        error.serialize_field("acceptedTypes", &self.accepted_types)?;
        error.end()
    }
}

impl fmt::Display for NoCellError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}
impl std::error::Error for NoCellError {}

pub type Init<'a, S, C, X> = Box<dyn Fn(Option<S>, &X) -> Step<S, C> + 'a>;

pub struct Machine<'a, S, M, C, U, X = (), RE = Infallible> {
    pub init: Init<'a, S, C, X>,
    pub update: TryUpdate<'a, S, M, C, RE>,
    pub subscriptions: Subscriptions<'a, S, U, RE>,
}

#[derive(Debug, Serialize)]
pub struct Replay<S, C, U> {
    pub state: S,
    #[serde(rename = "cmds")]
    pub commands: Vec<C>,
    pub subs: Vec<U>,
}

fn fold_using<S, M, C, E>(
    mut state: S,
    messages: impl IntoIterator<Item = M>,
    mut apply: impl FnMut(&S, M) -> Result<Step<S, C>, E>,
) -> Result<Step<S, C>, E> {
    let mut commands = Vec::new();
    for message in messages {
        let next = apply(&state, message)?;
        state = next.state;
        commands.extend(next.commands);
    }
    Ok(Step { state, commands })
}

pub fn fold_updates<S: Tagged, M: Tagged, C>(
    update: &Update<'_, S, M, C>,
    state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<Step<S, C>, NoCellError> {
    fold_using(state, messages, |state, message| {
        update.apply(state, &message)
    })
}

/// Fold the original retained values without cloning the model or messages.
/// An empty input returns the same seed Arc; commands remain uninterpreted.
pub fn fold_updates_shared<S: Tagged, M: Tagged, C>(
    update: &Update<'_, S, M, C>,
    state: Arc<S>,
    messages: impl IntoIterator<Item = Arc<M>>,
) -> Result<Step<Arc<S>, C>, NoCellError> {
    fold_using(state, messages, |state, message| {
        let next = update.apply(state, &message)?;
        Ok(Step::new(Arc::new(next.state), next.commands))
    })
}

pub fn fold_msgs<S: Tagged, M: Tagged, C, U, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<S, NoCellError> {
    Ok(fold_updates(&machine.update, state, messages)?.state)
}

/// Update-only retained replay: init, interpretation and subscriptions are not called.
pub fn fold_msgs_shared<S: Tagged, M: Tagged, C, U, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    state: Arc<S>,
    messages: impl IntoIterator<Item = Arc<M>>,
) -> Result<Arc<S>, NoCellError> {
    Ok(fold_updates_shared(&machine.update, state, messages)?.state)
}

pub fn try_fold_updates<S: Tagged, M: Tagged, C, E>(
    update: &TryUpdate<'_, S, M, C, E>,
    state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<Step<S, C>, ApplyError<E>> {
    fold_using(state, messages, |state, message| {
        update.try_apply(state, &message)
    })
}

pub fn try_fold_updates_shared<S: Tagged, M: Tagged, C, E>(
    update: &TryUpdate<'_, S, M, C, E>,
    state: Arc<S>,
    messages: impl IntoIterator<Item = Arc<M>>,
) -> Result<Step<Arc<S>, C>, ApplyError<E>> {
    fold_using(state, messages, |state, message| {
        let next = update.try_apply(state, &message)?;
        Ok(Step::new(Arc::new(next.state), next.commands))
    })
}

/// Update-only folding returns the original typed cause before further Msgs run.
pub fn try_fold_msgs<S: Tagged, M: Tagged, C, U, X, E>(
    machine: &Machine<'_, S, M, C, U, X, E>,
    state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<S, ApplyError<E>> {
    Ok(try_fold_updates(&machine.update, state, messages)?.state)
}

/// Retained update-only replay does not call init, subscriptions or effects.
pub fn try_fold_msgs_shared<S: Tagged, M: Tagged, C, U, X, E>(
    machine: &Machine<'_, S, M, C, U, X, E>,
    state: Arc<S>,
    messages: impl IntoIterator<Item = Arc<M>>,
) -> Result<Arc<S>, ApplyError<E>> {
    Ok(try_fold_updates_shared(&machine.update, state, messages)?.state)
}

pub fn replay<S: Tagged, M: Tagged, C, U: Subscription, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    loaded: Option<S>,
    input: &X,
    messages: impl IntoIterator<Item = M>,
) -> Result<Replay<S, C, U>, NoCellError> {
    let initial = (machine.init)(loaded, input);
    let folded = fold_updates(&machine.update, initial.state, messages)?;
    let mut commands = initial.commands;
    commands.extend(folded.commands);
    let mut seen = HashSet::new();
    // Only infallible machines use this facade. Keep its existing dependency
    // and panic propagation; a declared cause cannot inhabit this error slot.
    let desired = match machine.subscriptions.desired(&folded.state) {
        Ok(desired) => desired,
        Err(ProjectionError::Declared(never)) => match never {},
        Err(ProjectionError::Dependency(error)) => std::panic::panic_any(error),
        Err(ProjectionError::Panic(payload)) => std::panic::resume_unwind(payload),
    };
    let subs = desired
        .into_iter()
        .filter(|sub| seen.insert(sub.id().clone()))
        .collect();
    Ok(Replay {
        state: folded.state,
        commands,
        subs,
    })
}
