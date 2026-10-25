use demlik_tea::flow::poller::{self, Poller, PollerConfig, PollerPhase, PollerState};
use demlik_tea::idempotency::{self, IdempotencyNumber, IdempotencyStore, StoreOptions};
use demlik_tea::retry_backoff::{
    BackoffCurve, CountBound, DurationBound, Jitter, RetryPolicy, Unbounded,
};
use demlik_tea::{
    PlainData, Step,
    data::{JsText, plain_data, stringify_json},
    work_queue::QueueField,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, number, snapshot, text};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Text {
    Utf8(String),
    Units {
        #[serde(rename = "$utf16")]
        units: Vec<u16>,
    },
}
impl From<Text> for JsText {
    fn from(input: Text) -> Self {
        match input {
            Text::Utf8(value) => value.into(),
            Text::Units { units } => Self::from_units(units),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Curve {
    base_ms: Number,
    factor: Number,
    cap_ms: Number,
    jitter: Jitter,
}
impl From<Curve> for BackoffCurve {
    fn from(curve: Curve) -> Self {
        Self {
            base_ms: curve.base_ms.value(),
            factor: curve.factor.value(),
            cap_ms: curve.cap_ms.value(),
            jitter: curve.jitter,
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Budget {
    Count {
        max_attempts: Number,
    },
    Duration {
        max_elapsed_ms: Number,
        max_attempts: Option<Number>,
    },
    Unbounded,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    curve: Curve,
    budget: Budget,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Start {
        at: Number,
    },
    Tick,
    Result {
        value: Value,
        at: Number,
        until_held: bool,
    },
    Error {
        error: Value,
        at: Number,
    },
    Reset,
    RoundTrip,
    Restore {
        encoded: String,
    },
    Seen {
        key: Text,
        at: Number,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum MemoryAction {
    Remember { key: Text, value: bool, at: Number },
    Seen { key: Text, at: Number },
    RoundTrip,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PollerInput {
    every_ms: Number,
    until_answer: bool,
    dedupe: bool,
    ttl_ms: Option<Number>,
    retry: Option<Policy>,
    rng: Vec<Number>,
    actions: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Script {
    Poller(PollerInput),
    Memory {
        capacity: Option<Number>,
        ttl_ms: Option<Number>,
        actions: Vec<MemoryAction>,
    },
}
#[derive(Default)]
struct Counts {
    until: Cell<usize>,
    tick: Cell<usize>,
    rng: Cell<usize>,
    key: Cell<usize>,
    key_inputs: RefCell<Vec<Value>>,
}
fn scalar(value: IdempotencyNumber) -> Value {
    value.number().map_or(Value::Null, number)
}
fn bound(value: Option<IdempotencyNumber>) -> Value {
    value.map_or(json!({"$undefined":true}), scalar)
}
fn data_slot<T: serde::Serialize>(value: &QueueField<Rc<T>>) -> Value {
    value.value().map_or(json!({"$undefined":true}), snapshot)
}
fn numeric_slot(value: &QueueField<IdempotencyNumber>) -> Value {
    value
        .value()
        .copied()
        .map_or(json!({"$undefined":true}), scalar)
}
fn memory_value(store: &IdempotencyStore<bool>) -> Value {
    json!({"entries":snapshot(&store.entries),"order":store.order.iter().map(text).collect::<Vec<_>>(),"capacity":bound(store.capacity),"ttlMs":bound(store.ttl_ms)})
}
fn encoded(value: &impl serde::Serialize) -> String {
    stringify_json(&plain_data(value).unwrap()).unwrap()
}
fn json_state(value: &impl serde::Serialize) -> Value {
    wire::normalized(&demlik_tea::data::decode_json(&encoded(value)).unwrap())
}
fn config(
    every_ms: f64,
    until_answer: bool,
    dedupe: bool,
    ttl_ms: Option<f64>,
    counts: &Rc<Counts>,
) -> PollerConfig<'static, (), PlainData, PlainData> {
    let until = Rc::clone(counts);
    let tick = Rc::clone(counts);
    let mut config = PollerConfig::new(
        every_ms,
        move |_: &()| {
            until.until.set(until.until.get() + 1);
            until_answer
        },
        move || {
            let count = tick.tick.get() + 1;
            tick.tick.set(count);
            Rc::new(PlainData::from(
                &json!({"type":"fetch_status","serial":count}),
            ))
        },
    );
    config.dedupe_ttl_ms = ttl_ms;
    if dedupe {
        let key = Rc::clone(counts);
        config.dedupe_key = Some(Rc::new(move |result: &PlainData| {
            key.key.set(key.key.get() + 1);
            key.key_inputs.borrow_mut().push(wire::normalized(result));
            match result {
                PlainData::String(value) => value.clone(),
                _ => "other".into(),
            }
        }));
    }
    config
}
fn run_poller(input: PollerInput, calls: &Calls) -> Value {
    let PollerInput {
        every_ms,
        until_answer,
        dedupe,
        ttl_ms,
        retry,
        rng,
        actions,
    } = input;
    let counts = Rc::new(Counts::default());
    let config = config(
        every_ms.value(),
        until_answer,
        dedupe,
        ttl_ms.map(Number::value),
        &counts,
    );
    let samples = rng.into_iter().map(Number::value).collect::<Vec<_>>();
    assert!(!samples.is_empty());
    let draws = Rc::clone(&counts);
    let rng = move || {
        let index = draws.rng.get();
        draws.rng.set(index + 1);
        samples[index.min(samples.len() - 1)]
    };
    let poller: Rc<dyn Poller<PlainData, PlainData>> = match retry {
        None => Rc::new(observe!(calls, poller::create_poller, config).with_rng(rng)),
        Some(Policy {
            curve,
            budget: Budget::Count { max_attempts },
        }) => Rc::new(
            observe!(
                calls,
                poller::create_poller,
                config.with_retry(RetryPolicy {
                    curve: curve.into(),
                    budget: CountBound {
                        max_attempts: max_attempts.value()
                    }
                })
            )
            .with_rng(rng),
        ),
        Some(Policy {
            curve,
            budget:
                Budget::Duration {
                    max_elapsed_ms,
                    max_attempts,
                },
        }) => Rc::new(
            observe!(
                calls,
                poller::create_poller,
                config.with_retry(RetryPolicy {
                    curve: curve.into(),
                    budget: DurationBound {
                        max_elapsed_ms: max_elapsed_ms.value(),
                        max_attempts: max_attempts.map(Number::value)
                    }
                })
            )
            .with_rng(rng),
        ),
        Some(Policy {
            curve,
            budget: Budget::Unbounded,
        }) => Rc::new(
            observe!(
                calls,
                poller::create_poller,
                config.with_retry(RetryPolicy {
                    curve: curve.into(),
                    budget: Unbounded
                })
            )
            .with_rng(rng),
        ),
    };
    let mut state = observe!(calls, Poller::init, poller.as_ref());
    let row = |state: &Rc<PollerState<PlainData>>,
               commands: &[Rc<PlainData>],
               same: Option<bool>,
               unchanged: bool,
               query: Value,
               error: Value| {
        let target = match state.phase {
            PollerPhase::Polling { next_at_ms } => scalar(next_at_ms),
            _ => json!({"$undefined":true}),
        };
        let subs = observe!(calls, Poller::subs, poller.as_ref(), state.as_ref());
        json!({"wireState":json_state(state),"serialized":encoded(state),"phase":state.phase.as_str(),"tick":scalar(state.tick),"target":target,"lastResult":data_slot(&state.last_result),"lastResultPresent":!state.last_result.is_absent(),"retry":{"attempt":scalar(state.retry.attempt),"lastError":data_slot(&state.retry.last_error),"lastErrorPresent":!state.retry.last_error.is_absent(),"firstFailureAtMs":numeric_slot(&state.retry.first_failure_at_ms),"originPresent":!state.retry.first_failure_at_ms.is_absent()},"dedupe":memory_value(&state.dedupe),"commands":snapshot(&commands),"subs":snapshot(&subs),"sameState":same,"priorUnchanged":unchanged,"untilCalls":counts.until.get(),"onTickCalls":counts.tick.get(),"rngCalls":counts.rng.get(),"keyCalls":counts.key.get(),"keyInputs":*counts.key_inputs.borrow(),"query":query,"error":error})
    };
    let mut rows = vec![row(&state, &[], None, true, Value::Null, Value::Null)];
    for action in actions {
        let previous = Rc::clone(&state);
        let before = encoded(&previous);
        let mut query = Value::Null;
        let mut error = Value::Null;
        let result = match action {
            Action::Start { at } => Ok(observe!(
                calls,
                Poller::start,
                poller.as_ref(),
                &state,
                at.value()
            )),
            Action::Tick => Ok(observe!(calls, Poller::tick, poller.as_ref(), &state)),
            Action::Result {
                value,
                at,
                until_held,
            } => observe!(
                calls,
                Poller::tick_result,
                poller.as_ref(),
                &state,
                Rc::new(data(&value)),
                at.value(),
                until_held
            ),
            Action::Error { error, at } => Ok(observe!(
                calls,
                Poller::tick_err,
                poller.as_ref(),
                &state,
                Rc::new(data(&error)),
                at.value()
            )),
            Action::Reset => Ok(Step::new(
                observe!(calls, Poller::init, poller.as_ref()),
                vec![],
            )),
            Action::RoundTrip => Ok(Step::new(
                Rc::new(serde_json::from_str(&encoded(&state)).unwrap()),
                vec![],
            )),
            Action::Restore { encoded } => Ok(Step::new(
                Rc::new(serde_json::from_str(&encoded).unwrap()),
                vec![],
            )),
            Action::Seen { key, at } => {
                query = json!(
                    observe!(
                        calls,
                        idempotency::seen,
                        &state.dedupe,
                        JsText::from(key),
                        at.value()
                    )
                    .unwrap()
                );
                Ok(Step::new(Rc::clone(&state), vec![]))
            }
        };
        let commands = match result {
            Ok(step) => {
                state = step.state;
                step.commands
            }
            Err(cause) => {
                error = serde_json::to_value(cause).unwrap();
                vec![]
            }
        };
        rows.push(row(
            &state,
            &commands,
            Some(Rc::ptr_eq(&state, &previous)),
            before == encoded(&previous),
            query,
            error,
        ));
    }
    json!(rows)
}
fn run_memory(
    capacity: Option<f64>,
    ttl_ms: Option<f64>,
    actions: Vec<MemoryAction>,
    calls: &Calls,
) -> Value {
    let mut store = observe!(
        calls,
        idempotency::init_store,
        StoreOptions { capacity, ttl_ms }
    );
    let row = |store: &IdempotencyStore<bool>, result: Value| json!({"wireState":json_state(store),"serialized":encoded(store),"values":memory_value(store),"result":result});
    let mut rows = vec![row(&store, Value::Null)];
    for action in actions {
        let mut result = Value::Null;
        match action {
            MemoryAction::Remember { key, value, at } => {
                store = observe!(
                    calls,
                    idempotency::remember,
                    &store,
                    JsText::from(key),
                    value,
                    at.value()
                )
                .unwrap()
            }
            MemoryAction::Seen { key, at } => {
                result = json!(
                    observe!(
                        calls,
                        idempotency::seen,
                        &store,
                        JsText::from(key),
                        at.value()
                    )
                    .unwrap()
                )
            }
            MemoryAction::RoundTrip => store = serde_json::from_str(&encoded(&store)).unwrap(),
        };
        rows.push(row(&store, result));
    }
    json!(rows)
}
fn execute(script: Script) -> Value {
    let calls = Calls::default();
    let comparison = match script {
        Script::Poller(input) => run_poller(input, &calls),
        Script::Memory {
            capacity,
            ttl_ms,
            actions,
        } => run_memory(
            capacity.map(Number::value),
            ttl_ms.map(Number::value),
            actions,
            &calls,
        ),
    };
    json!({"comparison":comparison,"observedRustCalls":*calls.borrow()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        println!(
            "{}",
            execute(serde_json::from_str(&line).expect("validated poller script"))
        );
    }
}
