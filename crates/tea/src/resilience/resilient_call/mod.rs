mod decode;
mod model;
pub use model::*;

use super::{
    cache, circuit_breaker,
    deadline::{self, Deadline, DeadlineExceeded, TimerDeps},
    rate_limit,
};
use crate::{
    PlainData, Step,
    data::JsText,
    js_record::{JsAccessError, JsRecord, ProjectionFailure, RecordCodec, RecordValue, Resolved},
    retry_backoff::{self, Budget, CountBound, TimedRetryState},
};
use std::{marker::PhantomData, rc::Rc};

#[derive(Debug)]
pub enum ResilientError {
    Record(JsAccessError),
    Projection(ProjectionFailure),
    MissingStamp { command: String },
}
impl From<JsAccessError> for ResilientError {
    fn from(value: JsAccessError) -> Self {
        Self::Record(value)
    }
}
impl From<ProjectionFailure> for ResilientError {
    fn from(value: ProjectionFailure) -> Self {
        Self::Projection(value)
    }
}

/// A pure composition of the existing retry, cache, rate, circuit and deadline
/// owners. Typed stored payloads are shared without Clone or serde bounds;
/// crossing a wire or reading a projected cache value has a separate codec.
///
/// ```compile_fail,E0308
/// use demlik_tea::resilience::resilient_call::{ResilientCall, Config, CallValue};
/// use demlik_tea::command::{CommandFamily, Outcome};
/// let call: ResilientCall<'_, u32, String, ()> = ResilientCall::new(Config::default());
/// let mut started = call.attempt(&call.init(), "key", CallValue::value(3), 0.0).unwrap();
/// let command = started.commands.pop().unwrap();
/// command.settle(Some(Outcome::ok(CallValue::value(42_u64))), 1.0);
/// ```
pub struct ResilientCall<'a, I, R, E, B = CountBound, H = E> {
    config: Config<B>,
    pub run: crate::command::CmdDef<RunSpec<I, R, H>>,
    stored_error: PhantomData<fn() -> E>,
    projection: RecordCodec<'a, CallValue<R>>,
    rng: Rc<dyn Fn() -> f64 + 'a>,
}
impl<'a, I, R, E, B: Budget, H> ResilientCall<'a, I, R, E, B, H> {
    pub fn new(config: Config<B>) -> Self {
        let run = run_cmd_def(&config.name);
        Self {
            config,
            run,
            stored_error: PhantomData,
            projection: RecordCodec::refusing(),
            rng: Rc::new(fastrand::f64),
        }
    }
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.rng = Rc::new(rng);
        self
    }
    pub fn with_cache_codec(mut self, codec: RecordCodec<'a, CallValue<R>>) -> Self {
        self.projection = codec;
        self
    }
    pub fn name(&self) -> &str {
        &self.config.name
    }
    pub fn init(&self) -> State<I, R, E> {
        let bucket = self.config.rate_limit.map_or_else(
            || rate_limit::init_bucket(1.0, 1.0, 0.0),
            |config| rate_limit::init_bucket(config.capacity, config.refill_per_sec, 0.0),
        );
        State::from_snapshot(Snapshot {
            circuit: circuit_breaker::init_circuit(),
            bucket,
            retry: Rc::new(JsRecord::default()),
            cache: Rc::new(cache::init_cache()),
            calls: Rc::new(JsRecord::default()),
            clock_ms: 0.0.into(),
        })
    }
    fn tick(&self, state: &State<I, R, E>, at: CallNumber) -> State<I, R, E> {
        if state.0.clock_ms == at {
            return state.clone();
        }
        State::from_snapshot(Snapshot {
            clock_ms: at,
            ..state.0.as_ref().clone()
        })
    }
    fn set_call(
        &self,
        state: &State<I, R, E>,
        key: JsText,
        call: CallPhase<I, R, E>,
    ) -> State<I, R, E> {
        let mut calls = state.0.calls.spread();
        calls.define(key, RecordValue::Entry(Rc::new(call)));
        State::from_snapshot(Snapshot {
            calls: Rc::new(calls),
            ..state.0.as_ref().clone()
        })
    }
    fn fresh_budget(&self, at: CallNumber) -> CallBudget {
        CallBudget {
            remaining_ms: self.config.deadline.map_or(0.0, |config| config.ms).into(),
            charging_since_ms: at,
        }
    }
    fn charge(&self, budget: CallBudget, at: CallNumber) -> CallBudget {
        CallBudget {
            remaining_ms: if budget.remaining_ms.number_or_zero() <= 0.0 {
                budget.remaining_ms
            } else {
                (budget.remaining_ms.number_or_zero()
                    - crate::js_math::max(
                        0.0,
                        at.number_or_zero() - budget.charging_since_ms.number_or_zero(),
                    ))
                .into()
            },
            charging_since_ms: at,
        }
    }
    fn budget_for(&self, state: &State<I, R, E>, key: &JsText, at: CallNumber) -> CallBudget {
        match state.call(key) {
            Some(CallPhase::Running { budget, .. } | CallPhase::WaitingRetry { budget, .. }) => {
                self.charge(*budget, at)
            }
            _ => self.fresh_budget(at),
        }
    }
    fn retry_of(
        &self,
        state: &State<I, R, E>,
        key: &JsText,
    ) -> Result<RetryProgress<E>, ResilientError> {
        let record = state.0.retry.resolve_with(key, |_| {
            Err(JsAccessError {
                name: "ProjectionRefused",
                message: "retry records cannot project an error payload as a retry state".into(),
            })
        })?;
        Ok(match record {
            Resolved::Entry(value) => value.clone(),
            Resolved::Missing | Resolved::Data(PlainData::Null | PlainData::Undefined) => {
                RetryProgress {
                    attempt: 0.0.into(),
                    last_error: None,
                    first_failure_at_ms: None,
                }
            }
            Resolved::Builtin(_) | Resolved::ObjectPrototype => RetryProgress {
                attempt: f64::NAN.into(),
                last_error: None,
                first_failure_at_ms: None,
            },
            Resolved::Data(_) => {
                return Err(JsAccessError {
                    name: "TypeError",
                    message: "retry state needs its typed boundary decoder".into(),
                }
                .into());
            }
        })
    }
    fn backoff(
        &self,
        state: &State<I, R, E>,
        key: JsText,
        input: CallValue<I>,
        error: Rc<CallFailure<E>>,
        at: CallNumber,
        budget: CallBudget,
    ) -> Result<CallStep<I, R, E, H>, ResilientError> {
        let Some(policy) = &self.config.retry else {
            return Ok(Step::new(
                self.set_call(state, key, CallPhase::Failed { error }),
                vec![],
            ));
        };
        let previous = self.retry_of(state, &key)?;
        let origin = previous
            .first_failure_at_ms
            .filter(|number| number.number().is_some())
            .unwrap_or(at);
        let retry = TimedRetryState {
            retry: retry_backoff::record_failure(&previous.as_state(), error.clone()),
            first_failure_at_ms: origin.number_or_zero(),
        };
        let mut retries = state.0.retry.spread();
        retries.define(
            key.clone(),
            RecordValue::Entry(RetryProgress {
                attempt: retry.retry.attempt.into(),
                last_error: retry.retry.last_error.clone(),
                first_failure_at_ms: Some(origin),
            }),
        );
        let state = State::from_snapshot(Snapshot {
            retry: Rc::new(retries),
            ..state.0.as_ref().clone()
        });
        if !retry_backoff::should_retry_timed(&retry, policy, at.number_or_zero()) {
            return Ok(Step::new(
                self.set_call(&state, key, CallPhase::Failed { error }),
                vec![],
            ));
        }
        let mut rng =
            retry_backoff::as_rng(|| (self.rng)(), false).expect("an unprobed RNG does not sample");
        let retry_at_ms = (at.number_or_zero()
            + retry_backoff::next_delay_ms(&retry.retry, &policy.curve, &mut rng))
        .into();
        Ok(Step::new(
            self.set_call(
                &state,
                key,
                CallPhase::WaitingRetry {
                    input,
                    retry_at_ms,
                    budget,
                },
            ),
            vec![],
        ))
    }
    fn timer_id(&self, kind: &str, key: &JsText) -> JsText {
        let mut units = format!("{}:{kind}:", self.name())
            .encode_utf16()
            .collect::<Vec<_>>();
        units.extend_from_slice(key.as_units());
        JsText::from_units(units)
    }
    fn gate(
        &self,
        state: &State<I, R, E>,
        key: JsText,
        input: CallValue<I>,
        at: CallNumber,
        budget: CallBudget,
    ) -> Result<CallStep<I, R, E, H>, ResilientError> {
        if self.config.deadline.is_some() && budget.remaining_ms.number_or_zero() <= 0.0 {
            let error = Rc::new(CallFailure::DeadlineExceeded {
                id: self.timer_id("deadline", &key),
                at_ms: at,
            });
            return Ok(Step::new(
                self.set_call(state, key, CallPhase::Failed { error }),
                vec![],
            ));
        }
        if self.config.cache.is_some()
            && let Some(value) =
                cache::get_with_projection(&state.0.cache, key.clone(), at, |value| {
                    self.projection.project(value)
                })?
        {
            let value = self.projection.read(value)?;
            if !value.is_undefined() {
                return Ok(Step::new(
                    self.set_call(state, key, CallPhase::Succeeded { result: value }),
                    vec![],
                ));
            }
        }
        let mut bucket = state.0.bucket;
        if self.config.rate_limit.is_some() {
            let (next, allowed) = rate_limit::try_consume(&bucket, at, 1.0);
            bucket = next;
            if !allowed {
                let state = State::from_snapshot(Snapshot {
                    bucket,
                    ..state.0.as_ref().clone()
                });
                return self.backoff(
                    &state,
                    key,
                    input,
                    Rc::new(CallFailure::RateLimited),
                    at,
                    budget,
                );
            }
        }
        let mut circuit = state.0.circuit;
        if let Some(policy) = self.config.circuit {
            let (next, allowed) = circuit_breaker::can_pass(&circuit, &policy.into(), at);
            circuit = next;
            if !allowed {
                let mut state = self
                    .set_call(state, key, CallPhase::CircuitOpen)
                    .0
                    .as_ref()
                    .clone();
                state.bucket = bucket;
                state.circuit = circuit;
                return Ok(Step::new(State::from_snapshot(state), vec![]));
            }
        }
        let input = input.present();
        let mut state = self
            .set_call(
                state,
                key.clone(),
                CallPhase::Running {
                    input: input.clone(),
                    budget,
                },
            )
            .0
            .as_ref()
            .clone();
        state.bucket = bucket;
        state.circuit = circuit;
        Ok(Step::new(
            State::from_snapshot(state),
            vec![self.run.from_record(RunInput { key, input })],
        ))
    }
    pub fn attempt(
        &self,
        state: &State<I, R, E>,
        key: impl Into<JsText>,
        input: CallValue<I>,
        at: impl Into<CallNumber>,
    ) -> Result<CallStep<I, R, E, H>, ResilientError> {
        let at = at.into();
        let key = key.into();
        let budget = self.budget_for(state, &key, at);
        self.gate(&self.tick(state, at), key, input, at, budget)
    }
    pub fn settle(
        &self,
        state: &State<I, R, E>,
        msg: SettleInput<R, E>,
    ) -> Result<SettleResult<I, R, E, H>, ResilientError> {
        match msg {
            SettleInput::Ok { key, value, at } => {
                let value = value.present();
                let state = self.tick(state, at);
                let mut state = self
                    .set_call(
                        &state,
                        key.clone(),
                        CallPhase::Succeeded {
                            result: value.clone(),
                        },
                    )
                    .0
                    .as_ref()
                    .clone();
                if let Some(config) = self.config.cache {
                    state.cache = Rc::new(cache::set(
                        &state.cache,
                        key.clone(),
                        value.clone(),
                        at,
                        config.ttl_ms,
                    ));
                }
                let mut retry = state.retry.spread();
                retry.delete(&key);
                state.retry = Rc::new(retry);
                if let Some(policy) = self.config.circuit {
                    state.circuit = circuit_breaker::on_success(&state.circuit, &policy.into());
                }
                Ok(SettleResult {
                    call: State::from_snapshot(state),
                    commands: vec![],
                    outcome: SettleOutcome::Done { value },
                })
            }
            SettleInput::Err { key, error, at } => {
                let state = self.tick(state, at);
                let budget = self.budget_for(&state, &key, at);
                let input = match state.call(&key) {
                    Some(CallPhase::Running { input, .. }) if !input.is_undefined() => {
                        Some(input.clone())
                    }
                    _ => None,
                };
                let circuit = self.config.circuit.map_or(state.0.circuit, |policy| {
                    circuit_breaker::on_failure(&state.0.circuit, &policy.into(), at)
                });
                let state = State::from_snapshot(Snapshot {
                    circuit,
                    ..state.0.as_ref().clone()
                });
                let step = match input {
                    Some(input) => {
                        self.backoff(&state, key.clone(), input, error.clone(), at, budget)?
                    }
                    None => Step::new(
                        self.set_call(
                            &state,
                            key.clone(),
                            CallPhase::Failed {
                                error: error.clone(),
                            },
                        ),
                        vec![],
                    ),
                };
                let outcome =
                    if matches!(step.state.call(&key), Some(CallPhase::WaitingRetry { .. })) {
                        SettleOutcome::Retrying
                    } else {
                        SettleOutcome::Failed { error }
                    };
                Ok(SettleResult {
                    call: step.state,
                    commands: step.commands,
                    outcome,
                })
            }
        }
    }
    pub fn settle_failed(
        &self,
        state: &State<I, R, E>,
        key: impl Into<JsText>,
        error: CallFailure<E>,
        at: impl Into<CallNumber>,
    ) -> CallStep<I, R, E, H> {
        let at = at.into();
        Step::new(
            self.set_call(
                &self.tick(state, at),
                key.into(),
                CallPhase::Failed {
                    error: Rc::new(error),
                },
            ),
            vec![],
        )
    }
    pub fn resume(&self, state: &State<I, R, E>, at: impl Into<CallNumber>) -> State<I, R, E> {
        let at = at.into();
        let mut calls = state.0.calls.spread();
        for (key, call) in state.0.calls.own_entries() {
            let RecordValue::Entry(call) = call else {
                continue;
            };
            let resumed = match call.as_ref() {
                CallPhase::Running { input, budget } => CallPhase::Running {
                    input: input.clone(),
                    budget: CallBudget {
                        charging_since_ms: at,
                        ..*budget
                    },
                },
                CallPhase::WaitingRetry {
                    input,
                    retry_at_ms,
                    budget,
                } => CallPhase::WaitingRetry {
                    input: input.clone(),
                    retry_at_ms: *retry_at_ms,
                    budget: CallBudget {
                        charging_since_ms: at,
                        ..*budget
                    },
                },
                _ => continue,
            };
            calls.define(key.clone(), RecordValue::Entry(Rc::new(resumed)));
        }
        State::from_snapshot(Snapshot {
            calls: Rc::new(calls),
            clock_ms: at,
            ..state.0.as_ref().clone()
        })
    }
    pub fn on_timer(
        &self,
        slice: &State<I, R, E>,
        msg: &DeadlineExceeded,
    ) -> Result<CallStep<I, R, E, H>, ResilientError> {
        let state = self.tick(slice, msg.at_ms);
        for (key, call) in state.0.calls.own_entries() {
            let RecordValue::Entry(call) = call else {
                continue;
            };
            if msg.id == self.timer_id("retry", key) {
                return match call.as_ref() {
                    CallPhase::WaitingRetry { input, budget, .. } => self.gate(
                        &state,
                        key.clone(),
                        input.clone(),
                        msg.at_ms,
                        self.charge(*budget, msg.at_ms),
                    ),
                    _ => Ok(Step::new(state.clone(), vec![])),
                };
            }
            if msg.id == self.timer_id("deadline", key) {
                if !matches!(
                    call.as_ref(),
                    CallPhase::Running { .. } | CallPhase::WaitingRetry { .. }
                ) {
                    return Ok(Step::new(state.clone(), vec![]));
                }
                let error = Rc::new(CallFailure::DeadlineExceeded {
                    id: msg.id.clone(),
                    at_ms: msg.at_ms,
                });
                return Ok(Step::new(
                    self.set_call(&state, key.clone(), CallPhase::Failed { error }),
                    vec![],
                ));
            }
        }
        Ok(Step::new(state, vec![]))
    }
    pub fn deadlines(&self, state: &State<I, R, E>) -> Vec<Deadline> {
        let mut deadlines = Vec::new();
        for (key, call) in state.0.calls.own_entries() {
            let RecordValue::Entry(call) = call else {
                continue;
            };
            let budget = match call.as_ref() {
                CallPhase::WaitingRetry {
                    retry_at_ms,
                    budget,
                    ..
                } => {
                    deadlines.push(self.deadline(self.timer_id("retry", key), *retry_at_ms));
                    budget
                }
                CallPhase::Running { budget, .. } => budget,
                _ => continue,
            };
            if self.config.deadline.is_some() && budget.remaining_ms.number_or_zero() > 0.0 {
                deadlines.push(
                    self.deadline(
                        self.timer_id("deadline", key),
                        (budget.charging_since_ms.number_or_zero()
                            + budget.remaining_ms.number_or_zero())
                        .into(),
                    ),
                );
            }
        }
        deadlines
    }
    fn deadline(&self, id: JsText, at_ms: CallNumber) -> Deadline {
        let deadline = deadline::deadline_sub(id, at_ms);
        if self.name() == DEFAULT_RESILIENT_NAME {
            deadline
        } else {
            deadline.named(self.name())
        }
    }
    pub fn timer(&self, state: &State<I, R, E>) -> Option<TimerDeps<DeadlineExceeded>> {
        deadline::next_timer(&self.deadlines(state), state.0.clock_ms)
    }
}

