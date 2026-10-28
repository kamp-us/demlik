//! Semantic Agent events over the canonical NativeCalls owners.
//! The projector owns weak outbox identities, not event or payload history.

use super::{
    AgentError, AgentMachineMsg, AgentToolMsg,
    knob::TurnView,
    status,
    types::{
        AgentEvent, AgentEventHead, AgentField, AgentLifecycleNote, AgentState, AgentStatus,
        AgentTerminalFailure, AgentTurn,
    },
};
use crate::{
    PlainData,
    command::Settlement,
    data::{JsText, NumberOrNull},
    flow::monitored_run::RunPhase,
    resilience::resilient_call::{CallPhase, CallValue},
};
use std::{
    cell::RefCell,
    fmt,
    rc::{Rc, Weak},
};

#[derive(Debug)]
pub enum AgentEventReadError {
    UnsupportedNumber {
        field: &'static str,
        value: Option<NumberOrNull>,
    },
    MissingPayload {
        purpose: JsText,
    },
}
impl fmt::Display for AgentEventReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedNumber { field, .. } => {
                write!(f, "agent event {field} needs its original numeric value")
            }
            Self::MissingPayload { purpose } => write!(
                f,
                "agent event brain start has no original payload for {purpose:?}"
            ),
        }
    }
}
impl std::error::Error for AgentEventReadError {}

type Outbox<A, E> = Vec<Rc<AgentLifecycleNote<A, E>>>;
pub type AgentEventProjection<Stage, R, T, Payload, A, TE, SE, FE> =
    Result<Vec<AgentEvent<R, T, AgentTerminalFailure<Stage, SE, FE>, Payload, A, TE>>, AgentError>;

/// Original request payloads are caller-chosen Rc values. By-value payloads,
/// routed tools and manual null/missing event fields are separate profiles.
/// Borrowed domain values need no Clone/Debug/Send/serde/static bounds here;
/// converting this projector to a runtime callback has the runtime's static limit.
pub struct AgentEvents<T = AgentTurn, A = PlainData, Provider = PlainData, TE = PlainData> {
    view: TurnView<T, A, Provider>,
    projected: RefCell<Vec<Weak<Outbox<A, TE>>>>,
}
pub fn agent_events<T, A, Provider, TE>(
    view: TurnView<T, A, Provider>,
) -> AgentEvents<T, A, Provider, TE> {
    AgentEvents {
        view,
        projected: RefCell::new(Vec::new()),
    }
}

