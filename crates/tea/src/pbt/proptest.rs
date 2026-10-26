use super::{FoldStep, FoldTrace, fold_events};
use crate::{Machine, NoCellError, Subscription, Tagged, storage::PanicCause};
use ::proptest::{
    collection::{SizeRange, vec},
    strategy::Strategy,
    test_runner::{
        Config, RngAlgorithm, RngSeed, TestCaseError, TestError, TestRunner, noop_result_cache,
    },
};
use std::{
    cell::RefCell,
    fmt,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
};

/// Bounds apply only to the generated tail. Prefix handles are retained verbatim
/// and are never part of the backend's array shrinking.
pub struct SequenceOptions<M> {
    pub tail: SizeRange,
    pub prefix: Vec<Arc<M>>,
}
impl<M> Default for SequenceOptions<M> {
    fn default() -> Self {
        Self {
            tail: (0..=30).into(),
            prefix: vec![],
        }
    }
}

/// Compose Proptest's standard vector strategy with a fixed prefix. Message
/// payloads need neither Clone nor Send; only their Arc handles are cloned.
pub fn msg_sequence<M: Tagged + fmt::Debug>(
    message: impl Strategy<Value = Arc<M>>,
    options: SequenceOptions<M>,
) -> impl Strategy<Value = Vec<Arc<M>>> {
    vec(message, options.tail)
        .prop_map(move |tail| options.prefix.iter().cloned().chain(tail).collect())
}

/// Native Proptest parameters. Seeds, random streams, shrinking and diagnostics
/// are backend-specific, not fast-check seed/coercion compatibility.
/// Persistence and result caching are disabled. Proptest's other rejection
/// limits remain backend settings and may read `PROPTEST_*` environment values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PropertyOptions {
    pub num_runs: u32,
    pub seed: Option<u64>,
}
impl Default for PropertyOptions {
    fn default() -> Self {
        Self {
            num_runs: 200,
            seed: None,
        }
    }
}

pub enum PredicateFailure<E> {
    False,
    Error(E),
    Panic(PanicCause),
}
pub use PredicateFailure as InvariantFailure;

pub enum FailedCase<S, M, C, E> {
    LoadedPanic(PanicCause),
    FoldRefused(NoCellError),
    FoldPanic(PanicCause),
    Invariant {
        trace: FoldTrace<S, M, C>,
        step: usize,
        failure: InvariantFailure<E>,
    },
    Terminates {
        trace: FoldTrace<S, M, C>,
        failure: PredicateFailure<E>,
    },
    Trace {
        trace: FoldTrace<S, M, C>,
        failure: PredicateFailure<E>,
    },
}
/// The messages and trace belong to an actual failing callback evaluation.
/// Proptest may reconstruct equivalent values with different handles when it
/// returns its logical minimum; those reconstructed values are not exposed here.
/// This retains the last actual failing evaluation without replaying callbacks.
/// Standard deterministic trees associate it with the logical minimum; arbitrary
/// nondeterministic or custom value trees have no such equivalence guarantee.
pub struct EvaluatedFailure<S, M, C, E> {
    pub messages: Vec<Arc<M>>,
    pub failure: FailedCase<S, M, C, E>,
}
pub enum PropertyFailure<S, M, C, E> {
    Case {
        reason: String,
        evaluated: Box<EvaluatedFailure<S, M, C, E>>,
    },
    Aborted {
        reason: String,
        last_evaluated: Option<Box<EvaluatedFailure<S, M, C, E>>>,
    },
    BackendPanic {
        cause: PanicCause,
        last_evaluated: Option<Box<EvaluatedFailure<S, M, C, E>>>,
    },
    /// A backend failure without an evaluated failing callback is observable.
    BackendFailure { reason: String },
}
impl<S, M, C, E> fmt::Debug for PropertyFailure<S, M, C, E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Case { reason, evaluated } => f
                .debug_struct("PropertyFailure::Case")
                .field("reason", reason)
                .field("messages", &evaluated.messages.len())
                .finish_non_exhaustive(),
            Self::Aborted { reason, .. } => f
                .debug_struct("PropertyFailure::Aborted")
                .field("reason", reason)
                .finish_non_exhaustive(),
            Self::BackendPanic { cause, .. } => f
                .debug_struct("PropertyFailure::BackendPanic")
                .field("cause", cause)
                .finish_non_exhaustive(),
            Self::BackendFailure { reason } => f
                .debug_struct("PropertyFailure::BackendFailure")
                .field("reason", reason)
                .finish(),
        }
    }
}

fn predicate_result<E>(
    predicate: impl FnOnce() -> Result<bool, E>,
) -> Result<(), PredicateFailure<E>> {
    match catch_unwind(AssertUnwindSafe(predicate)) {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(PredicateFailure::False),
        Ok(Err(error)) => Err(PredicateFailure::Error(error)),
        Err(cause) => Err(PredicateFailure::Panic(PanicCause::new(cause))),
    }
}

fn evaluate<S: Tagged, M: Tagged, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    messages: &[Arc<M>],
    loaded: &impl Fn() -> Option<S>,
    check: &impl Fn(FoldTrace<S, M, C>) -> Result<(), FailedCase<S, M, C, E>>,
) -> Result<(), FailedCase<S, M, C, E>> {
    let loaded = catch_unwind(AssertUnwindSafe(loaded))
        .map_err(|cause| FailedCase::LoadedPanic(PanicCause::new(cause)))?;
    let trace = catch_unwind(AssertUnwindSafe(|| {
        fold_events(machine, input, loaded, messages.iter().cloned())
    }))
    .map_err(|cause| FailedCase::FoldPanic(PanicCause::new(cause)))?
    .map_err(FailedCase::FoldRefused)?;
    check(trace)
}

