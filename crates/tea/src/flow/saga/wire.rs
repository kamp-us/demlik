use super::*;
use crate::data::{JsonData, plain_data};
use serde::{Deserialize, Serialize};
fn field<T: Serialize>(
    value: &QueueField<Rc<T>>,
) -> Result<Option<PlainData>, crate::data::DependencyError> {
    match value {
        QueueField::Absent => Ok(None),
        QueueField::Undefined => Ok(Some(PlainData::Undefined)),
        QueueField::Value(value) => plain_data(value).map(Some),
    }
}
impl<I: Serialize, F: Serialize> Serialize for SagaState<I, F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = indexmap::IndexMap::new();
        for key in &self.field_order {
            let value = match key.as_utf8() {
                Some("position") => plain_data(&self.position).map(Some),
                Some("done") => plain_data(&self.done).map(Some),
                Some("compensating") => plain_data(&self.compensating).map(Some),
                Some("phase") => plain_data(&self.phase).map(Some),
                Some("items") => plain_data(&self.items).map(Some),
                Some("error") => field(&self.error),
                Some("compensationError") => field(&self.compensation_error),
                _ => Ok(self.extra.get(key).map(|value| value.as_ref().clone())),
            }
            .map_err(serde::ser::Error::custom)?;
            if let Some(value) = value {
                record.insert(key.clone(), value);
            }
        }
        JsonData(&PlainData::Object(record)).serialize(serializer)
    }
}
impl<'de, I: Deserialize<'de>, F: Deserialize<'de>> Deserialize<'de> for SagaState<I, F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields<I, F>(PhantomData<fn() -> (I, F)>);
        impl<'de, I: Deserialize<'de>, F: Deserialize<'de>> serde::de::Visitor<'de> for Fields<I, F> {
            type Value = SagaState<I, F>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a saga state")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let (mut position, mut done, mut compensating, mut phase, mut items) =
                    (None, None, None, None, None);
                let (mut error, mut compensation_error) = (QueueField::Absent, QueueField::Absent);
                let mut field_order = vec![];
                let mut extra = indexmap::IndexMap::new();
                while let Some(key) = map.next_key::<JsText>()? {
                    if !field_order.contains(&key) {
                        field_order.push(key.clone());
                    }
                    match key.as_utf8() {
                        Some("position") => position = Some(map.next_value()?),
                        Some("done") => done = Some(map.next_value()?),
                        Some("compensating") => compensating = Some(map.next_value()?),
                        Some("phase") => phase = Some(map.next_value()?),
                        Some("items") => items = Some(map.next_value()?),
                        Some("error") => error = map.next_value()?,
                        Some("compensationError") => compensation_error = map.next_value()?,
                        _ => {
                            extra.insert(key, map.next_value()?);
                        }
                    }
                }
                Ok(SagaState {
                    fields: SagaFields {
                        position: position
                            .ok_or_else(|| serde::de::Error::missing_field("position"))?,
                        done: done.ok_or_else(|| serde::de::Error::missing_field("done"))?,
                        compensating: compensating
                            .ok_or_else(|| serde::de::Error::missing_field("compensating"))?,
                        phase: phase.ok_or_else(|| serde::de::Error::missing_field("phase"))?,
                        items: items.ok_or_else(|| serde::de::Error::missing_field("items"))?,
                        error,
                        compensation_error,
                    },
                    field_order,
                    extra,
                })
            }
        }
        deserializer.deserialize_map(Fields(PhantomData))
    }
}
