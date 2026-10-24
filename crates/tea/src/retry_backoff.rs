use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Jitter {
    None,
    Full,
    Equal,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackoffCurve {
    pub base_ms: f64,
    pub factor: f64,
    pub cap_ms: f64,
    pub jitter: Jitter,
}

pub struct Rng<F> {
    source: F,
}

#[derive(Debug)]
pub struct RngRangeError {
    pub sample: f64,
}
impl std::fmt::Display for RngRangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "asRng: generator returned {}, outside the [0, 1) contract",
            ryu_js::Buffer::new().format(self.sample)
        )
    }
}
impl std::error::Error for RngRangeError {}

pub fn as_rng<F: FnMut() -> f64>(mut source: F, probe: bool) -> Result<Rng<F>, RngRangeError> {
    if probe {
        let sample = source();
        if !(0.0..1.0).contains(&sample) {
            return Err(RngRangeError { sample });
        }
    }
    Ok(Rng { source })
}

pub fn default_rng() -> Rng<fn() -> f64> {
    Rng {
        source: fastrand::f64,
    }
}

/// A raw generator must enter through [`as_rng`].
///
/// ```compile_fail,E0308
/// use demlik_tea::retry_backoff::{backoff_delay, DEFAULT_RETRY_POLICY};
/// backoff_delay(0.0, &DEFAULT_RETRY_POLICY.curve, &mut || 0.5);
/// ```
pub fn backoff_delay<F: FnMut() -> f64>(
    attempt: f64,
    curve: &BackoffCurve,
    rng: &mut Rng<F>,
) -> f64 {
    let attempt = if attempt < 0.0 { 0.0 } else { attempt };
    let power = if attempt == 0.0 {
        1.0
    } else if curve.factor.abs() == 1.0 && attempt.is_infinite() {
        f64::NAN
    } else {
        crate::js_math::pow(curve.factor, attempt)
    };
    let exponential = curve.base_ms * power;
    let delay = if exponential.is_nan() {
        0.0
    } else {
        js_min(curve.cap_ms, exponential)
    };
    match curve.jitter {
        Jitter::None => delay,
        Jitter::Full => js_min(delay, (rng.source)() * delay),
        Jitter::Equal => js_min(delay, delay / 2.0 + (rng.source)() * (delay / 2.0)),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountBound {
    pub max_attempts: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationBound {
    pub max_elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Unbounded;

impl Serialize for Unbounded {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("Unbounded", 1)?;
        value.serialize_field("unbounded", &true)?;
        value.end()
    }
}

pub trait Budget {
    fn max_attempts(&self) -> Option<f64>;
    fn max_elapsed_ms(&self) -> Option<f64>;
}
pub trait ClockFreeBudget: Budget {}
impl Budget for CountBound {
    fn max_attempts(&self) -> Option<f64> {
        Some(self.max_attempts)
    }
    fn max_elapsed_ms(&self) -> Option<f64> {
        None
    }
}
impl ClockFreeBudget for CountBound {}
impl Budget for DurationBound {
    fn max_attempts(&self) -> Option<f64> {
        self.max_attempts
    }
    fn max_elapsed_ms(&self) -> Option<f64> {
        Some(self.max_elapsed_ms)
    }
}
impl Budget for Unbounded {
    fn max_attempts(&self) -> Option<f64> {
        None
    }
    fn max_elapsed_ms(&self) -> Option<f64> {
        None
    }
}
impl ClockFreeBudget for Unbounded {}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct RetryPolicy<B = CountBound> {
    #[serde(flatten)]
    pub curve: BackoffCurve,
    #[serde(flatten)]
    pub budget: B,
}
pub type DurationRetryPolicy = RetryPolicy<DurationBound>;
pub type UnboundedRetryPolicy = RetryPolicy<Unbounded>;
pub const DEFAULT_RETRY_POLICY: RetryPolicy = RetryPolicy {
    curve: BackoffCurve {
        base_ms: 100.0,
        factor: 2.0,
        cap_ms: 30_000.0,
        jitter: Jitter::Full,
    },
    budget: CountBound { max_attempts: 5.0 },
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(bound(deserialize = "E: Deserialize<'de>"))]
pub struct RetryState<E> {
    pub attempt: f64,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_error: Option<E>,
}

fn deserialize_present<'de, D: serde::Deserializer<'de>, E: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<E>, D::Error> {
    E::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(bound(deserialize = "E: Deserialize<'de>"))]
pub struct TimedRetryState<E> {
    #[serde(flatten)]
    pub retry: RetryState<E>,
    pub first_failure_at_ms: f64,
}

pub fn init_retry<E>() -> RetryState<E> {
    RetryState {
        attempt: 0.0,
        last_error: None,
    }
}

pub fn record_failure<E>(state: &RetryState<E>, error: E) -> RetryState<E> {
    RetryState {
        attempt: state.attempt + 1.0,
        last_error: Some(error),
    }
}
pub fn record_failure_at<E>(state: &RetryState<E>, error: E, at_ms: f64) -> TimedRetryState<E> {
    TimedRetryState {
        retry: record_failure(state, error),
        first_failure_at_ms: at_ms,
    }
}
impl<E> TimedRetryState<E> {
    pub fn record_failure(&self, error: E) -> Self {
        Self {
            retry: record_failure(&self.retry, error),
            first_failure_at_ms: self.first_failure_at_ms,
        }
    }
}

pub fn retry_elapsed_ms<E>(state: &TimedRetryState<E>, now_ms: f64) -> f64 {
    let elapsed = now_ms - state.first_failure_at_ms;
    if elapsed > 0.0 { elapsed } else { 0.0 }
}
/// Duration budgets use [`should_retry_timed`], which requires both origin and clock.
///
/// ```compile_fail,E0277
/// use demlik_tea::retry_backoff::*;
/// let state = record_failure_at(&init_retry::<()>(), (), 100.0);
/// let policy = RetryPolicy { curve: DEFAULT_RETRY_POLICY.curve,
///     budget: DurationBound { max_elapsed_ms: 5000.0, max_attempts: None } };
/// should_retry(&state.retry, &policy);
/// ```
pub fn should_retry<E, B: ClockFreeBudget>(state: &RetryState<E>, policy: &RetryPolicy<B>) -> bool {
    !policy
        .budget
        .max_attempts()
        .is_some_and(|max| state.attempt >= max)
}
/// ```compile_fail,E0308
/// use demlik_tea::retry_backoff::*;
/// let policy = RetryPolicy { curve: DEFAULT_RETRY_POLICY.curve,
///     budget: DurationBound { max_elapsed_ms: 5000.0, max_attempts: None } };
/// should_retry_timed(&init_retry::<()>(), &policy, 101.0);
/// ```
pub fn should_retry_timed<E, B: Budget>(
    state: &TimedRetryState<E>,
    policy: &RetryPolicy<B>,
    now_ms: f64,
) -> bool {
    !policy
        .budget
        .max_attempts()
        .is_some_and(|max| state.retry.attempt >= max)
        && policy
            .budget
            .max_elapsed_ms()
            .is_none_or(|max| now_ms - state.first_failure_at_ms < max)
}
pub fn next_delay_ms<E, F: FnMut() -> f64>(
    state: &RetryState<E>,
    curve: &BackoffCurve,
    rng: &mut Rng<F>,
) -> f64 {
    backoff_delay(state.attempt, curve, rng)
}

fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left == 0.0 && right == 0.0 {
        if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if left < right {
        left
    } else {
        right
    }
}
