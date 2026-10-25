//! Pure per-message traces for machine properties. Generation and execution
//! of commands remain outside this module.
use crate::{Machine, NoCellError, Subscription, Tagged, core::replay};
use std::sync::Arc;

pub struct FoldStep<S, M, C> {
    pub prev: Arc<S>,
    pub msg: Arc<M>,
    pub next: Arc<S>,
    pub commands: Vec<C>,
}
pub struct FoldTrace<S, M, C> {
    pub states: Vec<Arc<S>>,
    pub steps: Vec<FoldStep<S, M, C>>,
    pub final_state: Arc<S>,
}

/// Boot through `replay` once, then apply every message through the machine's
/// existing update owner. Boot commands are not message-step commands. Only
/// boot derives subscriptions; handlers and subscription runners never run.
///
/// Trace Arcs retain original state/message values without cloning them.
/// When `S` is itself a shared handle, its inner identity is independent of
/// the trace's bookkeeping Arc. Existing refusal and panic data propagate.
pub fn fold_events<S: Tagged, M: Tagged, C, U: Subscription, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    loaded: Option<S>,
    messages: impl IntoIterator<Item = Arc<M>>,
) -> Result<FoldTrace<S, M, C>, NoCellError> {
    let boot = replay(machine, loaded, input, std::iter::empty::<M>())?;
    let mut current = Arc::new(boot.state);
    let mut states = vec![Arc::clone(&current)];
    let mut steps = vec![];
    for message in messages {
        let update = machine.update.apply(&current, &message)?;
        let next = Arc::new(update.state);
        steps.push(FoldStep {
            prev: current,
            msg: message,
            next: Arc::clone(&next),
            commands: update.commands,
        });
        states.push(Arc::clone(&next));
        current = next;
    }
    Ok(FoldTrace {
        states,
        steps,
        final_state: current,
    })
}