/// Fully fold each case before checking its steps in order. Original failure
/// data and evaluated handles are retained; no callbacks rerun to reconstruct it.
pub fn property_invariant<S: Tagged, M: Tagged + fmt::Debug, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    strategy: &impl Strategy<Value = Vec<Arc<M>>>,
    loaded: impl Fn() -> Option<S>,
    invariant: impl Fn(&FoldStep<S, M, C>) -> Result<bool, E>,
    options: PropertyOptions,
) -> Result<(), PropertyFailure<S, M, C, E>> {
    run_property(
        machine,
        input,
        strategy,
        loaded,
        |trace| {
            for (step, transition) in trace.steps.iter().enumerate() {
                if let Err(failure) = predicate_result(|| invariant(transition)) {
                    return Err(FailedCase::Invariant {
                        trace,
                        step,
                        failure,
                    });
                }
            }
            Ok(())
        },
        options,
    )
}

/// Check the actual final state once after the complete finite fold, including
/// empty cases. This does not drive effects or prove eventual runtime termination.
/// Predicate errors/panics and the original completed trace remain typed data.
/// False diagnostics do not serialize the model; Source JSON/toJSON formatting
/// effects are a separate compatibility profile.
pub fn property_terminates<S: Tagged, M: Tagged + fmt::Debug, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    strategy: &impl Strategy<Value = Vec<Arc<M>>>,
    loaded: impl Fn() -> Option<S>,
    terminal: impl Fn(&S) -> Result<bool, E>,
    options: PropertyOptions,
) -> Result<(), PropertyFailure<S, M, C, E>> {
    run_property(
        machine,
        input,
        strategy,
        loaded,
        |trace| match predicate_result(|| terminal(&trace.final_state)) {
            Ok(()) => Ok(()),
            Err(failure) => Err(FailedCase::Terminates { trace, failure }),
        },
        options,
    )
}

/// Check the full chronological steps and actual final state once, including
/// empty cases. Inputs borrow the original completed trace; failure retains it.
/// Native typed false/error/panic diagnostics do not invoke Source JSON/toJSON.
pub fn property_trace<S: Tagged, M: Tagged + fmt::Debug, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    strategy: &impl Strategy<Value = Vec<Arc<M>>>,
    loaded: impl Fn() -> Option<S>,
    predicate: impl Fn(&[FoldStep<S, M, C>], &S) -> Result<bool, E>,
    options: PropertyOptions,
) -> Result<(), PropertyFailure<S, M, C, E>> {
    run_property(
        machine,
        input,
        strategy,
        loaded,
        |trace| match predicate_result(|| predicate(&trace.steps, &trace.final_state)) {
            Ok(()) => Ok(()),
            Err(failure) => Err(FailedCase::Trace { trace, failure }),
        },
        options,
    )
}

fn run_property<S: Tagged, M: Tagged + fmt::Debug, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    strategy: &impl Strategy<Value = Vec<Arc<M>>>,
    loaded: impl Fn() -> Option<S>,
    check: impl Fn(FoldTrace<S, M, C>) -> Result<(), FailedCase<S, M, C, E>>,
    options: PropertyOptions,
) -> Result<(), PropertyFailure<S, M, C, E>> {
    let failure = RefCell::new(None);
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut runner = TestRunner::new(Config {
            cases: options.num_runs,
            failure_persistence: None,
            result_cache: noop_result_cache,
            rng_algorithm: RngAlgorithm::ChaCha,
            rng_seed: options.seed.map_or(RngSeed::Random, RngSeed::Fixed),
            max_shrink_time: 0,
            max_shrink_iters: u32::MAX,
            ..Config::default()
        });
        runner
            .run(strategy, |messages| {
                match evaluate(machine, input, &messages, &loaded, &check) {
                    Ok(()) => Ok(()),
                    Err(outcome) => {
                        // RefCell::replace ends its borrow before old opaque values
                        // are dropped. No caller code runs under the slot borrow.
                        let old = failure.replace(Some(Box::new(EvaluatedFailure {
                            messages,
                            failure: outcome,
                        })));
                        drop(old);
                        Err(TestCaseError::fail("machine property failed"))
                    }
                }
            })
            .map_err(|error| match error {
                TestError::Abort(reason) => TestError::Abort(reason),
                TestError::Fail(reason, minimum) => {
                    drop(minimum);
                    TestError::Fail(reason, ())
                }
            })
    }));
    let evaluated = failure.into_inner();
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(TestError::Abort(reason))) => Err(PropertyFailure::Aborted {
            reason: reason.to_string(),
            last_evaluated: evaluated,
        }),
        Ok(Err(TestError::Fail(reason, ()))) => match evaluated {
            Some(evaluated) => Err(PropertyFailure::Case {
                reason: reason.to_string(),
                evaluated,
            }),
            None => Err(PropertyFailure::BackendFailure {
                reason: reason.to_string(),
            }),
        },
        Err(cause) => Err(PropertyFailure::BackendPanic {
            cause: PanicCause::new(cause),
            last_evaluated: evaluated,
        }),
    }
}
