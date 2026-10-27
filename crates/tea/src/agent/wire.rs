use super::types::{AgentNumber, Awaiting, ToolOutcome};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::value::RawValue;
use std::rc::Rc;

// Read variant fields directly from their original JSON. Internally tagged
// buffering would erase the RawValue input used by lossless opaque values.
impl<'de> Deserialize<'de> for Awaiting {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            kind: String,
        }
        let kind: Kind = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        match kind.kind.as_str() {
            "llm" => Ok(Self::Llm),
            "tools" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Fields {
                    batch_turn: AgentNumber,
                }
                let fields: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::Tools {
                    batch_turn: fields.batch_turn,
                })
            }
            "compacting" => {
                #[derive(Deserialize)]
                struct Fields {
                    folding: AgentNumber,
                }
                let fields: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::Compacting {
                    folding: fields.folding,
                })
            }
            _ => Err(serde::de::Error::custom("unknown awaiting kind")),
        }
    }
}
impl<'de, R: DeserializeOwned, E: DeserializeOwned> Deserialize<'de> for ToolOutcome<R, E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            kind: String,
        }
        let kind: Kind = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        match kind.kind.as_str() {
            "ok" => {
                #[derive(Deserialize)]
                struct Presence {
                    #[serde(default)]
                    result: super::types::AgentField<Box<RawValue>>,
                }
                let presence: Presence =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                let value = match presence.result {
                    super::types::AgentField::Value(value) => {
                        serde_json::from_str(value.get()).map_err(serde::de::Error::custom)?
                    }
                    _ => crate::data::decode_missing("result")?,
                };
                Ok(Self::Ok(Rc::new(value)))
            }
            "error" => serde_json::from_str(raw.get())
                .map(Rc::new)
                .map(Self::Error)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom("unknown tool outcome kind")),
        }
    }
}

pub(crate) fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}
use super::turn_view::{CallOf, CallSource};
use super::types::{AgentFailure, AgentField, AgentLifecycleNote, AgentState, field, object};
use crate::{
    PlainData,
    data::{JsText, JsonData},
};
use serde::Serialize;
impl<E: Serialize> Serialize for AgentFailure<E> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut fields = match self {
            Self::TurnLimit { at } => vec![
                ("reason", PlainData::String("turn_limit".into())),
                ("at", field::<S, _>(at)?),
            ],
            Self::ElapsedLimit { at } => vec![
                ("reason", PlainData::String("elapsed_limit".into())),
                ("at", field::<S, _>(at)?),
            ],
            Self::Llm { error, at } => {
                let mut fields = vec![("reason", PlainData::String("llm".into()))];
                match error {
                    AgentField::Absent => {}
                    AgentField::Undefined => fields.push(("error", PlainData::Undefined)),
                    AgentField::Value(error) => fields.push(("error", field::<S, _>(error)?)),
                };
                fields.push(("at", field::<S, _>(at)?));
                fields
            }
        };
        JsonData(&object(fields.drain(..))).serialize(s)
    }
}
impl<'de, E: DeserializeOwned> Deserialize<'de> for AgentFailure<E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Reason {
            reason: String,
        }
        let kind: Reason = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        #[derive(Deserialize)]
        struct At {
            at: AgentNumber,
        }
        match kind.reason.as_str() {
            "turn_limit" | "elapsed_limit" => {
                let f: At = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(if kind.reason == "turn_limit" {
                    Self::TurnLimit { at: f.at }
                } else {
                    Self::ElapsedLimit { at: f.at }
                })
            }
            "llm" => {
                #[derive(Deserialize)]
                struct Fields {
                    #[serde(default)]
                    error: AgentField<Box<RawValue>>,
                    at: AgentNumber,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                let error = match f.error {
                    AgentField::Absent => AgentField::Absent,
                    AgentField::Undefined => AgentField::Undefined,
                    AgentField::Value(v) => AgentField::Value(Rc::new(
                        serde_json::from_str(v.get()).map_err(serde::de::Error::custom)?,
                    )),
                };
                Ok(Self::Llm { error, at: f.at })
            }
            _ => Err(serde::de::Error::custom("unknown agent failure reason")),
        }
    }
}
impl<A, E: Serialize, V: CallSource<A>> Serialize for AgentLifecycleNote<A, E, V>
where
    CallOf<A, V>: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let fields = match self {
            Self::BrainStarted {
                turn,
                purpose,
                model,
                at,
            } => object([
                ("kind", PlainData::String("brain_started".into())),
                ("turn", field::<S, _>(turn)?),
                ("purpose", PlainData::String(purpose.clone())),
                ("model", field::<S, _>(model)?),
                ("at", field::<S, _>(at)?),
            ]),
            Self::ToolStarted { call, at } => object([
                ("kind", PlainData::String("tool_started".into())),
                ("call", field::<S, _>(call)?),
                ("at", field::<S, _>(at)?),
            ]),
            Self::ToolFailed { call, failure, at } => object([
                ("kind", PlainData::String("tool_failed".into())),
                ("call", field::<S, _>(call)?),
                ("failure", field::<S, _>(failure)?),
                ("at", field::<S, _>(at)?),
            ]),
            Self::RunEnded { at } => object([
                ("kind", PlainData::String("run_ended".into())),
                ("at", field::<S, _>(at)?),
            ]),
        };
        JsonData(&fields).serialize(s)
    }
}
impl<'de, A, E: DeserializeOwned, V: CallSource<A>> Deserialize<'de> for AgentLifecycleNote<A, E, V>
where
    CallOf<A, V>: DeserializeOwned,
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            kind: String,
        }
        let kind: Kind = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        match kind.kind.as_str() {
            "brain_started" => {
                #[derive(Deserialize)]
                struct Fields {
                    turn: AgentNumber,
                    purpose: JsText,
                    model: Option<JsText>,
                    at: AgentNumber,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::BrainStarted {
                    turn: f.turn,
                    purpose: f.purpose,
                    model: f.model,
                    at: f.at,
                })
            }
            "tool_started" => {
                #[derive(Deserialize)]
                struct Fields {
                    call: Box<RawValue>,
                    at: AgentNumber,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::ToolStarted {
                    call: Rc::new(
                        serde_json::from_str(f.call.get()).map_err(serde::de::Error::custom)?,
                    ),
                    at: f.at,
                })
            }
            "tool_failed" => {
                #[derive(Deserialize)]
                struct Fields {
                    call: Box<RawValue>,
                    failure: Box<RawValue>,
                    at: AgentNumber,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::ToolFailed {
                    call: Rc::new(
                        serde_json::from_str(f.call.get()).map_err(serde::de::Error::custom)?,
                    ),
                    failure: Rc::new(
                        serde_json::from_str(f.failure.get()).map_err(serde::de::Error::custom)?,
                    ),
                    at: f.at,
                })
            }
            "run_ended" => {
                #[derive(Deserialize)]
                struct Fields {
                    at: AgentNumber,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                Ok(Self::RunEnded { at: f.at })
            }
            _ => Err(serde::de::Error::custom("unknown lifecycle note kind")),
        }
    }
}
impl<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE, V: CallSource<A>> Serialize
    for AgentState<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE, V>
