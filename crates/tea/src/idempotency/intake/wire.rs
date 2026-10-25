use super::*;
use crate::data::{JsonData, plain_data};
use serde::{Deserializer, Serializer};
fn absent<T>() -> QueueField<T> {
    QueueField::Absent
}
fn value<R: Serialize>(
    value: &IntakeValue<R>,
) -> Result<Option<PlainData>, crate::data::DependencyError> {
    match value {
        QueueField::Absent => Ok(None),
        QueueField::Undefined => Ok(Some(PlainData::Undefined)),
        QueueField::Value(value) => plain_data(value).map(Some),
    }
}
impl<R: Serialize> Serialize for Entry<R> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            "phase".into(),
            PlainData::String(
                match self {
                    Self::Pending => "pending",
                    Self::Done { .. } => "done",
                }
                .into(),
            ),
        );
        if let Self::Done { result } = self
            && let Some(value) = value(result).map_err(serde::ser::Error::custom)?
        {
            fields.insert("result".into(), value);
        }
        JsonData(&PlainData::Object(fields)).serialize(s)
    }
}
impl<'de, R: Deserialize<'de>> Deserialize<'de> for Entry<R> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Fields<R>(PhantomData<R>);
        impl<'de, R: Deserialize<'de>> serde::de::Visitor<'de> for Fields<R> {
            type Value = Entry<R>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an intake phase record")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> Result<Self::Value, M::Error> {
                let mut phase = None;
                let mut result = IntakeValue::Absent;
                while let Some(key) = fields.next_key::<JsText>()? {
                    match key.as_utf8() {
                        Some("phase") => phase = Some(fields.next_value::<JsText>()?),
                        Some("result") => result = fields.next_value()?,
                        _ => {
                            fields.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                match phase.as_ref().and_then(JsText::as_utf8) {
                    Some("pending") => Ok(Entry::Pending),
                    Some("done") => Ok(Entry::Done { result }),
                    _ => Err(serde::de::Error::custom(
                        "expected intake pending or done phase",
                    )),
                }
            }
        }
        d.deserialize_map(Fields(PhantomData))
    }
}
impl<P: Serialize> Serialize for ProcessInput<P> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        JsonData(&PlainData::Object(
            [
                ("key".into(), PlainData::String(self.key.clone())),
                ("itemId".into(), PlainData::String(self.item_id.clone())),
                (
                    "payload".into(),
                    plain_data(&self.payload).map_err(serde::ser::Error::custom)?,
                ),
            ]
            .into_iter()
            .collect(),
        ))
        .serialize(s)
    }
}
impl<R: Serialize> Serialize for ReplayInput<R> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut fields = indexmap::IndexMap::new();
        fields.insert("key".into(), PlainData::String(self.key.clone()));
        if let Some(value) = value(&self.result).map_err(serde::ser::Error::custom)? {
            fields.insert("result".into(), value);
        }
        JsonData(&PlainData::Object(fields)).serialize(s)
    }
}
impl<'de, R: Deserialize<'de>> Deserialize<'de> for ReplayInput<R> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "R:Deserialize<'de>"))]
        struct Raw<R> {
            key: JsText,
            #[serde(default = "absent")]
            result: IntakeValue<R>,
        }
        let raw = Raw::deserialize(d)?;
        Ok(Self {
            key: raw.key,
            result: raw.result,
        })
    }
}
impl<'de, P: Deserialize<'de>> Deserialize<'de> for ProcessInput<P> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Fields<P>(PhantomData<P>);
        impl<'de, P: Deserialize<'de>> serde::de::Visitor<'de> for Fields<P> {
            type Value = ProcessInput<P>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an intake process record")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> Result<Self::Value, M::Error> {
                let (mut key, mut item_id, mut payload) = (None, None, None);
                while let Some(field) = fields.next_key::<JsText>()? {
                    match field.as_utf8() {
                        Some("key") => key = Some(fields.next_value()?),
                        Some("itemId") => item_id = Some(fields.next_value()?),
                        Some("payload") => payload = Some(fields.next_value()?),
                        _ => {
                            fields.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(ProcessInput {
                    key: key.ok_or_else(|| serde::de::Error::missing_field("key"))?,
                    item_id: item_id.ok_or_else(|| serde::de::Error::missing_field("itemId"))?,
                    payload: match payload {
                        Some(value) => value,
                        None => Rc::new(crate::data::decode_missing("payload")?),
                    },
                })
            }
        }
        d.deserialize_map(Fields(PhantomData))
    }
}
impl<P: Serialize, R: Serialize> Serialize for Cmd<P, R> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Process(cmd) => cmd.serialize(s),
            Self::Replay(cmd) => cmd.serialize(s),
        }
    }
}
