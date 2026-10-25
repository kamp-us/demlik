use super::super::{cache::TtlCache, circuit_breaker::CircuitState, rate_limit::TokenBucket};
use super::model::*;
use crate::{command::MalformedResult, data::JsText, js_record::JsRecord};
use serde::{
    Deserialize,
    de::{DeserializeOwned, Error},
};
use serde_json::value::RawValue;
use std::rc::Rc;

impl<'de, T: Deserialize<'de>> Deserialize<'de> for CallValue<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Value<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Value<T> {
            type Value = CallValue<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a typed value or an omitted field")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(CallValue::Missing)
            }
            fn visit_newtype_struct<D: serde::Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<Self::Value, D::Error> {
                T::deserialize(deserializer).map(CallValue::value)
            }
        }
        deserializer.deserialize_newtype_struct(
            crate::data::UNDEFINED_TOKEN,
            Value(std::marker::PhantomData),
        )
    }
}
impl<'de, I: Deserialize<'de>> Deserialize<'de> for RunInput<I> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "I:Deserialize<'de>"))]
        struct Fields<I> {
            key: JsText,
            #[serde(default)]
            input: CallValue<I>,
        }
        let fields = Fields::deserialize(deserializer)?;
        Ok(Self {
            key: fields.key,
            input: fields.input,
        })
    }
}
impl<'de, E: DeserializeOwned> Deserialize<'de> for RunError<E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Header {
            _tag: String,
        }
        let header: Header = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        let kind = match header._tag.as_str() {
            "port_rejected" => RunErrorKind::PortRejected,
            "deadline_exceeded" => RunErrorKind::DeadlineExceeded,
            _ => return Err(D::Error::custom("undeclared run failure tag")),
        };
        let details = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        Ok(Self { kind, details })
    }
}
impl<'de, E: DeserializeOwned> Deserialize<'de> for CallFailure<E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        if matches!(
            serde_json::from_str::<String>(raw.get()).as_deref(),
            Ok("rate_limited")
        ) {
            return Ok(Self::RateLimited);
        }
        #[derive(Deserialize)]
        struct Header {
            #[serde(rename = "_tag")]
            _tag: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct MalformedIssue {
            path: String,
            message: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Malformed {
            #[serde(rename = "_tag")]
            _tag: String,
            issues: Vec<MalformedIssue>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Expired {
            #[serde(rename = "_tag")]
            _tag: String,
            id: JsText,
            at_ms: CallNumber,
        }
        if let Ok(header) = serde_json::from_str::<Header>(raw.get()) {
            match header._tag.as_str() {
                "malformed_result" => {
                    if let Ok(error) = serde_json::from_str::<Malformed>(raw.get()) {
                        return Ok(Self::Malformed(MalformedResult {
                            issues: error
                                .issues
                                .into_iter()
                                .map(|issue| crate::command::Issue::new(issue.path, issue.message))
                                .collect(),
                        }));
                    }
                }
                "deadline_exceeded" => {
                    if let Ok(error) = serde_json::from_str::<Expired>(raw.get()) {
                        return Ok(Self::DeadlineExceeded {
                            id: error.id,
                            at_ms: error.at_ms,
                        });
                    }
                    return serde_json::from_str(raw.get())
                        .map(|error| Self::Run(Rc::new(error)))
                        .map_err(D::Error::custom);
                }
                "port_rejected" => {
                    return serde_json::from_str(raw.get())
                        .map(|error| Self::Run(Rc::new(error)))
                        .map_err(D::Error::custom);
                }
                _ => {}
            }
        }
        serde_json::from_str(raw.get())
            .map(|error| Self::External(Rc::new(error)))
            .map_err(D::Error::custom)
    }
}
impl<'de, I: DeserializeOwned, R: DeserializeOwned, E: DeserializeOwned> Deserialize<'de>
    for CallPhase<I, R, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Header {
            phase: String,
        }
        let header: Header = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "I:DeserializeOwned"))]
        struct Running<I> {
            #[serde(default)]
            input: CallValue<I>,
            budget: CallBudget,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", bound(deserialize = "I:DeserializeOwned"))]
        struct Waiting<I> {
            #[serde(default)]
            input: CallValue<I>,
            retry_at_ms: CallNumber,
            budget: CallBudget,
        }
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "R:DeserializeOwned"))]
        struct Succeeded<R> {
            #[serde(default)]
            result: CallValue<R>,
        }
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "E:DeserializeOwned"))]
        struct Failed<E> {
            #[serde(default = "missing_error")]
            error: Rc<CallFailure<E>>,
        }
        Ok(match header.phase.as_str() {
            "idle" => Self::Idle,
            "circuit_open" => Self::CircuitOpen,
            "running" => {
                let fields: Running<I> =
                    serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                Self::Running {
                    input: fields.input,
                    budget: fields.budget,
                }
            }
            "waiting_retry" => {
                let fields: Waiting<I> =
                    serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                Self::WaitingRetry {
                    input: fields.input,
                    retry_at_ms: fields.retry_at_ms,
                    budget: fields.budget,
                }
            }
            "succeeded" => {
                let fields: Succeeded<R> =
                    serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                Self::Succeeded {
                    result: fields.result,
                }
            }
            "failed" => {
                let fields: Failed<E> =
                    serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                Self::Failed {
                    error: fields.error,
                }
            }
            _ => {
                return Err(D::Error::custom(format!(
                    "unknown call phase {}",
                    header.phase
                )));
            }
        })
    }
}
fn missing_error<E>() -> Rc<CallFailure<E>> {
    Rc::new(CallFailure::Missing)
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
impl<'de, E: DeserializeOwned> Deserialize<'de> for RetryProgress<E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", bound(deserialize = "E:DeserializeOwned"))]
        struct Fields<E> {
            attempt: CallNumber,
            #[serde(default, deserialize_with = "present")]
            last_error: Option<Rc<CallFailure<E>>>,
            #[serde(default, deserialize_with = "present")]
            first_failure_at_ms: Option<CallNumber>,
        }
        let fields = Fields::deserialize(deserializer)?;
        Ok(Self {
            attempt: fields.attempt,
            last_error: fields.last_error,
            first_failure_at_ms: fields.first_failure_at_ms,
        })
    }
}
impl<'de, I: DeserializeOwned, R: DeserializeOwned, E: DeserializeOwned> Deserialize<'de>
    for Snapshot<I, R, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            rename_all = "camelCase",
            bound(deserialize = "I:DeserializeOwned,R:DeserializeOwned,E:DeserializeOwned")
        )]
        struct Fields<I, R, E> {
            circuit: CircuitState,
            bucket: TokenBucket,
            retry: Rc<JsRecord<RetryProgress<E>>>,
            cache: Rc<TtlCache<CallValue<R>>>,
            calls: Rc<Calls<I, R, E>>,
            clock_ms: CallNumber,
        }
        let fields = Fields::deserialize(deserializer)?;
        Ok(Self {
            circuit: fields.circuit,
            bucket: fields.bucket,
            retry: fields.retry,
            cache: fields.cache,
            calls: fields.calls,
            clock_ms: fields.clock_ms,
        })
    }
}
impl<'de, I: DeserializeOwned, R: DeserializeOwned, E: DeserializeOwned> Deserialize<'de>
    for State<I, R, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Snapshot::deserialize(deserializer).map(Self::from_snapshot)
    }
}
