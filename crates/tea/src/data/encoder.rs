use indexmap::IndexMap;
use serde::{
    Serialize,
    ser::{
        self, SerializeMap, SerializeSeq, SerializeStruct, SerializeStructVariant, SerializeTuple,
        SerializeTupleStruct, SerializeTupleVariant,
    },
};

use super::{
    DependencyError, JsText, PlainData, decode_json,
    json::{DATA_TOKEN, UNDEFINED_TOKEN},
};

impl ser::Error for DependencyError {
    fn custom<T: std::fmt::Display>(message: T) -> Self {
        Self::Serialization(serde_value::SerializerError::Custom(message.to_string()))
    }
}
#[derive(Clone, Copy)]
pub(super) struct Encoder {
    human: bool,
}
impl Encoder {
    pub fn new() -> Self {
        Self { human: true }
    }
}
fn wrap(variant: Option<String>, value: PlainData) -> PlainData {
    match variant {
        Some(name) => PlainData::Object(IndexMap::from([(name.into(), value)])),
        None => value,
    }
}
impl ser::Serializer for Encoder {
    type Ok = PlainData;
    type Error = DependencyError;
    type SerializeSeq = Sequence;
    type SerializeTuple = Sequence;
    type SerializeTupleStruct = Sequence;
    type SerializeTupleVariant = Sequence;
    type SerializeMap = Record;
    type SerializeStruct = Record;
    type SerializeStructVariant = Record;
    fn is_human_readable(&self) -> bool {
        self.human
    }
    fn serialize_bool(self, value: bool) -> Result<PlainData, DependencyError> {
        Ok(PlainData::Bool(value))
    }
    fn serialize_i8(self, value: i8) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_i16(self, value: i16) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_i32(self, value: i32) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_i64(self, value: i64) -> Result<PlainData, DependencyError> {
        self.serialize_f64(value as f64)
    }
    fn serialize_u8(self, value: u8) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_u16(self, value: u16) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_u32(self, value: u32) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_u64(self, value: u64) -> Result<PlainData, DependencyError> {
        self.serialize_f64(value as f64)
    }
    fn serialize_f32(self, value: f32) -> Result<PlainData, DependencyError> {
        self.serialize_f64(f64::from(value))
    }
    fn serialize_f64(self, value: f64) -> Result<PlainData, DependencyError> {
        Ok(PlainData::Number(value))
    }
    fn serialize_char(self, value: char) -> Result<PlainData, DependencyError> {
        self.serialize_str(&value.to_string())
    }
    fn serialize_str(self, value: &str) -> Result<PlainData, DependencyError> {
        Ok(PlainData::String(value.into()))
    }
    fn serialize_bytes(self, value: &[u8]) -> Result<PlainData, DependencyError> {
        Ok(PlainData::Array(
            value
                .iter()
                .map(|value| PlainData::Number(f64::from(*value)))
                .collect(),
        ))
    }
    fn serialize_none(self) -> Result<PlainData, DependencyError> {
        Ok(PlainData::Null)
    }
    fn serialize_some<T: Serialize + ?Sized>(
        self,
        value: &T,
    ) -> Result<PlainData, DependencyError> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<PlainData, DependencyError> {
        Ok(PlainData::Null)
    }
    fn serialize_unit_struct(self, name: &'static str) -> Result<PlainData, DependencyError> {
        Ok(if name == UNDEFINED_TOKEN {
            PlainData::Undefined
        } else {
            PlainData::Null
        })
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<PlainData, DependencyError> {
        self.serialize_str(variant)
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<PlainData, DependencyError> {
        value.serialize(if name == DATA_TOKEN {
            Self { human: false }
        } else {
            self
        })
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<PlainData, DependencyError> {
        Ok(wrap(Some(variant.into()), value.serialize(self)?))
    }
    fn serialize_seq(self, length: Option<usize>) -> Result<Sequence, DependencyError> {
        Ok(Sequence {
            encoder: self,
            values: Vec::with_capacity(length.unwrap_or(0)),
            variant: None,
        })
    }
    fn serialize_tuple(self, length: usize) -> Result<Sequence, DependencyError> {
        self.serialize_seq(Some(length))
    }
    fn serialize_tuple_struct(
        self,
        _: &'static str,
        length: usize,
    ) -> Result<Sequence, DependencyError> {
        self.serialize_seq(Some(length))
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        length: usize,
    ) -> Result<Sequence, DependencyError> {
        let mut sequence = self.serialize_seq(Some(length))?;
        sequence.variant = Some(variant.into());
        Ok(sequence)
    }
    fn serialize_map(self, length: Option<usize>) -> Result<Record, DependencyError> {
        Ok(Record {
            encoder: self,
            values: IndexMap::with_capacity(length.unwrap_or(0)),
            key: None,
            raw: false,
            variant: None,
        })
    }
    fn serialize_struct(
        self,
        name: &'static str,
        length: usize,
    ) -> Result<Record, DependencyError> {
        let mut record = self.serialize_map(Some(length))?;
        record.raw = name == "$serde_json::private::RawValue";
        Ok(record)
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        length: usize,
    ) -> Result<Record, DependencyError> {
        let mut record = self.serialize_map(Some(length))?;
        record.variant = Some(variant.into());
        Ok(record)
    }
}

pub(super) struct Sequence {
    encoder: Encoder,
    values: Vec<PlainData>,
    variant: Option<String>,
}
macro_rules! sequence {
    ($trait:ident, $method:ident) => {
        impl $trait for Sequence {
            type Ok = PlainData;
            type Error = DependencyError;
            fn $method<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), DependencyError> {
                self.values.push(value.serialize(self.encoder)?);
                Ok(())
            }
            fn end(self) -> Result<PlainData, DependencyError> {
                Ok(wrap(self.variant, PlainData::Array(self.values)))
            }
        }
    };
}
sequence!(SerializeSeq, serialize_element);
sequence!(SerializeTuple, serialize_element);
sequence!(SerializeTupleStruct, serialize_field);
sequence!(SerializeTupleVariant, serialize_field);

pub(super) struct Record {
    encoder: Encoder,
    values: IndexMap<JsText, PlainData>,
    key: Option<JsText>,
    raw: bool,
    variant: Option<String>,
}
impl Record {
    fn finish(self) -> Result<PlainData, DependencyError> {
        if self.raw {
            let Some(PlainData::String(text)) = self.values.get("$serde_json::private::RawValue")
            else {
                return Err(ser::Error::custom("invalid raw JSON value"));
            };
            return decode_json(text.as_utf8().ok_or_else(|| {
                <DependencyError as ser::Error>::custom("raw JSON text must be UTF-8")
            })?)
            .map_err(ser::Error::custom);
        }
        Ok(wrap(self.variant, PlainData::Object(self.values)))
    }
}
impl SerializeMap for Record {
    type Ok = PlainData;
    type Error = DependencyError;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), DependencyError> {
        let PlainData::String(key) = value.serialize(self.encoder)? else {
            return Err(DependencyError::ObjectKey);
        };
        self.key = Some(key);
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), DependencyError> {
        let key = self
            .key
            .take()
            .ok_or_else(|| <DependencyError as ser::Error>::custom("object value has no key"))?;
        self.values.insert(key, value.serialize(self.encoder)?);
        Ok(())
    }
    fn end(self) -> Result<PlainData, DependencyError> {
        self.finish()
    }
}
impl SerializeStruct for Record {
    type Ok = PlainData;
    type Error = DependencyError;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), DependencyError> {
        self.values
            .insert(key.into(), value.serialize(self.encoder)?);
        Ok(())
    }
    fn end(self) -> Result<PlainData, DependencyError> {
        self.finish()
    }
}
impl SerializeStructVariant for Record {
    type Ok = PlainData;
    type Error = DependencyError;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), DependencyError> {
        SerializeStruct::serialize_field(self, key, value)
    }
    fn end(self) -> Result<PlainData, DependencyError> {
        self.finish()
    }
}
