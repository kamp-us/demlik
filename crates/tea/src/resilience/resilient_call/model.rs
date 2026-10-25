use super::super::{
    cache::TtlCache,
    circuit_breaker::{CircuitPolicy, CircuitState},
    rate_limit::TokenBucket,
};
use crate::{
    PlainData, Step, Tagged,
    command::{Cmd, CmdDef, CommandRecord, CommandSpec, Issue, MalformedResult, SchemaError},
    data::{JsText, JsonData, plain_data},
    js_record::{JsRecord, RecordEntry, RecordValue},
    retry_backoff::{CountBound, RetryPolicy, RetryState},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{marker::PhantomData, rc::Rc};

pub const DEFAULT_RESILIENT_NAME: &str = "resilient";
pub use crate::work_queue::QueueTime as CallNumber;

/// A generic domain value can be shared without Clone or serde. Missing is a
/// restored absent field; Undefined is a present source value without JSON text.
#[derive(Default)]
pub enum CallValue<T> {
    Shared(Rc<T>),
    Undefined,
    #[default]
    Missing,
}
impl<T> Clone for CallValue<T> {
    fn clone(&self) -> Self {
        match self {
            Self::Shared(value) => Self::Shared(value.clone()),
            Self::Undefined => Self::Undefined,
            Self::Missing => Self::Missing,
        }
    }
}
impl<T> CallValue<T> {
    pub fn value(value: T) -> Self {
        Self::Shared(Rc::new(value))
    }
    pub fn shared(value: Rc<T>) -> Self {
        Self::Shared(value)
    }
    pub fn is_undefined(&self) -> bool {
        !matches!(self, Self::Shared(_))
    }
    pub(super) fn present(self) -> Self {
        match self {
            Self::Missing => Self::Undefined,
            value => value,
        }
    }
}
impl<T: Serialize> Serialize for CallValue<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Shared(value) => value.serialize(serializer),
            _ => PlainData::Undefined.serialize(serializer),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitConfig {
    pub threshold: f64,
    pub cooldown_ms: f64,
    #[serde(default = "one")]
    pub half_open_max_probes: f64,
}
fn one() -> f64 {
    1.0
}
impl From<CircuitConfig> for CircuitPolicy {
    fn from(value: CircuitConfig) -> Self {
        Self {
            failure_threshold: value.threshold,
            cooldown_ms: value.cooldown_ms,
            half_open_max_probes: value.half_open_max_probes,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitConfig {
    pub capacity: f64,
    pub refill_per_sec: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheConfig {
    pub ttl_ms: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct DeadlineConfig {
    pub ms: f64,
}
pub struct Config<B = CountBound> {
    pub name: String,
    pub retry: Option<RetryPolicy<B>>,
    pub circuit: Option<CircuitConfig>,
    pub rate_limit: Option<RateLimitConfig>,
    pub cache: Option<CacheConfig>,
    pub deadline: Option<DeadlineConfig>,
}
impl<B> Default for Config<B> {
    fn default() -> Self {
        Self {
            name: DEFAULT_RESILIENT_NAME.into(),
            retry: None,
            circuit: None,
            rate_limit: None,
            cache: None,
            deadline: None,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallBudget {
    pub remaining_ms: CallNumber,
    pub charging_since_ms: CallNumber,
}
#[derive(Serialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CallPhase<I, R, E> {
    Idle,
    Running {
        #[serde(skip_serializing_if = "CallValue::is_undefined")]
        input: CallValue<I>,
        budget: CallBudget,
    },
    WaitingRetry {
        #[serde(skip_serializing_if = "CallValue::is_undefined")]
        input: CallValue<I>,
        retry_at_ms: CallNumber,
        budget: CallBudget,
    },
    CircuitOpen,
    Succeeded {
        #[serde(skip_serializing_if = "CallValue::is_undefined")]
        result: CallValue<R>,
    },
    Failed {
        #[serde(skip_serializing_if = "undefined_error")]
        error: Rc<CallFailure<E>>,
    },
}
impl<I, R, E> Clone for CallPhase<I, R, E> {
    fn clone(&self) -> Self {
        match self {
            Self::Idle => Self::Idle,
            Self::CircuitOpen => Self::CircuitOpen,
            Self::Running { input, budget } => Self::Running {
                input: input.clone(),
                budget: *budget,
            },
            Self::WaitingRetry {
                input,
                retry_at_ms,
                budget,
            } => Self::WaitingRetry {
                input: input.clone(),
                retry_at_ms: *retry_at_ms,
                budget: *budget,
            },
            Self::Succeeded { result } => Self::Succeeded {
                result: result.clone(),
            },
            Self::Failed { error } => Self::Failed {
                error: error.clone(),
            },
        }
    }
}
#[derive(Clone, Copy)]
pub enum RunErrorKind {
    PortRejected,
    DeadlineExceeded,
}
impl RunErrorKind {
    pub fn tag(self) -> &'static str {
        match self {
            Self::PortRejected => "port_rejected",
            Self::DeadlineExceeded => "deadline_exceeded",
        }
    }
}
pub struct RunError<E> {
    pub kind: RunErrorKind,
    pub details: E,
}
impl<E> RunError<E> {
    pub fn port_rejected(details: E) -> Self {
        Self {
            kind: RunErrorKind::PortRejected,
            details,
        }
    }
    pub fn deadline_exceeded(details: E) -> Self {
        Self {
            kind: RunErrorKind::DeadlineExceeded,
            details,
        }
    }
}
impl<E> Tagged for RunError<E> {
    fn tag(&self) -> &str {
        self.kind.tag()
    }
}
impl<E: Serialize> Serialize for RunError<E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let PlainData::Object(mut fields) =
            plain_data(&self.details).map_err(serde::ser::Error::custom)?
        else {
            return Err(serde::ser::Error::custom(
                "declared run failure details must be a record",
            ));
        };
        fields.insert("_tag".into(), PlainData::String(self.kind.tag().into()));
        JsonData(&PlainData::Object(fields)).serialize(serializer)
    }
}
pub enum CallFailure<E> {
    External(Rc<E>),
    Run(Rc<RunError<E>>),
    Malformed(MalformedResult),
    RateLimited,
    DeadlineExceeded { id: JsText, at_ms: CallNumber },
    Undefined,
    Missing,
}
impl<E> CallFailure<E> {
    pub fn external(error: E) -> Self {
        Self::External(Rc::new(error))
    }
}
fn undefined_error<E>(error: &Rc<CallFailure<E>>) -> bool {
    matches!(
        error.as_ref(),
        CallFailure::Undefined | CallFailure::Missing
    )
}
impl<E: Serialize> Serialize for CallFailure<E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::External(error) => error.serialize(serializer),
            Self::Run(error) => error.serialize(serializer),
            Self::Malformed(error) => error.serialize(serializer),
            Self::RateLimited => serializer.serialize_str("rate_limited"),
            Self::Undefined | Self::Missing => PlainData::Undefined.serialize(serializer),
            Self::DeadlineExceeded { id, at_ms } => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Error<'a> {
                    #[serde(rename = "_tag")]
                    _tag: &'static str,
                    id: &'a JsText,
                    at_ms: CallNumber,
                }
                Error {
                    _tag: "deadline_exceeded",
                    id,
                    at_ms: *at_ms,
                }
                .serialize(serializer)
            }
        }
    }
}
#[derive(Serialize)]
pub struct RunInput<I> {
    pub key: JsText,
    pub input: CallValue<I>,
}
impl<I> CommandRecord for RunInput<I> {}
type RunTypes<I, R, E> = fn() -> (I, R, E);
pub struct RunSpec<I, R, E>(PhantomData<RunTypes<I, R, E>>);
impl<I, R, E> CommandSpec for RunSpec<I, R, E> {
    type Input = RunInput<I>;
    type RawOutput = CallValue<R>;
    type Output = CallValue<R>;
    type Error = RunError<E>;
    const NAME: &'static str = "resilient_run";
    const ERROR_TAGS: &'static [&'static str] = &["port_rejected", "deadline_exceeded"];
    fn parse_input(_: Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "decode the generic run input at its typed boundary, then use from_record",
        )]))
    }
    fn parse_output(value: Self::RawOutput) -> Result<Self::Output, SchemaError> {
        Ok(value)
    }
    fn missing_output() -> Option<Self::Output> {
        Some(CallValue::Missing)
    }
}
pub type RunCommand<I, R, E> = Cmd<RunSpec<I, R, E>>;
pub type CallStep<I, R, E, H = E> = Step<State<I, R, E>, RunCommand<I, R, H>>;
pub fn run_cmd_def<I, R, E>(name: &str) -> CmdDef<RunSpec<I, R, E>> {
    CmdDef::named(format!("{name}_run"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryProgress<E> {
    pub attempt: CallNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<Rc<CallFailure<E>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_failure_at_ms: Option<CallNumber>,
}
impl<E> Clone for RetryProgress<E> {
    fn clone(&self) -> Self {
        Self {
            attempt: self.attempt,
            last_error: self.last_error.clone(),
            first_failure_at_ms: self.first_failure_at_ms,
        }
    }
}
impl<E> RecordEntry for RetryProgress<E> {
    type Value = Option<Rc<CallFailure<E>>>;
    const TIMESTAMP_KEY: &'static str = "firstFailureAtMs";
    fn payload(&self) -> &Self::Value {
        &self.last_error
    }
    fn timestamp(&self) -> f64 {
        self.first_failure_at_ms
            .and_then(CallNumber::number)
            .unwrap_or(f64::NAN)
    }
}
impl<E> RetryProgress<E> {
    pub(super) fn as_state(&self) -> RetryState<Rc<CallFailure<E>>> {
        RetryState {
            attempt: self.attempt.number().unwrap_or(0.0),
            last_error: self.last_error.clone(),
        }
    }
}
pub type Retries<E> = JsRecord<RetryProgress<E>>;
pub type Calls<I, R, E> = JsRecord<Rc<CallPhase<I, R, E>>>;
pub struct Snapshot<I, R, E> {
    pub circuit: CircuitState,
    pub bucket: TokenBucket,
    pub retry: Rc<Retries<E>>,
    pub cache: Rc<TtlCache<CallValue<R>>>,
    pub calls: Rc<Calls<I, R, E>>,
    pub clock_ms: CallNumber,
}
impl<I, R, E> Clone for Snapshot<I, R, E> {
    fn clone(&self) -> Self {
        Self {
            circuit: self.circuit,
            bucket: self.bucket,
            retry: self.retry.clone(),
            cache: self.cache.clone(),
            calls: self.calls.clone(),
            clock_ms: self.clock_ms,
        }
    }
}
impl<I: Serialize, R: Serialize, E: Serialize> Serialize for Snapshot<I, R, E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct View<'a, I, R, E> {
            circuit: &'a CircuitState,
            bucket: &'a TokenBucket,
            retry: &'a Retries<E>,
            cache: &'a TtlCache<CallValue<R>>,
            calls: &'a Calls<I, R, E>,
            clock_ms: CallNumber,
        }
        let view = View {
            circuit: &self.circuit,
            bucket: &self.bucket,
            retry: &self.retry,
            cache: &self.cache,
            calls: &self.calls,
            clock_ms: self.clock_ms,
        };
        JsonData(&plain_data(&view).map_err(serde::ser::Error::custom)?).serialize(serializer)
    }
}
pub struct State<I, R, E>(pub(super) Rc<Snapshot<I, R, E>>);
impl<I, R, E> Clone for State<I, R, E> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<I, R, E> State<I, R, E> {
    pub fn from_snapshot(snapshot: Snapshot<I, R, E>) -> Self {
        Self(Rc::new(snapshot))
    }
    pub fn snapshot(&self) -> &Snapshot<I, R, E> {
        &self.0
    }
    pub fn same(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    pub fn call(&self, key: impl Into<JsText>) -> Option<&CallPhase<I, R, E>> {
        match self.0.calls.own_value(&key.into()) {
            Some(RecordValue::Entry(value)) => Some(value.as_ref()),
            _ => None,
        }
    }
}
impl<I: Serialize, R: Serialize, E: Serialize> Serialize for State<I, R, E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

pub enum SettleInput<R, E> {
    Ok {
        key: JsText,
        value: CallValue<R>,
        at: CallNumber,
    },
    Err {
        key: JsText,
        error: Rc<CallFailure<E>>,
        at: CallNumber,
    },
}
impl<R, E> SettleInput<R, E> {
    pub fn ok(key: impl Into<JsText>, value: CallValue<R>, at: impl Into<CallNumber>) -> Self {
        Self::Ok {
            key: key.into(),
            value,
            at: at.into(),
        }
    }
    pub fn err(key: impl Into<JsText>, error: CallFailure<E>, at: impl Into<CallNumber>) -> Self {
        Self::Err {
            key: key.into(),
            error: Rc::new(error),
            at: at.into(),
        }
    }
}
pub enum SettleOutcome<R, E> {
    Done { value: CallValue<R> },
    Failed { error: Rc<CallFailure<E>> },
    Retrying,
}
impl<R: Serialize, E: Serialize> Serialize for SettleOutcome<R, E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = indexmap::IndexMap::new();
        match self {
            Self::Done { value } => {
                fields.insert("kind".into(), PlainData::String("done".into()));
                fields.insert(
                    "value".into(),
                    plain_data(value).map_err(serde::ser::Error::custom)?,
                );
            }
            Self::Failed { error } => {
                fields.insert("kind".into(), PlainData::String("failed".into()));
                fields.insert(
                    "error".into(),
                    plain_data(error).map_err(serde::ser::Error::custom)?,
                );
            }
            Self::Retrying => {
                fields.insert("kind".into(), PlainData::String("retrying".into()));
            }
        }
        JsonData(&PlainData::Object(fields)).serialize(serializer)
    }
}
pub struct SettleResult<I, R, E, H = E> {
    pub call: State<I, R, E>,
    pub commands: Vec<RunCommand<I, R, H>>,
    pub outcome: SettleOutcome<R, E>,
}
impl<I: Serialize, R: Serialize, E: Serialize, H> Serialize for SettleResult<I, R, E, H> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(bound(serialize = "I: Serialize, R: Serialize, E: Serialize"))]
        struct View<'a, I, R, E, H> {
            call: &'a State<I, R, E>,
            cmds: &'a [RunCommand<I, R, H>],
            outcome: &'a SettleOutcome<R, E>,
        }
        JsonData(
            &plain_data(&View {
                call: &self.call,
                cmds: &self.commands,
                outcome: &self.outcome,
            })
            .map_err(serde::ser::Error::custom)?,
        )
        .serialize(serializer)
    }
}
