pub use crate::work_queue::QueueTime as CircuitNumber;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitPolicy {
    pub failure_threshold: f64,
    pub cooldown_ms: f64,
    pub half_open_max_probes: f64,
}

pub const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = CircuitPolicy {
    failure_threshold: 5.0,
    cooldown_ms: 30_000.0,
    half_open_max_probes: 1.0,
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CircuitState {
    Closed { failures: CircuitNumber },
    Open { opened_at_ms: CircuitNumber },
    HalfOpen { probes: CircuitNumber },
}
impl<'de> Deserialize<'de> for CircuitState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Header {
            phase: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Closed {
            failures: CircuitNumber,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Open {
            opened_at_ms: CircuitNumber,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct HalfOpen {
            probes: CircuitNumber,
        }
        let header: Header = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        Ok(match header.phase.as_str() {
            "closed" => Self::Closed {
                failures: serde_json::from_str::<Closed>(raw.get())
                    .map_err(D::Error::custom)?
                    .failures,
            },
            "open" => Self::Open {
                opened_at_ms: serde_json::from_str::<Open>(raw.get())
                    .map_err(D::Error::custom)?
                    .opened_at_ms,
            },
            "half_open" => Self::HalfOpen {
                probes: serde_json::from_str::<HalfOpen>(raw.get())
                    .map_err(D::Error::custom)?
                    .probes,
            },
            _ => return Err(D::Error::custom("unknown circuit phase")),
        })
    }
}

pub fn init_circuit() -> CircuitState {
    CircuitState::Closed {
        failures: 0.0.into(),
    }
}

pub fn on_success(state: &CircuitState, _policy: &CircuitPolicy) -> CircuitState {
    match state {
        CircuitState::Closed { failures } if failures.number() == Some(0.0) => *state,
        CircuitState::Closed { .. } | CircuitState::HalfOpen { .. } => init_circuit(),
        CircuitState::Open { .. } => *state,
    }
}

pub fn on_failure(
    state: &CircuitState,
    policy: &CircuitPolicy,
    now_ms: impl Into<CircuitNumber>,
) -> CircuitState {
    let now_ms = now_ms.into();
    match state {
        CircuitState::Closed { failures } => {
            let failures = failures.number_or_zero() + 1.0;
            if failures >= policy.failure_threshold {
                CircuitState::Open {
                    opened_at_ms: now_ms,
                }
            } else {
                CircuitState::Closed {
                    failures: failures.into(),
                }
            }
        }
        CircuitState::HalfOpen { .. } => CircuitState::Open {
            opened_at_ms: now_ms,
        },
        CircuitState::Open { .. } => *state,
    }
}

pub fn can_pass(
    state: &CircuitState,
    policy: &CircuitPolicy,
    now_ms: impl Into<CircuitNumber>,
) -> (CircuitState, bool) {
    let now_ms = now_ms.into().number_or_zero();
    match state {
        CircuitState::Closed { .. } => (*state, true),
        CircuitState::Open { opened_at_ms }
            if now_ms - opened_at_ms.number_or_zero() >= policy.cooldown_ms =>
        {
            (CircuitState::HalfOpen { probes: 1.0.into() }, true)
        }
        CircuitState::HalfOpen { probes }
            if probes.number_or_zero() < policy.half_open_max_probes =>
        {
            (
                CircuitState::HalfOpen {
                    probes: (probes.number_or_zero() + 1.0).into(),
                },
                true,
            )
        }
        CircuitState::Open { .. } | CircuitState::HalfOpen { .. } => (*state, false),
    }
}
