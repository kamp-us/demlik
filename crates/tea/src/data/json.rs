use std::{
    cmp::Ordering,
    hash::{Hash, Hasher},
};

use indexmap::{Equivalent, IndexMap};
use serde::{
    Deserialize, Serialize,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::value::RawValue;

use super::PlainData;

pub(super) const DATA_TOKEN: &str = "$demlik::PlainData";
pub(crate) const UNDEFINED_TOKEN: &str = "$demlik::Undefined";

#[derive(Clone, Debug)]
/// JavaScript text, including unpaired UTF-16 units. The UTF-8 view is checked.
pub struct JsText {
    units: Vec<u16>,
    utf8: Option<String>,
}
impl JsText {
    pub fn from_units(units: Vec<u16>) -> Self {
        let utf8 = String::from_utf16(&units).ok();
        Self { units, utf8 }
    }
    pub fn as_units(&self) -> &[u16] {
        &self.units
    }
    pub fn as_utf8(&self) -> Option<&str> {
        self.utf8.as_deref()
    }
    pub fn into_units(self) -> Vec<u16> {
        self.units
    }
}
impl From<String> for JsText {
    fn from(value: String) -> Self {
        Self {
            units: value.encode_utf16().collect(),
            utf8: Some(value),
        }
    }
}
impl From<&str> for JsText {
    fn from(value: &str) -> Self {
        value.to_owned().into()
    }
}
impl From<&String> for JsText {
    fn from(value: &String) -> Self {
        value.as_str().into()
    }
}
impl From<&JsText> for JsText {
    fn from(value: &JsText) -> Self {
        value.clone()
    }
}
impl PartialEq for JsText {
    fn eq(&self, other: &Self) -> bool {
        self.units == other.units
    }
}
impl Eq for JsText {}
impl PartialOrd for JsText {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for JsText {
    fn cmp(&self, other: &Self) -> Ordering {
        self.units.cmp(&other.units)
    }
}
impl Hash for JsText {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match &self.utf8 {
            Some(value) => value.hash(state),
            None => self.units.hash(state),
        }
    }
}
impl Equivalent<JsText> for str {
    fn equivalent(&self, key: &JsText) -> bool {
        self.encode_utf16().eq(key.units.iter().copied())
    }
}
impl Equivalent<JsText> for String {
    fn equivalent(&self, key: &JsText) -> bool {
        self.as_str().equivalent(key)
    }
}
impl Serialize for JsText {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(text) = self.as_utf8() {
            return serializer.serialize_str(text);
        }
        let raw = RawValue::from_string(quote(self)).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for JsText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;
        impl<'de> serde::de::Visitor<'de> for Text {
            type Value = JsText;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JavaScript string")
            }
            fn visit_newtype_struct<D: serde::Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<JsText, D::Error> {
                String::deserialize(deserializer).map(Into::into)
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<JsText, E> {
                Ok(value.into())
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<JsText, E> {
                Ok(value.into())
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<JsText, M::Error> {
                let key: Option<String> = map.next_key()?;
                if key.as_deref() != Some("$serde_json::private::RawValue") {
                    return Err(serde::de::Error::custom("expected raw JSON text"));
                }
                let raw: String = map.next_value()?;
                match decode_json(&raw).map_err(serde::de::Error::custom)? {
                    PlainData::String(text) => Ok(text),
                    _ => Err(serde::de::Error::custom("expected a JavaScript string")),
                }
            }
        }
        deserializer.deserialize_newtype_struct("$serde_json::private::RawValue", Text)
    }
}

pub fn decode_json(input: &str) -> Result<PlainData, serde_json::Error> {
    let raw: &RawValue = serde_json::from_str(input)?;
    Ok(Parser {
        input: raw.get(),
        offset: 0,
    }
    .value())
}
struct Parser<'a> {
    input: &'a str,
    offset: usize,
}
impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .input
            .as_bytes()
            .get(self.offset)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.offset += 1;
        }
    }
    fn value(&mut self) -> PlainData {
        self.whitespace();
        match self.input.as_bytes()[self.offset] {
            b'n' => {
                self.offset += 4;
                PlainData::Null
            }
            b't' => {
                self.offset += 4;
                PlainData::Bool(true)
            }
            b'f' => {
                self.offset += 5;
                PlainData::Bool(false)
            }
            b'"' => PlainData::String(self.text()),
            b'[' => {
                self.offset += 1;
                self.whitespace();
                let mut values = Vec::new();
                if self.input.as_bytes()[self.offset] != b']' {
                    loop {
                        values.push(self.value());
                        self.whitespace();
                        if self.input.as_bytes()[self.offset] == b']' {
                            break;
                        }
                        self.offset += 1;
                    }
                }
                self.offset += 1;
                PlainData::Array(values)
            }
            b'{' => {
                self.offset += 1;
                self.whitespace();
                let mut values = IndexMap::new();
                if self.input.as_bytes()[self.offset] != b'}' {
                    loop {
                        self.whitespace();
                        let key = self.text();
                        self.whitespace();
                        self.offset += 1;
                        values.insert(key, self.value());
                        self.whitespace();
                        if self.input.as_bytes()[self.offset] == b'}' {
                            break;
                        }
                        self.offset += 1;
                    }
                }
                self.offset += 1;
                values.sort_by(|left, _, right, _| {
                    left.array_index()
                        .map_or((1, 0), |index| (0, index))
                        .cmp(&right.array_index().map_or((1, 0), |index| (0, index)))
                });
                PlainData::Object(values)
            }
            _ => {
                let start = self.offset;
                while self.input.as_bytes().get(self.offset).is_some_and(|byte| {
                    !matches!(byte, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t')
                }) {
                    self.offset += 1;
                }
                PlainData::Number(
                    self.input[start..self.offset]
                        .parse()
                        .expect("validated JSON number"),
                )
            }
        }
    }
    fn text(&mut self) -> JsText {
        self.offset += 1;
        let mut units = Vec::new();
        loop {
            match self.input.as_bytes()[self.offset] {
                b'"' => {
                    self.offset += 1;
                    break;
                }
                b'\\' => {
                    self.offset += 1;
                    let escaped = self.input.as_bytes()[self.offset];
                    self.offset += 1;
                    units.push(match escaped {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let unit =
                                u16::from_str_radix(&self.input[self.offset..self.offset + 4], 16)
                                    .expect("validated JSON escape");
                            self.offset += 4;
                            unit
                        }
                        _ => unreachable!("JSON escapes were validated"),
                    });
                }
                _ => {
                    let character = self.input[self.offset..]
                        .chars()
                        .next()
                        .expect("validated JSON text");
                    self.offset += character.len_utf8();
                    units.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
        }
        JsText::from_units(units)
    }
}

fn quote(text: &JsText) -> String {
    let mut output = String::from("\"");
    let mut units = text.units.iter().copied().peekable();
    while let Some(unit) = units.next() {
        match unit {
            34 => output.push_str("\\\""),
            92 => output.push_str("\\\\"),
            8 => output.push_str("\\b"),
            12 => output.push_str("\\f"),
            10 => output.push_str("\\n"),
            13 => output.push_str("\\r"),
            9 => output.push_str("\\t"),
            0..=31 => output.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if units
                    .peek()
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let low = units.next().expect("checked low surrogate");
                output.push(
                    char::from_u32(
                        0x10000 + ((u32::from(unit) - 0xd800) << 10) + u32::from(low) - 0xdc00,
                    )
                    .expect("paired UTF-16"),
                );
            }
            0xd800..=0xdfff => output.push_str(&format!("\\u{unit:04x}")),
            _ => output.push(char::from_u32(u32::from(unit)).expect("non-surrogate UTF-16")),
        }
    }
    output.push('"');
    output
}
impl JsText {
    pub(crate) fn array_index(&self) -> Option<u32> {
        let key = self.as_utf8()?;
        let index: u32 = key.parse().ok()?;
        (index != u32::MAX && index.to_string() == key).then_some(index)
    }
}
pub fn stringify_json(value: &PlainData) -> Option<String> {
    Some(match value {
        PlainData::Undefined => return None,
        PlainData::Null => "null".into(),
        PlainData::Bool(value) => value.to_string(),
        PlainData::Number(value) => {
            if !value.is_finite() {
                "null".into()
            } else if *value == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format(*value).into()
            }
        }
        PlainData::String(value) => quote(value),
        PlainData::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(|value| stringify_json(value).unwrap_or_else(|| "null".into()))
                .collect::<Vec<_>>()
                .join(",")
        ),
        PlainData::Object(values) => {
            let mut entries = values
                .iter()
                .filter(|(_, value)| !matches!(value, PlainData::Undefined))
                .collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| key.array_index().map_or((1, 0), |index| (0, index)));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        quote(key),
                        stringify_json(value).expect("undefined object fields were omitted")
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    })
}