where
    S: Serialize,
    P: Serialize,
    O: Serialize,
    R: Serialize,
    I: Serialize,
    LE: Serialize,
    TE: Serialize,
    SE: Serialize,
    CallOf<A, V>: Serialize,
    T: Serialize,
    CI: Serialize,
    CO: Serialize,
    CE: Serialize,
    FE: Serialize,
{
    fn serialize<X: serde::Serializer>(&self, s: X) -> Result<X::Ok, X::Error> {
        let mut fields = vec![
            ("run", field::<X, _>(&self.run)?),
            ("resilience", field::<X, _>(&self.resilience)?),
            ("tools", field::<X, _>(&self.tools)?),
            ("conversation", field::<X, _>(&self.conversation)?),
        ];
        fn add<X: serde::Serializer, V: Serialize>(
            fields: &mut Vec<(&'static str, PlainData)>,
            name: &'static str,
            value: &AgentField<V>,
        ) -> Result<(), X::Error> {
            match value {
                AgentField::Absent => {}
                AgentField::Undefined => fields.push((name, PlainData::Undefined)),
                AgentField::Value(v) => fields.push((name, field::<X, _>(v)?)),
            }
            Ok(())
        }
        add::<X, _>(&mut fields, "usage", &self.usage)?;
        add::<X, _>(&mut fields, "compaction", &self.compaction)?;
        add::<X, _>(&mut fields, "toolResilience", &self.tool_resilience)?;
        add::<X, _>(&mut fields, "refusedCalls", &self.refused_calls)?;
        add::<X, _>(&mut fields, "lifecycle", &self.lifecycle)?;
        add::<X, _>(&mut fields, "failure", &self.failure)?;
        add::<X, _>(&mut fields, "output", &self.output)?;
        add::<X, _>(&mut fields, "instructions", &self.instructions)?;
        JsonData(&object(fields)).serialize(s)
    }
}
