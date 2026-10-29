//! Semantic Agent events over canonical native and guarded plain owners.
//! The projector owns weak outbox identities, not event or payload history.

use super::{
    AgentError, AgentMachineMsg, AgentToolMsg, PlainCalls, PlainToolArgs,
    knob::TurnView,
    status,
    turn_view::{CallOf, CallSource, NativeCalls, read_plain},
    types::{
        AgentEvent, AgentEventHead, AgentField, AgentLifecycleNote, AgentState, AgentStatus,
        AgentTerminalFailure, AgentTurn, ToolOutcome, TurnUsage,
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

type Outbox<A, E, V> = Vec<Rc<AgentLifecycleNote<A, E, V>>>;
type UsageReader<T, A, Provider> =
    fn(&Rc<T>, Option<TurnView<T, A, Provider>>) -> Result<AgentField<Rc<TurnUsage>>, AgentError>;
pub type AgentEventProjection<Stage, R, T, Payload, A, TE, SE, FE> =
    Result<Vec<AgentEvent<R, T, AgentTerminalFailure<Stage, SE, FE>, Payload, A, TE>>, AgentError>;

/// Original request payloads are caller-chosen Rc values. By-value payloads
/// and manual null/missing event fields remain separate profiles.
/// Borrowed domain values need no Clone/Debug/Send/serde/static bounds here;
/// converting this projector to a runtime callback has the runtime's static limit.
pub struct AgentEvents<
    T = AgentTurn,
    A = PlainData,
    Provider = PlainData,
    TE = PlainData,
    V: CallSource<A> = NativeCalls,
    EA = A,
> {
    view: Option<TurnView<T, A, Provider>>,
    usage: UsageReader<T, A, Provider>,
    args: fn(&Rc<CallOf<A, V>>) -> Rc<EA>,
    projected: RefCell<Vec<Weak<Outbox<A, TE, V>>>>,
}
pub fn agent_events<T, A, Provider, TE>(
    view: TurnView<T, A, Provider>,
) -> AgentEvents<T, A, Provider, TE> {
    AgentEvents {
        view: Some(view),
        usage: |turn, view| {
            Ok(match &view.expect("native event view")(turn).usage {
                AgentField::Value(value) => AgentField::Value(Rc::clone(value)),
                AgentField::Absent => AgentField::Absent,
                AgentField::Undefined => AgentField::Undefined,
            })
        },
        args: |call| Rc::clone(&call.args),
        projected: RefCell::new(Vec::new()),
    }
}

/// Retains the original raw turn and args cursor. Present usage is a typed
/// value view; raw usage identity is not part of the verified invoice profile.
pub fn plain_agent_events<TE>()
-> AgentEvents<PlainData, PlainData, PlainData, TE, PlainCalls, PlainToolArgs> {
    AgentEvents {
        view: None,
        usage: |turn, _| {
            let read = read_plain(turn).map_err(AgentError::TurnRead)?;
            Ok(match turn.as_ref() {
                PlainData::Object(fields)
                    if matches!(fields.get("usage"), Some(PlainData::Undefined)) =>
                {
                    AgentField::Undefined
                }
                _ => read.usage.map_or(AgentField::Absent, |usage| {
                    AgentField::Value(Rc::new(usage))
                }),
            })
        },
        args: |call| call.args_owner(),
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
        self.project_inner(
            message,
            state,
            || {
                Ok(match message {
                    AgentMachineMsg::Tool(AgentToolMsg::Ok {
                        call_id, result, ..
                    }) => Some((call_id.clone(), Rc::clone(result))),
                    _ => None,
                })
            },
            || match message {
                AgentMachineMsg::Tool(AgentToolMsg::Ok { at, .. }) => Ok(*at),
                _ => unreachable!("only a successful tool settlement reads its time"),
            },
        )
    }
}
impl<T, A, Provider, TE, V: CallSource<A>, EA> AgentEvents<T, A, Provider, TE, V, EA> {
    #[expect(
        clippy::type_complexity,
        reason = "The routed event view retains the canonical state's original independently typed owners."
    )]
    pub fn project_routed<Stage, P, Payload, R, LE, SE, CI, CO, CE, FE, CM, C, TI>(
        &self,
        message: &AgentMachineMsg<P, Rc<Payload>, Rc<T>, LE, C::Msg, CM>,
        state: &AgentState<Stage, P, Rc<T>, R, Rc<Payload>, LE, TE, SE, A, T, CI, CO, CE, FE, V>,
        tools: &TI,
    ) -> AgentEventProjection<Stage, R, T, Payload, EA, TE, SE, FE>
    where
        C: crate::command::CommandFamily,
        TI: super::tool::AgentToolRoutes<C, R, TE>,
    {
        self.project_inner(
            message,
            state,
            || {
                let AgentMachineMsg::Tool(message) = message else {
                    return Ok(None);
                };
                let settled = tools.outcome_of(message).map_err(|error| {
                    AgentError::ToolMapping(Rc::new(super::tool::ToolError::Contract(error)))
                })?;
                Ok(settled.and_then(|settled| match settled.outcome {
                    ToolOutcome::Ok(result) => Some((settled.call_id, result)),
                    ToolOutcome::Error(_) => None,
                }))
            },
            || match message {
                AgentMachineMsg::Tool(message) => number(tools.at(message), "at"),
                _ => unreachable!("only a routed tool settlement reads its time"),
            },
        )
    }
    #[expect(
        clippy::type_complexity,
        reason = "Native and routed events share one projection over the canonical state, not a second model."
    )]
    fn project_inner<Stage, P, Payload, R, LE, SE, CI, CO, CE, FE, CM, TM>(
        &self,
        message: &AgentMachineMsg<P, Rc<Payload>, Rc<T>, LE, TM, CM>,
        state: &AgentState<Stage, P, Rc<T>, R, Rc<Payload>, LE, TE, SE, A, T, CI, CO, CE, FE, V>,
        tool: impl FnOnce() -> Result<Option<(JsText, Rc<R>)>, AgentError>,
        tool_at: impl FnOnce() -> Result<f64, AgentError>,
    ) -> AgentEventProjection<Stage, R, T, Payload, EA, TE, SE, FE> {
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
                        let usage = (self.usage)(&value.output, self.view)?;
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
                AgentMachineMsg::Tool(_) => {
                    if let Some((call_id, result)) = tool()? {
                        let refused = state
                            .refused_calls
                            .value()
                            .is_some_and(|ids| ids.contains(&call_id));
                        if !refused {
                            events.push(AgentEvent::ToolSettled {
                                head: AgentEventHead {
                                    run_id: run_id.clone(),
                                    at: tool_at()?,
                                },
                                call_id,
                                result,
                            });
                        }
                    }
                }
                AgentMachineMsg::Start { .. }
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
                        call_id: V::call_id(call).clone(),
                        name: V::name(call).clone(),
                        args: (self.args)(call),
                    })
                }
                AgentLifecycleNote::ToolFailed { call, failure, at } => {
                    events.push(AgentEvent::ToolFailed {
                        head: AgentEventHead {
                            run_id: run_id.clone(),
                            at: number(Some(*at), "at")?,
                        },
                        call_id: V::call_id(call).clone(),
                        name: V::name(call).clone(),
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
