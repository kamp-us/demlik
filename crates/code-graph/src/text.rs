//! Lossless JavaScript string values at the JSON and filesystem boundaries.

use std::fmt::Write;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use serde_json::value::RawValue;

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JsString(Vec<u16>);

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
