use demlik_tea::retry_backoff::*;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireState {
    #[serde(flatten)]
    retry: RetryState<Value>,
    first_failure_at_ms: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    error: Value,
    at_ms: Option<f64>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Bound {
    #[serde(rename_all = "camelCase")]
    Count {
        max_attempts: f64,
    },
    #[serde(rename_all = "camelCase")]
    Duration {
        max_elapsed_ms: f64,
        max_attempts: Option<f64>,
    },
    Unbounded,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    initial: Option<WireState>,
    failures: Vec<Failure>,
    budget: Bound,
    now_ms: Option<f64>,
}

enum State {
    Untimed(RetryState<Value>),
    Timed(TimedRetryState<Value>),
}
impl State {
    fn value(&self) -> Value {
        match self {
            Self::Untimed(state) => json!(state),
            Self::Timed(state) => json!(state),
        }
    }
    fn retry(&self) -> &RetryState<Value> {
        match self {
            Self::Untimed(state) => state,
            Self::Timed(state) => &state.retry,
        }
    }
}
pub fn state(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut state = match input.initial {
        None => State::Untimed(observe!(calls, demlik_tea::retry_backoff::init_retry)),
        Some(initial) => {
            let retry = initial.retry;
            match initial.first_failure_at_ms {
                None => State::Untimed(retry),
                Some(first_failure_at_ms) => State::Timed(TimedRetryState {
                    retry,
                    first_failure_at_ms,
                }),
            }
        }
    };
    let mut states = vec![state.value()];
    for failure in input.failures {
        state = match state {
            State::Timed(state) => State::Timed(observe!(
                calls,
                demlik_tea::retry_backoff::TimedRetryState::record_failure,
                &state,
                failure.error
            )),
            State::Untimed(state) => match failure.at_ms {
                Some(at) => State::Timed(observe!(
                    calls,
                    demlik_tea::retry_backoff::record_failure_at,
                    &state,
                    failure.error,
                    at
                )),
                None => State::Untimed(observe!(
                    calls,
                    demlik_tea::retry_backoff::record_failure,
                    &state,
                    failure.error
                )),
            },
        };
        states.push(state.value());
    }
    let allowed = match input.budget {
        Bound::Count { max_attempts } => observe!(
            calls,
            demlik_tea::retry_backoff::should_retry,
            state.retry(),
            &RetryPolicy {
                curve: DEFAULT_RETRY_POLICY.curve,
                budget: CountBound { max_attempts },
            },
        ),
        Bound::Unbounded => observe!(
            calls,
            demlik_tea::retry_backoff::should_retry,
            state.retry(),
            &RetryPolicy {
                curve: DEFAULT_RETRY_POLICY.curve,
                budget: Unbounded,
            },
        ),
        Bound::Duration {
            max_elapsed_ms,
            max_attempts,
        } => match (&state, input.now_ms) {
            (State::Timed(state), Some(now)) => observe!(
                calls,
                demlik_tea::retry_backoff::should_retry_timed,
                state,
                &RetryPolicy {
                    curve: DEFAULT_RETRY_POLICY.curve,
                    budget: DurationBound {
                        max_elapsed_ms,
                        max_attempts,
                    },
                },
                now,
            ),
            _ => false, // A raw wire record cannot produce the required timed observation.
        },
    };
    let mut output = json!({ "states": states, "allowed": allowed });
    if let (State::Timed(state), Some(now)) = (&state, input.now_ms) {
        output["elapsedMs"] = json!(observe!(
            calls,
            demlik_tea::retry_backoff::retry_elapsed_ms,
            state,
            now
        ));
    }
    Ok(output)
}

#[derive(Deserialize)]
struct ProbeInput {
    probe: bool,
    samples: Vec<f64>,
}
pub fn probe(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: ProbeInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut draws = 0;
    let result = observe!(
        calls,
        demlik_tea::retry_backoff::as_rng,
        || {
            let sample = input.samples[draws];
            draws += 1;
            sample
        },
        input.probe,
    );
    match result {
        Ok(_) => Ok(json!({ "draws": draws, "accepted": true })),
        Err(error) => Ok(
            json!({ "draws": draws, "accepted": false, "error": { "name": "RangeError", "message": error.to_string() } }),
        ),
    }
}