fn number(value: Option<NumberOrNull>, field: &'static str) -> Result<f64, AgentError> {
    value
        .and_then(NumberOrNull::number)
        .ok_or_else(|| AgentEventReadError::UnsupportedNumber { field, value }.into())
}
impl<T, A, Provider, TE> AgentEvents<T, A, Provider, TE> {
    #[expect(
        clippy::type_complexity,
        reason = "Projection retains the canonical state's independent turn, payload and failure owners without a wrapper model."
    )]
    pub fn project<Stage, P, Payload, R, LE, SE, CI, CO, CE, FE, CM>(
        &self,
        message: &AgentMachineMsg<P, Rc<Payload>, Rc<T>, LE, AgentToolMsg<R>, CM>,
        state: &AgentState<Stage, P, Rc<T>, R, Rc<Payload>, LE, TE, SE, A, T, CI, CO, CE, FE>,
    ) -> AgentEventProjection<Stage, R, T, Payload, A, TE, SE, FE> {
        let run_id = match &state.run.phase {
            RunPhase::Idle | RunPhase::Cancelled { run_id: None, .. } => return Ok(vec![]),
            RunPhase::Running { run_id }
            | RunPhase::Stale { run_id }
            | RunPhase::Done { run_id }
            | RunPhase::Failed { run_id, .. }
            | RunPhase::Cancelled {
                run_id: Some(run_id),
                ..
            } => run_id,
        };
        let mut events = vec![];
        if !matches!(state.run.phase, RunPhase::Cancelled { .. }) {
            match message {
                AgentMachineMsg::Brain(settled) => {
                    if let Settlement::Ok(value) = settled.outcome() {
                        let CallValue::Shared(value) = value else {
                            return Err(AgentError::MissingBrainOutput);
                        };
                        let fields = (self.view)(&value.output);
                        let usage = match &fields.usage {
                            AgentField::Value(value) => AgentField::Value(Rc::clone(value)),
                            AgentField::Absent => AgentField::Absent,
                            AgentField::Undefined => AgentField::Undefined,
                        };
                        events.push(AgentEvent::TurnSettled {
                            head: AgentEventHead {
                                run_id: run_id.clone(),
                                at: number(settled.at(), "at")?,
                            },
                            turn: Rc::clone(&value.output),
                            usage,
                        });
                    }
                }
                AgentMachineMsg::Tool(AgentToolMsg::Ok {
                    call_id,
                    result,
                    at,
                }) => {
                    let refused = state
                        .refused_calls
                        .value()
                        .is_some_and(|ids| ids.contains(call_id));
                    if !refused {
                        events.push(AgentEvent::ToolSettled {
                            head: AgentEventHead {
                                run_id: run_id.clone(),
                                at: *at,
                            },
                            call_id: call_id.clone(),
                            result: Rc::clone(result),
                        });
                    }
                }
                AgentMachineMsg::Tool(AgentToolMsg::Err { .. })
                | AgentMachineMsg::Start { .. }
                | AgentMachineMsg::Boot { .. }
                | AgentMachineMsg::Cancel { .. }
                | AgentMachineMsg::Deadline(_)
                | AgentMachineMsg::Compact(_) => {}
            }
        }
        let Some(outbox) = state.lifecycle.value() else {
            return Ok(events);
        };
        if outbox.is_empty() {
            return Ok(events);
        }
        {
            let mut projected = self.projected.borrow_mut();
            projected.retain(|owner| owner.strong_count() != 0);
            let owner = Rc::downgrade(outbox);
            if projected.iter().any(|seen| Weak::ptr_eq(seen, &owner)) {
                return Ok(events);
            }
            // Source marks BEFORE reading notes; a later refusal does not roll it back.
            projected.push(owner);
        }
        for note in outbox.iter() {
            match note.as_ref() {
                AgentLifecycleNote::BrainStarted {
                    turn,
                    purpose,
                    model,
                    at,
                } => {
                    let input = match state.resilience.call(purpose.clone()) {
                        Some(
                            CallPhase::Running { input, .. }
                            | CallPhase::WaitingRetry { input, .. },
                        ) => input,
                        _ => {
                            return Err(AgentEventReadError::MissingPayload {
                                purpose: purpose.clone(),
                            }
                            .into());
                        }
                    };
                    let CallValue::Shared(input) = input else {
                        return Err(AgentEventReadError::MissingPayload {
                            purpose: purpose.clone(),
                        }
                        .into());
                    };
                    if !input.has_payload() {
                        return Err(AgentEventReadError::MissingPayload {
                            purpose: purpose.clone(),
                        }
                        .into());
                    }
                    events.push(AgentEvent::BrainStarted {
                        head: AgentEventHead {
                            run_id: run_id.clone(),
                            at: number(Some(*at), "at")?,
                        },
                        turn: number(Some(*turn), "turn")?,
                        purpose: purpose.clone(),
                        model: model.clone(),
                        payload: Rc::clone(&input.payload),
                    });
                }
                AgentLifecycleNote::ToolStarted { call, at } => {
                    events.push(AgentEvent::ToolStarted {
                        head: AgentEventHead {
                            run_id: run_id.clone(),
                            at: number(Some(*at), "at")?,
                        },
                        call_id: call.call_id.clone(),
                        name: call.name.clone(),
                        args: Rc::clone(&call.args),
                    })
                }
                AgentLifecycleNote::ToolFailed { call, failure, at } => {
                    events.push(AgentEvent::ToolFailed {
                        head: AgentEventHead {
                            run_id: run_id.clone(),
                            at: number(Some(*at), "at")?,
                        },
                        call_id: call.call_id.clone(),
                        name: call.name.clone(),
                        failure: Rc::clone(failure),
                    })
                }
                AgentLifecycleNote::RunEnded { at } => {
                    if let AgentStatus::Ended(status) = status(state) {
                        events.push(AgentEvent::RunDone {
                            head: AgentEventHead {
                                run_id: run_id.clone(),
                                at: number(Some(*at), "at")?,
                            },
                            status: Rc::new(status),
                        });
                    }
                }
            }
        }
        Ok(events)
    }
}
