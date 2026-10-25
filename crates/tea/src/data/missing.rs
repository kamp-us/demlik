use serde::{
    Deserialize,
    de::{self, Visitor},
};

/// Restore an omitted property only when its typed decoder supports absence.
/// `PlainData` recovers `Undefined`; required strings, records and JSON values
/// keep a missing-field error. Pure values gain no Default or serde bound.
pub fn decode_missing<'de, T: Deserialize<'de>, E: de::Error>(field: &'static str) -> Result<T, E> {
    T::deserialize(Missing { field }).map_err(E::custom)
}

struct Missing {
    field: &'static str,
}
impl<'de> de::Deserializer<'de> for Missing {
    type Error = de::value::Error;
    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
        Err(de::Error::missing_field(self.field))
    }
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        visitor.visit_none()
    }
    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        visitor.visit_unit()
    }
    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        visitor.visit_unit()
    }
    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        if name == super::UNDEFINED_TOKEN {
            visitor.visit_unit()
        } else {
            visitor.visit_newtype_struct(self)
        }
    }
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        seq tuple tuple_struct map struct enum identifier ignored_any
    }
}
