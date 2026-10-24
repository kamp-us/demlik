use std::collections::HashSet;
use std::fmt;

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::Subscription;

pub trait Tagged {
    fn tag(&self) -> &str;
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

pub enum Update<'a, S, M, C> {
    Reducer(Row<'a, S, M, C>),
    Transitions(IndexMap<String, Row<'a, S, M, C>>),
}

impl<S: Tagged, M: Tagged, C> Update<'_, S, M, C> {
    fn row(&self, state: &S) -> Option<&Row<'_, S, M, C>> {
        match self {
            Self::Reducer(row) => Some(row),
            Self::Transitions(rows) => rows.get(state.tag()),
        }
    }

    pub fn accepted_types(&self, state: Option<&S>) -> Vec<String> {
        state
            .and_then(|state| self.row(state))
            .map(|row| row.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn apply(&self, state: &S, message: &M) -> Result<Step<S, C>, NoCellError> {
        match self.row(state).and_then(|row| row.get(message.tag())) {
            Some(cell) => Ok(cell(state, message)),
            None => Err(NoCellError::new(
                message.tag(),
                state.tag(),
                self.accepted_types(Some(state)),
            )),
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
pub type Subscriptions<'a, S, U> = Box<dyn Fn(&S) -> Vec<U> + 'a>;

pub struct Machine<'a, S, M, C, U, X = ()> {
    pub init: Init<'a, S, C, X>,
    pub update: Update<'a, S, M, C>,
    pub subscriptions: Subscriptions<'a, S, U>,
}

#[derive(Debug, Serialize)]
pub struct Replay<S, C, U> {
    pub state: S,
    #[serde(rename = "cmds")]
    pub commands: Vec<C>,
    pub subs: Vec<U>,
}

pub fn fold_updates<S: Tagged, M: Tagged, C>(
    update: &Update<'_, S, M, C>,
    mut state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<Step<S, C>, NoCellError> {
    let mut commands = Vec::new();
    for message in messages {
        let next = update.apply(&state, &message)?;
        state = next.state;
        commands.extend(next.commands);
    }
    Ok(Step { state, commands })
}

pub fn fold_msgs<S: Tagged, M: Tagged, C, U, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    state: S,
    messages: impl IntoIterator<Item = M>,
) -> Result<S, NoCellError> {
    Ok(fold_updates(&machine.update, state, messages)?.state)
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
    let subs = (machine.subscriptions)(&folded.state)
        .into_iter()
        .filter(|sub| seen.insert(sub.id().clone()))
        .collect();
    Ok(Replay {
        state: folded.state,
        commands,
        subs,
    })
}
