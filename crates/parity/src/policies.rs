use super::{Number, encode_number};
use demlik_tea::resilience::circuit_breaker::{
    CircuitPolicy, CircuitState, DEFAULT_CIRCUIT_POLICY,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum CircuitInitial {
    Closed { failures: Number },
    Open { opened_at_ms: Number },
    HalfOpen { probes: Number },
}
impl CircuitInitial {
    fn state(self) -> CircuitState {
        match self {
            Self::Closed { failures } => CircuitState::Closed {
                failures: failures.value(),
            },
            Self::Open { opened_at_ms } => CircuitState::Open {
                opened_at_ms: opened_at_ms.value(),
            },
            Self::HalfOpen { probes } => CircuitState::HalfOpen {
                probes: probes.value(),
            },
        }
    }
}
fn circuit_value(state: &CircuitState) -> Value {
    match state {
        CircuitState::Closed { failures } => {
            json!({"phase":"closed", "failures":encode_number(*failures)})
        }
        CircuitState::Open { opened_at_ms } => {
            json!({"phase":"open", "openedAtMs":encode_number(*opened_at_ms)})
        }
        CircuitState::HalfOpen { probes } => {
            json!({"phase":"half_open", "probes":encode_number(*probes)})
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCircuitPolicy {
    failure_threshold: Number,
    cooldown_ms: Number,
    half_open_max_probes: Number,
}
impl WireCircuitPolicy {
    fn policy(self) -> CircuitPolicy {
        CircuitPolicy {
            failure_threshold: self.failure_threshold.value(),
            cooldown_ms: self.cooldown_ms.value(),
            half_open_max_probes: self.half_open_max_probes.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "event",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum CircuitStep {
    Success,
    Failure { now_ms: Number },
    Pass { now_ms: Number },
}
#[derive(Deserialize)]
struct CircuitInput {
    initial: Option<CircuitInitial>,
    policy: Option<WireCircuitPolicy>,
    steps: Vec<CircuitStep>,
}
fn circuit(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: CircuitInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let policy = input
        .policy
        .map(WireCircuitPolicy::policy)
        .unwrap_or(DEFAULT_CIRCUIT_POLICY);
    let mut state = input
        .initial
        .map(CircuitInitial::state)
        .unwrap_or_else(|| observe!(calls, demlik_tea::resilience::circuit_breaker::init_circuit));
    let mut trace = vec![json!({"state":circuit_value(&state)})];
    for step in input.steps {
        match step {
            CircuitStep::Success => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::circuit_breaker::on_success,
                    &state,
                    &policy
                );
                trace.push(json!({"state":circuit_value(&state)}));
            }
            CircuitStep::Failure { now_ms } => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::circuit_breaker::on_failure,
                    &state,
                    &policy,
                    now_ms.value()
                );
                trace.push(json!({"state":circuit_value(&state)}));
            }
            CircuitStep::Pass { now_ms } => {
                let (next, allowed) = observe!(
                    calls,
                    demlik_tea::resilience::circuit_breaker::can_pass,
                    &state,
                    &policy,
                    now_ms.value()
                );
                state = next;
                trace.push(json!({"state":circuit_value(&state), "allowed":allowed}));
            }
        }
    }
    Ok(json!({"trace":trace}))
}
pub fn execute(
    operation: &str,
    input: Value,
    calls: &mut Vec<&'static str>,
) -> Result<Value, String> {
    match operation {
        "tea.policies.circuit" => circuit(input, calls),
        "tea.policies.idempotency" => idempotency(input, calls),
        "tea.policies.cache" => cache(input, calls),
        "tea.policies.bucket" => bucket(input, calls),
        "tea.policies.window" => window(input, calls),
        _ => Err(format!("unsupported policy operation: {operation}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BucketInitial {
    tokens: Number,
    capacity: Number,
    refill_per_sec: Number,
    last_refill_ms: Number,
}
impl BucketInitial {
    fn state(self) -> demlik_tea::resilience::rate_limit::TokenBucket {
        demlik_tea::resilience::rate_limit::TokenBucket {
            tokens: self.tokens.value(),
            capacity: self.capacity.value(),
            refill_per_sec: self.refill_per_sec.value(),
            last_refill_ms: self.last_refill_ms.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "event",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum BucketStep {
    Refill { now_ms: Number },
    Consume { now_ms: Number, n: Option<Number> },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BucketInput {
    initial: Option<BucketInitial>,
    capacity: Number,
    refill_per_sec: Number,
    now_ms: Number,
    steps: Vec<BucketStep>,
}
fn bucket_value(state: &demlik_tea::resilience::rate_limit::TokenBucket) -> Value {
    json!({"tokens":encode_number(state.tokens), "capacity":encode_number(state.capacity), "refillPerSec":encode_number(state.refill_per_sec), "lastRefillMs":encode_number(state.last_refill_ms)})
}
fn bucket(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: BucketInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut state = input.initial.map(BucketInitial::state).unwrap_or_else(|| {
        observe!(
            calls,
            demlik_tea::resilience::rate_limit::init_bucket,
            input.capacity.value(),
            input.refill_per_sec.value(),
            input.now_ms.value()
        )
    });
    let mut trace = vec![json!({"state":bucket_value(&state)})];
    for step in input.steps {
        match step {
            BucketStep::Refill { now_ms } => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::rate_limit::refill,
                    &state,
                    now_ms.value()
                );
                trace.push(json!({"state":bucket_value(&state)}));
            }
            BucketStep::Consume { now_ms, n } => {
                let (next, allowed) = observe!(
                    calls,
                    demlik_tea::resilience::rate_limit::try_consume,
                    &state,
                    now_ms.value(),
                    n.map(Number::value).unwrap_or(1.0)
                );
                state = next;
                trace.push(json!({"state":bucket_value(&state),"allowed":allowed}));
            }
        }
    }
    Ok(json!({"trace":trace}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowInitial {
    hits: Vec<Number>,
    window_ms: Number,
    limit: Number,
}
impl WindowInitial {
    fn state(self) -> demlik_tea::resilience::rate_limit::SlidingWindow {
        demlik_tea::resilience::rate_limit::SlidingWindow {
            hits: self.hits.into_iter().map(Number::value).collect(),
            window_ms: self.window_ms.value(),
            limit: self.limit.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "event",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum WindowStep {
    Record { now_ms: Number },
    Remaining { now_ms: Number },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowInput {
    initial: Option<WindowInitial>,
    window_ms: Number,
    limit: Number,
    steps: Vec<WindowStep>,
}
fn window_value(state: &demlik_tea::resilience::rate_limit::SlidingWindow) -> Value {
    json!({"hits":state.hits.iter().map(|value|encode_number(*value)).collect::<Vec<_>>(), "windowMs":encode_number(state.window_ms), "limit":encode_number(state.limit)})
}
fn window(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: WindowInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut state = input.initial.map(WindowInitial::state).unwrap_or_else(|| {
        observe!(
            calls,
            demlik_tea::resilience::rate_limit::init_window,
            input.window_ms.value(),
            input.limit.value()
        )
    });
    let mut trace = vec![json!({"state":window_value(&state)})];
    for step in input.steps {
        match step {
            WindowStep::Record { now_ms } => {
                let (next, allowed) = observe!(
                    calls,
                    demlik_tea::resilience::rate_limit::record,
                    &state,
                    now_ms.value()
                );
                state = next;
                trace.push(json!({"state":window_value(&state), "allowed":allowed}));
            }
            WindowStep::Remaining { now_ms } => {
                let remaining = observe!(
                    calls,
                    demlik_tea::resilience::rate_limit::remaining,
                    &state,
                    now_ms.value()
                );
                trace.push(
                    json!({"state":window_value(&state), "remaining":encode_number(remaining)}),
                );
            }
        }
    }
    Ok(json!({"trace":trace}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheWireEntry {
    value: Value,
    expires_at_ms: Number,
}
#[derive(Deserialize)]
struct CacheInitial {
    entries: std::collections::BTreeMap<String, CacheWireEntry>,
}
impl CacheInitial {
    fn state(self) -> demlik_tea::resilience::cache::TtlCache<Value> {
        demlik_tea::resilience::cache::TtlCache {
            entries: self
                .entries
                .into_iter()
                .map(|(key, entry)| {
                    (
                        key,
                        demlik_tea::resilience::cache::CacheEntry {
                            value: entry.value,
                            expires_at_ms: entry.expires_at_ms.value(),
                        },
                    )
                })
                .collect(),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "event",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum CacheStep {
    Set {
        key: String,
        value: Value,
        now_ms: Number,
        ttl_ms: Number,
    },
    Remove {
        key: String,
    },
    Evict {
        now_ms: Number,
    },
    Read {
        key: String,
        now_ms: Number,
    },
}
#[derive(Deserialize)]
struct CacheInput {
    initial: Option<CacheInitial>,
    steps: Vec<CacheStep>,
}
fn cache_value(state: &demlik_tea::resilience::cache::TtlCache<Value>) -> Value {
    let entries: serde_json::Map<_, _> = state
        .entries
        .iter()
        .map(|(key, entry)| {
            (
                key.clone(),
                json!({"value":entry.value, "expiresAtMs":encode_number(entry.expires_at_ms)}),
            )
        })
        .collect();
    json!({"entries":entries})
}
fn cache(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: CacheInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut state = input
        .initial
        .map(CacheInitial::state)
        .unwrap_or_else(|| observe!(calls, demlik_tea::resilience::cache::init_cache));
    let mut trace = vec![json!({"state":cache_value(&state)})];
    for step in input.steps {
        match step {
            CacheStep::Set {
                key,
                value,
                now_ms,
                ttl_ms,
            } => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::cache::set,
                    &state,
                    key,
                    value,
                    now_ms.value(),
                    ttl_ms.value()
                )
            }
            CacheStep::Remove { key } => {
                state = observe!(calls, demlik_tea::resilience::cache::remove, &state, &key)
            }
            CacheStep::Evict { now_ms } => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::cache::evict_expired,
                    &state,
                    now_ms.value()
                )
            }
            CacheStep::Read { key, now_ms } => {
                let value = observe!(
                    calls,
                    demlik_tea::resilience::cache::get,
                    &state,
                    &key,
                    now_ms.value()
                );
                let present = observe!(
                    calls,
                    demlik_tea::resilience::cache::has,
                    &state,
                    &key,
                    now_ms.value()
                );
                let mut observation = json!({"state":cache_value(&state), "present":present, "found":value.is_some()});
                if let Some(value) = value {
                    observation["value"] = value.clone();
                }
                trace.push(observation);
                continue;
            }
        }
        trace.push(json!({"state":cache_value(&state)}));
    }
    Ok(json!({"trace":trace}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreOptions {
    capacity: Option<Number>,
    ttl_ms: Option<Number>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyWireEntry {
    value: Value,
    at_ms: Number,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyInitial {
    entries: std::collections::BTreeMap<String, IdempotencyWireEntry>,
    order: Vec<String>,
    capacity: Option<Number>,
    ttl_ms: Option<Number>,
}
impl IdempotencyInitial {
    fn state(self) -> demlik_tea::idempotency::IdempotencyStore<Value> {
        demlik_tea::idempotency::IdempotencyStore {
            entries: self
                .entries
                .into_iter()
                .map(|(key, entry)| {
                    (
                        key,
                        demlik_tea::idempotency::IdempotencyEntry {
                            value: entry.value,
                            at_ms: entry.at_ms.value(),
                        },
                    )
                })
                .collect(),
            order: self.order,
            capacity: self.capacity.map(Number::value),
            ttl_ms: self.ttl_ms.map(Number::value),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "event",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum IdempotencyStep {
    Remember {
        key: String,
        value: Value,
        now_ms: Number,
    },
    Evict {
        now_ms: Number,
    },
    Read {
        key: String,
        now_ms: Number,
    },
}
#[derive(Deserialize)]
struct IdempotencyInput {
    initial: Option<IdempotencyInitial>,
    options: Option<StoreOptions>,
    steps: Vec<IdempotencyStep>,
}
fn idempotency_value(state: &demlik_tea::idempotency::IdempotencyStore<Value>) -> Value {
    let entries: serde_json::Map<_, _> = state
        .entries
        .iter()
        .map(|(key, entry)| {
            (
                key.clone(),
                json!({"value":entry.value, "atMs":encode_number(entry.at_ms)}),
            )
        })
        .collect();
    let mut value = json!({"entries":entries,"order":state.order});
    if let Some(capacity) = state.capacity {
        value["capacity"] = encode_number(capacity);
    }
    if let Some(ttl_ms) = state.ttl_ms {
        value["ttlMs"] = encode_number(ttl_ms);
    }
    value
}
fn idempotency(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: IdempotencyInput =
        serde_json::from_value(input).map_err(|error| error.to_string())?;
    let options = input
        .options
        .map(|options| demlik_tea::idempotency::StoreOptions {
            capacity: options.capacity.map(Number::value),
            ttl_ms: options.ttl_ms.map(Number::value),
        })
        .unwrap_or_default();
    let mut state = input
        .initial
        .map(IdempotencyInitial::state)
        .unwrap_or_else(|| observe!(calls, demlik_tea::idempotency::init_store, options));
    let mut trace = vec![json!({"state":idempotency_value(&state)})];
    for step in input.steps {
        match step {
            IdempotencyStep::Remember { key, value, now_ms } => {
                state = observe!(
                    calls,
                    demlik_tea::idempotency::remember,
                    &state,
                    key,
                    value,
                    now_ms.value()
                )
            }
            IdempotencyStep::Evict { now_ms } => {
                state = observe!(
                    calls,
                    demlik_tea::idempotency::evict_expired,
                    &state,
                    now_ms.value()
                )
            }
            IdempotencyStep::Read { key, now_ms } => {
                let value = observe!(
                    calls,
                    demlik_tea::idempotency::recall,
                    &state,
                    &key,
                    now_ms.value()
                );
                let present = observe!(
                    calls,
                    demlik_tea::idempotency::seen,
                    &state,
                    &key,
                    now_ms.value()
                );
                let mut observation = json!({"state":idempotency_value(&state),"present":present,"found":value.is_some()});
                if let Some(value) = value {
                    observation["value"] = value.clone();
                }
                trace.push(observation);
                continue;
            }
        }
        trace.push(json!({"state":idempotency_value(&state)}));
    }
    Ok(json!({"trace":trace}))
}
