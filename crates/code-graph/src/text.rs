//! JavaScript strings, patterns, and JSON values at native boundaries.

use std::fmt::Write;

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use serde_json::value::RawValue;

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JsString(Vec<u16>);

/// An unflagged ECMAScript pattern, matching JavaScript's UTF-16 code units.
#[derive(Debug)]
pub struct JsRegex(regress::Regex);
impl JsRegex {
    pub fn new(source: &JsString) -> Result<Self, regress::Error> {
        regress::Regex::from_unicode(
            source.units().iter().copied().map(u32::from),
            regress::Flags::default(),
        )
        .map(Self)
    }
    pub fn test(&self, value: &JsString) -> bool {
        self.0.find_from_ucs2(value.units(), 0).next().is_some()
    }
    pub fn test_str(&self, value: &str) -> bool {
        self.test(&value.into())
    }
    /// Captures from the first UCS-2 match, with slot 0 the first capturing group.
    /// An untaken alternative is None; a matched empty group is Some(empty).
    pub(crate) fn capture_groups(&self, value: &JsString) -> Option<Vec<Option<JsString>>> {
        let matched = self.0.find_from_ucs2(value.units(), 0).next()?;
        Some(
            matched
                .captures
                .into_iter()
                .map(|range| range.map(|range| JsString::from_units(value.units()[range].to_vec())))
                .collect(),
        )
    }
}

#[cfg(test)]
mod regex_capture_tests {
    use super::{JsRegex, JsString};
    #[test]
    fn optional_empty_and_raw_captures_keep_their_distinct_values() {
        let pattern = JsRegex::new(&"^(a)?()(.*)$".into()).unwrap();
        let raw = JsString::from_units(vec![0xd800, 0xdc00, 0xdfff]);
        assert_eq!(
            pattern.capture_groups(&raw).unwrap(),
            [None, Some("".into()), Some(raw)]
        );
        assert_eq!(
            pattern.capture_groups(&"".into()).unwrap(),
            [None, Some("".into()), Some("".into())]
        );
        assert!(
            JsRegex::new(&"^(a)$".into())
                .unwrap()
                .capture_groups(&"b".into())
                .is_none()
        );
    }
}

impl JsString {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    pub fn to_utf8(&self) -> Result<String, std::string::FromUtf16Error> {
        String::from_utf16(&self.0)
    }
    /// Node replaces lone surrogates when encoding strings for native filesystem calls.
    pub fn to_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn contains(&self, part: &Self) -> bool {
        part.is_empty()
            || self
                .0
                .windows(part.0.len())
                .any(|units| units == part.units())
    }
    pub fn starts_with(&self, prefix: &str) -> bool {
        let mut units = self.0.iter();
        prefix
            .encode_utf16()
            .all(|expected| units.next() == Some(&expected))
    }
    pub fn push_str(&mut self, text: &str) {
        self.0.extend(text.encode_utf16());
    }
    pub fn extend(&mut self, text: &Self) {
        self.0.extend_from_slice(&text.0);
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.0.iter().copied().eq(other.encode_utf16())
    }
}
impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}
impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        self == other.as_str()
    }
}

impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut json = String::from("\"");
        for character in char::decode_utf16(self.0.iter().copied()) {
            match character {
                Err(error) => write!(json, "\\u{:04x}", error.unpaired_surrogate())
                    .expect("writing to a String cannot fail"),
                Ok('"') => json.push_str("\\\""),
                Ok('\\') => json.push_str("\\\\"),
                Ok('\u{8}') => json.push_str("\\b"),
                Ok('\t') => json.push_str("\\t"),
                Ok('\n') => json.push_str("\\n"),
                Ok('\u{c}') => json.push_str("\\f"),
                Ok('\r') => json.push_str("\\r"),
                Ok(character) if character < ' ' => write!(json, "\\u{:04x}", character as u32)
                    .expect("writing to a String cannot fail"),
                Ok(character) => json.push(character),
            }
        }
        json.push('"');
        RawValue::from_string(json)
            .expect("encoded code units form a JSON string")
            .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let raw = raw.get();
        if !raw.starts_with('"') {
            return Err(D::Error::custom("expected a JavaScript string"));
        }
        let mut chars = raw[1..raw.len() - 1].chars();
        let mut units = Vec::new();
        while let Some(character) = chars.next() {
            if character == '\\' {
                let escaped = chars.next().expect("RawValue validates JSON escapes");
                if escaped == 'u' {
                    let mut unit = 0;
                    for _ in 0..4 {
                        unit = (unit << 4)
                            | chars
                                .next()
                                .and_then(|digit| digit.to_digit(16))
                                .expect("RawValue validates unicode escapes")
                                as u16;
                    }
                    units.push(unit);
                } else {
                    units.push(match escaped {
                        'b' => 8,
                        'f' => 12,
                        'n' => 10,
                        'r' => 13,
                        't' => 9,
                        '"' => 34,
                        '\\' => 92,
                        '/' => 47,
                        _ => unreachable!("RawValue validates JSON escapes"),
                    });
                }
            } else {
                units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
            }
        }
        Ok(Self(units))
    }
}

