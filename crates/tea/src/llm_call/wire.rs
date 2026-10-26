use super::*;
use serde::{Deserializer, Serializer, ser::SerializeMap};

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
impl<'de, P: Deserialize<'de>, I: Deserialize<'de>> Deserialize<'de> for Request<P, I> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "P:Deserialize<'de>,I:Deserialize<'de>"))]
        struct Fields<P, I> {
            purpose: P,
            model: Option<JsText>,
            #[serde(default, deserialize_with = "present")]
            payload: Option<I>,
        }
        let fields = Fields::deserialize(d)?;
        let payload_present = fields.payload.is_some();
        let payload = match fields.payload {
            Some(value) => value,
            None => crate::data::decode_missing("payload")?,
        };
        Ok(Self {
            purpose: fields.purpose,
            model: fields.model,
            payload,
            payload_present,
        })
    }
}
impl<P: Serialize, I: Serialize> Serialize for Request<P, I> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("purpose", &self.purpose)?;
        map.serialize_entry("model", &self.model)?;
        if self.payload_present {
            map.serialize_entry("payload", &self.payload)?;
        }
        map.end()
    }
}
impl<'de, P: Deserialize<'de>, O: Deserialize<'de>> Deserialize<'de> for LlmOk<P, O> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "P:Deserialize<'de>,O:Deserialize<'de>"))]
        struct Fields<P, O> {
            key: JsText,
            purpose: P,
            #[serde(default, deserialize_with = "present")]
            output: Option<O>,
        }
        let fields = Fields::deserialize(d)?;
        let output = match fields.output {
            Some(value) => value,
            None => crate::data::decode_missing("output")?,
        };
        Ok(Self {
            key: fields.key,
            purpose: fields.purpose,
            output,
        })
    }
}

pub(super) fn missing_cause<E>() -> LlmCause<E> {
    LlmCause::Missing
}
impl<E> LlmCause<E> {
    pub fn is_undefined(&self) -> bool {
        matches!(self, Self::Missing | Self::Undefined)
    }
}
impl<E: Serialize> Serialize for LlmCause<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(value) => value.serialize(serializer),
            Self::AccessError(_) => serializer.serialize_map(Some(0))?.end(),
            Self::Undefined | Self::Missing => PlainData::Undefined.serialize(serializer),
            Self::Carrier(value) => value.serialize(serializer),
            Self::Malformed(value) => value.serialize(serializer),
        }
    }
}
impl<'de, E: Deserialize<'de>> Deserialize<'de> for LlmCause<E> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        E::deserialize(deserializer).map(|value| Self::Value(Rc::new(value)))
    }
}
impl<E: Serialize> Serialize for Rejected<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in &self.0.fields {
            map.serialize_entry(key, value)?;
        }
        match &self.0.cause {
            CauseField::Own(CallValue::Shared(value)) => map.serialize_entry("cause", value)?,
            // A JS property Error retains diagnostics, but no enumerable JSON fields.
            CauseField::AccessError(_) => {
                map.serialize_entry("cause", &PlainData::Object(IndexMap::new()))?;
            }
            _ => {}
        }
        map.end()
    }
}
impl<'de, E: Deserialize<'de>> Deserialize<'de> for Rejected<E> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Record<E>(std::marker::PhantomData<E>);
        impl<'de, E: Deserialize<'de>> serde::de::Visitor<'de> for Record<E> {
            type Value = Rejected<E>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a rejected handler record")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut cause = CauseField::Missing;
                let mut fields = IndexMap::new();
                while let Some(key) = map.next_key::<JsText>()? {
                    match key.as_utf8() {
                        Some("cause") => cause = CauseField::Own(map.next_value()?),
                        Some("_tag") => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                        _ => {
                            fields.insert(key, map.next_value()?);
                        }
                    }
                }
                Ok(Rejected(Rc::new(Rejection { cause, fields })))
            }
        }
        deserializer.deserialize_map(Record(std::marker::PhantomData))
    }
}
