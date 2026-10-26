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
