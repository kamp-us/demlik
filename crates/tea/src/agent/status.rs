//! Pure lifecycle projection over the canonical state. It never migrates state.
use super::{
    conversation::shared_no_usage,
    types::{
        AgentEndedStatus, AgentField, AgentState, AgentStatus, AgentTerminalFailure, Awaiting,
    },
};
use crate::flow::monitored_run::RunPhase;
use std::rc::Rc;

pub type ProjectedStatus<'s, Stage, T, A, SE, FE> =
    AgentStatus<'s, T, AgentTerminalFailure<Stage, SE, FE>, A>;

/// Read status without effects, initialization or opaque-value bounds.
/// Suspended borrows the original Vec owner; keep the state snapshot alive while
/// using that view. An extracted Ended value owns its retained terminal handles.
#[expect(
    clippy::type_complexity,
    reason = "Canonical state slots stay unconstrained; callers infer them without a projection trait."
)]
pub fn status<Stage, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE>(
    state: &AgentState<Stage, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE>,
) -> ProjectedStatus<'_, Stage, T, A, SE, FE> {
    let annotation = match &state.failure {
        AgentField::Absent | AgentField::Undefined => Some(AgentField::Undefined),
        AgentField::Value(Some(failure)) => Some(AgentField::Value(Rc::new(
            AgentTerminalFailure::Agent(Rc::clone(failure)),
        ))),
        AgentField::Value(None) => None,
    };
    if let Some(failure) = annotation {
        return AgentStatus::Ended(AgentEndedStatus::Failed { failure });
    }
    match &state.run.phase {
        RunPhase::Idle => AgentStatus::Idle,
        RunPhase::Failed { failure, .. } => AgentStatus::Ended(AgentEndedStatus::Failed {
            failure: AgentField::Value(Rc::new(AgentTerminalFailure::Run(Rc::clone(failure)))),
        }),
        RunPhase::Done { .. } => AgentStatus::Ended(AgentEndedStatus::Done {
            output: match &state.output {
                AgentField::Value(value) => AgentField::Value(value.clone()),
                AgentField::Absent | AgentField::Undefined => AgentField::Undefined,
            },
            usage: match &state.usage {
                AgentField::Value(Some(usage)) => Rc::clone(usage),
                _ => shared_no_usage(),
            },
        }),
        RunPhase::Cancelled { at, .. } => {
            AgentStatus::Ended(AgentEndedStatus::Cancelled { at: *at })
        }
        RunPhase::Running { .. } | RunPhase::Stale { .. } => {
            if state
                .conversation
                .as_ref()
                .is_some_and(|conversation| matches!(conversation.awaiting, Awaiting::Tools { .. }))
            {
                AgentStatus::Suspended {
                    pending: &state.tools.running,
                }
            } else {
                AgentStatus::Running
            }
        }
    }
}
