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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CircuitState {
    Closed { failures: f64 },
    Open { opened_at_ms: f64 },
    HalfOpen { probes: f64 },
}

pub fn init_circuit() -> CircuitState {
    CircuitState::Closed { failures: 0.0 }
}

pub fn on_success(state: &CircuitState, _policy: &CircuitPolicy) -> CircuitState {
    match state {
        CircuitState::Closed { failures } if *failures == 0.0 => *state,
        CircuitState::Closed { .. } | CircuitState::HalfOpen { .. } => init_circuit(),
        CircuitState::Open { .. } => *state,
    }
}

pub fn on_failure(state: &CircuitState, policy: &CircuitPolicy, now_ms: f64) -> CircuitState {
    match state {
        CircuitState::Closed { failures } => {
            let failures = failures + 1.0;
            if failures >= policy.failure_threshold {
                CircuitState::Open {
                    opened_at_ms: now_ms,
                }
            } else {
                CircuitState::Closed { failures }
            }
        }
        CircuitState::HalfOpen { .. } => CircuitState::Open {
            opened_at_ms: now_ms,
        },
        CircuitState::Open { .. } => *state,
    }
}

pub fn can_pass(state: &CircuitState, policy: &CircuitPolicy, now_ms: f64) -> (CircuitState, bool) {
    match state {
        CircuitState::Closed { .. } => (*state, true),
        CircuitState::Open { opened_at_ms } if now_ms - opened_at_ms >= policy.cooldown_ms => {
            (CircuitState::HalfOpen { probes: 1.0 }, true)
        }
        CircuitState::HalfOpen { probes } if *probes < policy.half_open_max_probes => (
            CircuitState::HalfOpen {
                probes: probes + 1.0,
            },
            true,
        ),
        CircuitState::Open { .. } | CircuitState::HalfOpen { .. } => (*state, false),
    }
}
