use super::*;
use crate::{
    PlainData,
    data::{JsonData, decode_missing, plain_data},
};
use serde::{Deserialize, Serialize, Serializer, de::DeserializeOwned};
use serde_json::value::RawValue;
type Record = indexmap::IndexMap<crate::data::JsText, PlainData>;
fn header<X: serde::ser::Error>(kind: &str, id: DeliveryId) -> Result<Record, X> {
    Ok([
        ("type".into(), PlainData::String(kind.into())),
        ("id".into(), plain_data(&id).map_err(X::custom)?),
    ]
    .into_iter()
    .collect())
}
impl<E: Serialize> Serialize for EffectOwed<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = header::<S::Error>("effect_owed", self.id)?;
        if self.effect_present {
            record.insert(
                "effect".into(),
                plain_data(&self.effect).map_err(serde::ser::Error::custom)?,
            );
        }
        JsonData(&PlainData::Object(record)).serialize(serializer)
    }
}
impl Serialize for EffectConfirmed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&PlainData::Object(header::<S::Error>(
            "effect_confirmed",
            self.id,
        )?))
        .serialize(serializer)
    }
}
impl<E: Serialize> Serialize for EffectLedgerEvent<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Owed(owed) => owed.serialize(serializer),
            Self::Confirmed(confirmed) => confirmed.serialize(serializer),
        }
    }
}
impl<E: Serialize> Serialize for OwedEffect<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let record = [
            (
                "id".into(),
                plain_data(&self.id).map_err(serde::ser::Error::custom)?,
            ),
            (
                "effect".into(),
                plain_data(&self.effect).map_err(serde::ser::Error::custom)?,
            ),
        ]
        .into_iter()
        .collect();
        JsonData(&PlainData::Object(record)).serialize(serializer)
    }
}
impl<'de, E: DeserializeOwned> Deserialize<'de> for EffectLedgerEvent<E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(rename = "type")]
            kind: String,
            id: DeliveryId,
            #[serde(default)]
            effect: QueueField<Box<RawValue>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        match raw.kind.as_str() {
            "effect_owed" => {
                let present = !raw.effect.is_absent();
                let effect = match raw.effect {
                    QueueField::Value(raw) => {
                        serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?
                    }
                    QueueField::Absent | QueueField::Undefined => decode_missing("effect")?,
                };
                Ok(Self::Owed(EffectOwed {
                    fields: EffectOwedFields {
                        id: raw.id,
                        effect: Rc::new(effect),
                    },
                    effect_present: present,
                }))
            }
            "effect_confirmed" => Ok(Self::Confirmed(EffectConfirmed { id: raw.id })),
            other => Err(serde::de::Error::unknown_variant(
                other,
                &["effect_owed", "effect_confirmed"],
            )),
        }
    }
}