pub struct JsonData<'a>(pub &'a PlainData);
impl Serialize for JsonData<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(DATA_TOKEN, &DataBody(self.0))
    }
}
impl Serialize for PlainData {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(self).serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for PlainData {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Data;
        impl<'de> serde::de::Visitor<'de> for Data {
            type Value = PlainData;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("JSON data or an omitted undefined field")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<PlainData, E> {
                Ok(PlainData::Undefined)
            }
            fn visit_newtype_struct<D: serde::Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<PlainData, D::Error> {
                let raw = Box::<RawValue>::deserialize(deserializer)?;
                decode_json(raw.get()).map_err(serde::de::Error::custom)
            }
        }
        deserializer.deserialize_newtype_struct(UNDEFINED_TOKEN, Data)
    }
}
struct DataBody<'a>(&'a PlainData);
impl Serialize for DataBody<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            let text = stringify_json(self.0)
                .ok_or_else(|| serde::ser::Error::custom("undefined has no JSON text"))?;
            return RawValue::from_string(text)
                .map_err(serde::ser::Error::custom)?
                .serialize(serializer);
        }
        match self.0 {
            PlainData::Null => serializer.serialize_unit(),
            PlainData::Undefined => serializer.serialize_unit_struct(UNDEFINED_TOKEN),
            PlainData::Bool(value) => serializer.serialize_bool(*value),
            PlainData::Number(value) => serializer.serialize_f64(*value),
            PlainData::String(value) => value.serialize(serializer),
            PlainData::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&DataBody(value))?;
                }
                sequence.end()
            }
            PlainData::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, &DataBody(value))?;
                }
                map.end()
            }
        }
    }
}
