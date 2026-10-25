use crate::{
    PlainData, Step, Tagged,
    data::{JsText, structural_hash},
    idempotency::{self, IdempotencyStore, StoreOptions},
    js_record::JsAccessError,
    resilience::deadline::{Deadline, deadline_sub},
    retry_backoff::{
        self, BackoffCurve, Budget, CountBound, DEFAULT_RETRY_POLICY, RetryPolicy, RetryState,
        TimedRetryState,
    },
    work_queue::QueueField,
};
use std::rc::Rc;
mod wire;
pub use crate::work_queue::QueueTime as PollerNumber;
pub enum PollerPhase {
    Polling { next_at_ms: PollerNumber },
    Done,
    GaveUp,
}
impl PollerPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Polling { .. } => "polling",
            Self::Done => "done",
            Self::GaveUp => "gave_up",
        }
    }
}
pub struct PollerRetry<F> {
    pub attempt: PollerNumber,
    pub last_error: QueueField<Rc<F>>,
    pub first_failure_at_ms: QueueField<PollerNumber>,
}
impl<F> PollerRetry<F> {
    pub fn new() -> Self {
        let state = retry_backoff::init_retry::<Rc<F>>();
        Self {
            attempt: state.attempt.into(),
            last_error: QueueField::Absent,
            first_failure_at_ms: QueueField::Absent,
        }
    }
    fn as_state(&self) -> RetryState<Rc<F>> {
        RetryState {
            attempt: self.attempt.number_or_zero(),
            last_error: self.last_error.value().cloned(),
        }
    }
    fn failed(&self, error: Rc<F>, at: f64) -> TimedRetryState<Rc<F>> {
        let origin = self.first_failure_at_ms.value().and_then(|at| at.number());
        let state = self.as_state();
        match origin {
            Some(origin) => TimedRetryState {
                retry: state,
                first_failure_at_ms: origin,
            }
            .record_failure(error),
            None => retry_backoff::record_failure_at(&state, error, at),
        }
    }
    fn from_timed(state: TimedRetryState<Rc<F>>) -> Self {
        Self {
            attempt: state.retry.attempt.into(),
            last_error: state
                .retry
                .last_error
                .map_or(QueueField::Absent, QueueField::Value),
            first_failure_at_ms: QueueField::Value(state.first_failure_at_ms.into()),
        }
    }
}
impl<F> Default for PollerRetry<F> {
    fn default() -> Self {
        Self::new()
    }
}
pub struct PollerState<R, F = PlainData> {
    pub phase: PollerPhase,
    pub tick: PollerNumber,
    pub last_result: QueueField<Rc<R>>,
    pub retry: Rc<PollerRetry<F>>,
    pub dedupe: Rc<IdempotencyStore<bool>>,
}
impl<R, F> Tagged for PollerState<R, F> {
    fn tag(&self) -> &str {
        self.phase.as_str()
    }
}
pub type PollerStep<R, C, F = PlainData> = Step<Rc<PollerState<R, F>>, Rc<C>>;
pub trait Poller<R, C, F = PlainData> {
    fn init(&self) -> Rc<PollerState<R, F>>;
    fn start(&self, state: &Rc<PollerState<R, F>>, at: f64) -> PollerStep<R, C, F>;
    fn tick(&self, state: &Rc<PollerState<R, F>>) -> PollerStep<R, C, F>;
    fn tick_result(
        &self,
        state: &Rc<PollerState<R, F>>,
        result: Rc<R>,
        at: f64,
        until_held: bool,
    ) -> Result<PollerStep<R, C, F>, JsAccessError>;
    fn tick_err(&self, state: &Rc<PollerState<R, F>>, error: Rc<F>, at: f64)
    -> PollerStep<R, C, F>;
    fn subs(&self, state: &PollerState<R, F>) -> Vec<Deadline>;
}
type Until<'a, S> = Rc<dyn Fn(&S) -> bool + 'a>;
type OnTick<'a, C> = Rc<dyn Fn() -> Rc<C> + 'a>;
type DedupeKey<'a, R> = Rc<dyn Fn(&R) -> JsText + 'a>;
pub struct PollerConfig<'a, S, R, C, B = CountBound> {
    pub every_ms: f64,
    /// Retained authored configuration. The caller supplies its evaluated
    /// predicate as `until_held`; the knob never invokes this callback.
    pub until: Until<'a, S>,
    pub on_tick: OnTick<'a, C>,
    pub retry: Option<RetryPolicy<B>>,
    pub dedupe_key: Option<DedupeKey<'a, R>>,
    pub dedupe_ttl_ms: Option<f64>,
}
impl<'a, S, R, C> PollerConfig<'a, S, R, C> {
    pub fn new(
        every_ms: f64,
        until: impl Fn(&S) -> bool + 'a,
        on_tick: impl Fn() -> Rc<C> + 'a,
    ) -> Self {
        Self {
            every_ms,
            until: Rc::new(until),
            on_tick: Rc::new(on_tick),
            retry: None,
            dedupe_key: None,
            dedupe_ttl_ms: None,
        }
    }
}
impl<'a, S, R, C, B> PollerConfig<'a, S, R, C, B> {
    pub fn with_retry<N>(self, policy: RetryPolicy<N>) -> PollerConfig<'a, S, R, C, N> {
        PollerConfig {
            every_ms: self.every_ms,
            until: self.until,
            on_tick: self.on_tick,
            retry: Some(policy),
            dedupe_key: self.dedupe_key,
            dedupe_ttl_ms: self.dedupe_ttl_ms,
        }
    }
}
pub struct PollerKnob<'a, S, R, C, F = PlainData, B = CountBound> {
    pub config: PollerConfig<'a, S, R, C, B>,
    rng: Rc<dyn Fn() -> f64 + 'a>,
    failure: std::marker::PhantomData<fn() -> F>,
}
pub fn create_poller<S, R, C, F, B>(
    config: PollerConfig<'_, S, R, C, B>,
) -> PollerKnob<'_, S, R, C, F, B> {
    PollerKnob {
        config,
        rng: Rc::new(fastrand::f64),
        failure: std::marker::PhantomData,
    }
}
impl<'a, S, R, C, F, B> PollerKnob<'a, S, R, C, F, B> {
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.rng = Rc::new(rng);
        self
    }
}
fn assigned<T>(field: &QueueField<Rc<T>>) -> QueueField<Rc<T>> {
    match field {
        QueueField::Value(value) => QueueField::Value(Rc::clone(value)),
        QueueField::Absent | QueueField::Undefined => QueueField::Undefined,
    }
}
impl<S, R, C, F, B: Budget> Poller<R, C, F> for PollerKnob<'_, S, R, C, F, B> {
    fn init(&self) -> Rc<PollerState<R, F>> {
        Rc::new(PollerState {
            phase: PollerPhase::Polling {
                next_at_ms: PollerNumber(None),
            },
            tick: 0.0.into(),
            last_result: QueueField::Absent,
            retry: Rc::new(PollerRetry::new()),
            dedupe: Rc::new(idempotency::init_store(StoreOptions {
                capacity: None,
                ttl_ms: self.config.dedupe_ttl_ms,
            })),
        })
    }
    fn start(&self, state: &Rc<PollerState<R, F>>, at: f64) -> PollerStep<R, C, F> {
        Step::new(
            Rc::new(PollerState {
                phase: PollerPhase::Polling {
                    next_at_ms: (at + self.config.every_ms).into(),
                },
                tick: state.tick,
                last_result: assigned(&state.last_result),
                retry: Rc::clone(&state.retry),
                dedupe: Rc::clone(&state.dedupe),
            }),
            vec![],
        )
    }
    fn tick(&self, state: &Rc<PollerState<R, F>>) -> PollerStep<R, C, F> {
        Step::new(
            Rc::clone(state),
            if matches!(state.phase, PollerPhase::Polling { .. }) {
                vec![(self.config.on_tick)()]
            } else {
                vec![]
            },
        )
    }
    fn tick_result(
        &self,
        state: &Rc<PollerState<R, F>>,
        result: Rc<R>,
        at: f64,
        until_held: bool,
    ) -> Result<PollerStep<R, C, F>, JsAccessError> {
        let mut next = PollerState {
            phase: if until_held {
                PollerPhase::Done
            } else {
                PollerPhase::Polling {
                    next_at_ms: (at + self.config.every_ms).into(),
                }
            },
            tick: (state.tick.number_or_zero() + 1.0).into(),
            last_result: QueueField::Value(result),
            retry: Rc::new(PollerRetry::new()),
            dedupe: Rc::clone(&state.dedupe),
        };
        if until_held {
            return Ok(Step::new(Rc::new(next), vec![]));
        }
        let Some(key_of) = &self.config.dedupe_key else {
            return Ok(Step::new(Rc::new(next), vec![]));
        };
        let key = key_of(next.last_result.value().unwrap());
        let suppress = idempotency::seen(&next.dedupe, key.clone(), at)?;
        next.dedupe = Rc::new(idempotency::remember(&next.dedupe, key, true, at)?);
        Ok(Step::new(
            Rc::new(next),
            if suppress {
                vec![]
            } else {
                vec![(self.config.on_tick)()]
            },
        ))
    }
    fn tick_err(
        &self,
        state: &Rc<PollerState<R, F>>,
        error: Rc<F>,
        at: f64,
    ) -> PollerStep<R, C, F> {
        let retry = state.retry.failed(error, at);
        let allowed = match &self.config.retry {
            Some(policy) => retry_backoff::should_retry_timed(&retry, policy, at),
            None => retry_backoff::should_retry_timed(&retry, &DEFAULT_RETRY_POLICY, at),
        };
        let phase = if allowed {
            let curve: &BackoffCurve = self
                .config
                .retry
                .as_ref()
                .map_or(&DEFAULT_RETRY_POLICY.curve, |policy| &policy.curve);
            let mut rng =
                retry_backoff::as_rng(|| (self.rng)(), false).expect("disabled RNG probe");
            PollerPhase::Polling {
                next_at_ms: (at + retry_backoff::next_delay_ms(&retry.retry, curve, &mut rng))
                    .into(),
            }
        } else {
            PollerPhase::GaveUp
        };
        Step::new(
            Rc::new(PollerState {
                phase,
                tick: (state.tick.number_or_zero() + 1.0).into(),
                last_result: assigned(&state.last_result),
                retry: Rc::new(PollerRetry::from_timed(retry)),
                dedupe: Rc::clone(&state.dedupe),
            }),
            vec![],
        )
    }
    fn subs(&self, state: &PollerState<R, F>) -> Vec<Deadline> {
        let PollerPhase::Polling { next_at_ms } = &state.phase else {
            return vec![];
        };
        let Some(at) = next_at_ms.number() else {
            return vec![];
        };
        vec![deadline_sub(
            format!("poller:tick:{}", structural_hash(&PlainData::Number(at))),
            *next_at_ms,
        )]
    }
}