impl<'a, I, R, E, B: Budget> ResilientCall<'a, I, R, E, B> {
    pub fn settle_message(
        &self,
        state: &State<I, R, E>,
        message: crate::command::Settled<RunSpec<I, R, E>>,
    ) -> Result<SettleResult<I, R, E>, ResilientError> {
        use crate::{
            Tagged,
            command::{Failure, Settlement},
        };
        let (command, outcome, at) = message.into_parts();
        let at = at.ok_or_else(|| ResilientError::MissingStamp {
            command: command.tag().into(),
        })?;
        let key = command.into_input().key;
        let input = match outcome {
            Settlement::Ok(value) => SettleInput::Ok { key, value, at },
            Settlement::Err(error) => SettleInput::Err {
                key,
                error: Rc::new(match error {
                    Failure::Declared(error) => CallFailure::Run(Rc::new(error)),
                    Failure::Malformed(error) => CallFailure::Malformed(error),
                }),
                at,
            },
        };
        self.settle(state, input)
    }
}

pub fn lift_resilience<S, I, R, E, C>(
    state: S,
    result: Step<State<I, R, E>, C>,
    replace: impl FnOnce(S, State<I, R, E>) -> S,
) -> Step<S, C> {
    crate::compose::lift_slice(state, result, replace)
}

impl<'a, I, R, E, H> ResilientCall<'a, I, R, E, CountBound, H> {
    pub(crate) fn retry_sibling<J, U, F>(&self) -> ResilientCall<'a, J, U, F> {
        let mut sibling = ResilientCall::new(Config {
            retry: self.config.retry,
            ..Default::default()
        });
        sibling.rng = Rc::clone(&self.rng);
        sibling
    }
}