pub type JsObject = IndexMap<JsString, JsValue>;

/// The pinned pristine Object.prototype, separate from a JSON object's own properties.
pub fn has_object_prototype_property(key: &JsString) -> bool {
    [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "__proto__",
        "toLocaleString",
    ]
    .iter()
    .any(|name| key == name)
}

pub(crate) fn object_prototype_function_name(key: &JsString) -> Option<JsString> {
    (key != "__proto__" && has_object_prototype_property(key)).then(|| {
        if key == "constructor" {
            "Object".into()
        } else {
            key.clone()
        }
    })
}

pub(crate) const RESTRICTED_FUNCTION_PROPERTY_MESSAGE: &str = "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them";

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsValue>),
    Object(JsObject),
}

/// Own keys in Object.keys/JSON.stringify order: array indices, then insertion order.
pub fn object_keys<V>(object: &IndexMap<JsString, V>) -> Vec<&JsString> {
    fn array_index(key: &JsString) -> Option<u32> {
        let units = key.units();
        if units.is_empty() || units.len() > 10 || units.len() > 1 && units[0] == u16::from(b'0') {
            return None;
        }
        let mut value = 0u64;
        for &unit in units {
            if !(u16::from(b'0')..=u16::from(b'9')).contains(&unit) {
                return None;
            }
            value = value * 10 + u64::from(unit - u16::from(b'0'));
        }
        (value < u64::from(u32::MAX)).then_some(value as u32)
    }
    let mut indices = Vec::new();
    let mut others = Vec::new();
    for key in object.keys() {
        if let Some(index) = array_index(key) {
            indices.push((index, key));
        } else {
            others.push(key);
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, key)| key)
        .chain(others)
        .collect()
}

impl JsValue {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        deserializer.disable_recursion_limit();
        let value = Self::deserialize(&mut deserializer)?;
        deserializer.end()?;
        Ok(value)
    }
    pub fn as_object(&self) -> Option<&JsObject> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&[Self]> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_string(&self) -> Option<&JsString> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_number(&self) -> Option<f64> {
        if let Self::Number(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?.get(&JsString::from(key))
    }
    fn write_json(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) if !value.is_finite() => out.push_str("null"),
            Self::Number(value) => out.push_str(ryu_js::Buffer::new().format(*value)),
            Self::String(value) => out.push_str(
                &serde_json::to_string(value).expect("JavaScript strings serialize losslessly"),
            ),
            Self::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write_json(out);
                }
                out.push(']');
            }
            Self::Object(object) => write_object(object, out),
        }
    }
}
fn write_object(object: &JsObject, out: &mut String) {
    out.push('{');
    for (index, key) in object_keys(object).into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).expect("JavaScript keys serialize losslessly"));
        out.push(':');
        object[key].write_json(out);
    }
    out.push('}');
}
pub(crate) fn serialize_object<S: Serializer>(
    object: &JsObject,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut json = String::new();
    write_object(object, &mut json);
    RawValue::from_string(json)
        .expect("JavaScript JSON objects serialize valid JSON")
        .serialize(serializer)
}
pub(crate) fn serialize_number<S: Serializer>(
    value: &f64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    JsValue::Number(*value).serialize(serializer)
}
impl<'de> Deserialize<'de> for JsValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let raw = raw.get();
        match raw.as_bytes()[0] {
            b'n' => Ok(Self::Null),
            b't' => Ok(Self::Bool(true)),
            b'f' => Ok(Self::Bool(false)),
            b'"' => serde_json::from_str(raw)
                .map(Self::String)
                .map_err(D::Error::custom),
            b'[' => serde_json::from_str(raw)
                .map(Self::Array)
                .map_err(D::Error::custom),
            b'{' => serde_json::from_str(raw)
                .map(Self::Object)
                .map_err(D::Error::custom),
            _ => raw
                .parse::<f64>()
                .map(Self::Number)
                .map_err(D::Error::custom),
        }
    }
}
impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut json = String::new();
        self.write_json(&mut json);
        RawValue::from_string(json)
            .expect("JavaScript JSON values serialize valid JSON")
            .serialize(serializer)
    }
}
