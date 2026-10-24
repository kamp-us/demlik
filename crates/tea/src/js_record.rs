use std::fmt;

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeMap};

use crate::PlainData;

#[derive(Clone, Debug, Serialize)]
pub struct JsAccessError {
    pub name: &'static str,
    pub message: String,
}
impl JsAccessError {
    fn type_error(message: impl Into<String>) -> Self {
        Self {
            name: "TypeError",
            message: message.into(),
        }
    }
}
impl fmt::Display for JsAccessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}
impl std::error::Error for JsAccessError {}

#[derive(Debug)]
pub enum JsRead<'a, V> {
    Stored(&'a V),
    Projected(PlainData),
}
impl<V: Serialize> Serialize for JsRead<'_, V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Stored(value) => value.serialize(serializer),
            Self::Projected(value) => JsonData(value).serialize(serializer),
        }
    }
}

#[derive(Clone, Debug)]
pub enum RecordValue<E> {
    Entry(E),
    Data(PlainData),
    Builtin(&'static str),
    ObjectPrototype,
}
impl<E: Serialize> Serialize for RecordValue<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Entry(entry) => entry.serialize(serializer),
            Self::Data(value) => JsonData(value).serialize(serializer),
            Self::ObjectPrototype => serializer.serialize_map(Some(0))?.end(),
            Self::Builtin(_) => serializer.serialize_none(),
        }
    }
}

#[derive(Clone, Debug)]
enum Prototype<E> {
    Object,
    Null,
    Injected(Box<RecordValue<E>>),
}

/// An ordinary JS data record: JSON exposes own enumerable values, while reads
/// also see the pristine Object.prototype or the object assigned to __proto__.
#[derive(Clone, Debug)]
pub struct JsRecord<E> {
    own: IndexMap<String, RecordValue<E>>,
    prototype: Prototype<E>,
}
impl<E> Default for JsRecord<E> {
    fn default() -> Self {
        Self {
            own: IndexMap::new(),
            prototype: Prototype::Object,
        }
    }
}
impl<E> JsRecord<E> {
    /// JSON parsing creates an own __proto__ property rather than invoking its setter.
    pub fn from_own(entries: IndexMap<String, E>) -> Self {
        Self {
            own: entries
                .into_iter()
                .map(|(key, value)| (key, RecordValue::Entry(value)))
                .collect(),
            prototype: Prototype::Object,
        }
    }
    pub fn own_entries(&self) -> impl Iterator<Item = (&String, &RecordValue<E>)> {
        self.own.iter()
    }
    pub(crate) fn assign(&mut self, key: String, value: RecordValue<E>) {
        let setter_visible = match &self.prototype {
            Prototype::Null => false,
            Prototype::Injected(value) => {
                !matches!(value.as_ref(), RecordValue::Data(PlainData::Object(values)) if values.contains_key("__proto__"))
            }
            Prototype::Object => true,
        };
        if key == "__proto__" && !self.own.contains_key(&key) && setter_visible {
            match value {
                RecordValue::Data(PlainData::Null) => self.prototype = Prototype::Null,
                RecordValue::Data(
                    PlainData::Undefined
                    | PlainData::Bool(_)
                    | PlainData::Number(_)
                    | PlainData::String(_),
                ) => {}
                RecordValue::ObjectPrototype => self.prototype = Prototype::Object,
                value => self.prototype = Prototype::Injected(Box::new(value)),
            }
        } else {
            self.own.insert(key, value);
        }
    }
    pub(crate) fn delete(&mut self, key: &str) {
        self.own.shift_remove(key);
    }
}
impl<E: Clone> JsRecord<E> {
    /// Object spread copies own values, defining __proto__ as data, and resets the prototype.
    pub(crate) fn spread(&self) -> Self {
        Self {
            own: self.own.clone(),
            prototype: Prototype::Object,
        }
    }
}
impl<E: Serialize> JsRecord<E> {
    pub fn to_plain_data(&self) -> Result<PlainData, JsAccessError> {
        plain(self)
    }
}
impl<E: Serialize> Serialize for JsRecord<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in &self.own {
            if matches!(
                value,
                RecordValue::Builtin(_) | RecordValue::Data(PlainData::Undefined)
            ) {
                continue;
            }
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}
impl<'de, E: Deserialize<'de>> Deserialize<'de> for JsRecord<E> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        IndexMap::<String, E>::deserialize(deserializer).map(Self::from_own)
    }
}

pub(crate) trait RecordEntry {
    type Value: Serialize;
    const TIMESTAMP_KEY: &'static str;
    fn payload(&self) -> &Self::Value;
    fn timestamp(&self) -> f64;
}

pub(crate) enum Resolved<'a, E> {
    Entry(&'a E),
    Data(PlainData),
    Builtin(&'static str),
    ObjectPrototype,
    Missing,
}
impl<'a, E> From<&'a RecordValue<E>> for Resolved<'a, E> {
    fn from(value: &'a RecordValue<E>) -> Self {
        match value {
            RecordValue::Entry(value) => Self::Entry(value),
            RecordValue::Data(value) => Self::Data(value.clone()),
            RecordValue::Builtin(name) => Self::Builtin(name),
            RecordValue::ObjectPrototype => Self::ObjectPrototype,
        }
    }
}
impl<E: Clone> Resolved<'_, E> {
    pub(crate) fn into_owned(self) -> Option<RecordValue<E>> {
        match self {
            Self::Entry(entry) => Some(RecordValue::Entry(entry.clone())),
            Self::Data(value) => Some(RecordValue::Data(value)),
            Self::Builtin(name) => Some(RecordValue::Builtin(name)),
            Self::ObjectPrototype => Some(RecordValue::ObjectPrototype),
            Self::Missing => None,
        }
    }
}
impl<'a, E: RecordEntry> Resolved<'a, E> {
    pub(crate) fn missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
    pub(crate) fn timestamp(&self) -> Result<f64, JsAccessError> {
        match self {
            Self::Entry(entry) => Ok(entry.timestamp()),
            Self::Data(value) => number(&property(value, E::TIMESTAMP_KEY)?),
            _ => Ok(f64::NAN),
        }
    }
    pub(crate) fn payload(self) -> Result<Option<JsRead<'a, E::Value>>, JsAccessError> {
        match self {
            Self::Entry(entry) => Ok(Some(JsRead::Stored(entry.payload()))),
            Self::Data(value) => match property(&value, "value")? {
                PlainData::Undefined => Ok(None),
                value => Ok(Some(JsRead::Projected(value))),
            },
            _ => Ok(None),
        }
    }
}
impl<E> JsRecord<E> {
    pub(crate) fn resolve(&self, key: &str) -> Result<Resolved<'_, E>, JsAccessError>
    where
        E: RecordEntry,
    {
        if let Some(value) = self.own.get(key) {
            return Ok(value.into());
        }
        if let Prototype::Injected(value) = &self.prototype {
            let inherited = match value.as_ref() {
                RecordValue::Entry(entry) if key == "value" => Some(plain(entry.payload())?),
                RecordValue::Entry(entry) if key == E::TIMESTAMP_KEY => {
                    Some(PlainData::Number(entry.timestamp()))
                }
                RecordValue::Data(PlainData::Object(values)) => values.get(key).cloned(),
                _ => None,
            };
            if let Some(value) = inherited {
                return Ok(Resolved::Data(value));
            }
        }
        if matches!(self.prototype, Prototype::Null) {
            return Ok(Resolved::Missing);
        }
        if key == "__proto__" {
            return Ok(match &self.prototype {
                Prototype::Object => Resolved::ObjectPrototype,
                Prototype::Injected(value) => value.as_ref().into(),
                Prototype::Null => Resolved::Missing,
            });
        }
        Ok(match builtin(key) {
            Some(name) => Resolved::Builtin(name),
            None => Resolved::Missing,
        })
    }
}

fn builtin(key: &str) -> Option<&'static str> {
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
        "toLocaleString",
    ]
    .into_iter()
    .find(|name| *name == key)
}

fn property(value: &PlainData, name: &str) -> Result<PlainData, JsAccessError> {
    match value {
        PlainData::Null | PlainData::Undefined => Err(JsAccessError::type_error(format!(
            "Cannot read properties of {} (reading '{name}')",
            if matches!(value, PlainData::Null) {
                "null"
            } else {
                "undefined"
            }
        ))),
        PlainData::Object(values) => Ok(values.get(name).cloned().unwrap_or(PlainData::Undefined)),
        _ => Ok(PlainData::Undefined),
    }
}

fn plain(value: &impl Serialize) -> Result<PlainData, JsAccessError> {
    fn convert(value: serde_value::Value) -> Result<PlainData, JsAccessError> {
        use serde_value::Value as V;
        Ok(match value {
            V::Unit | V::Option(None) => PlainData::Null,
            V::Option(Some(value)) | V::Newtype(value) => convert(*value)?,
            V::Bool(value) => PlainData::Bool(value),
            V::I8(value) => PlainData::Number(f64::from(value)),
            V::I16(value) => PlainData::Number(f64::from(value)),
            V::I32(value) => PlainData::Number(f64::from(value)),
            V::I64(value) => PlainData::Number(value as f64),
            V::U8(value) => PlainData::Number(f64::from(value)),
            V::U16(value) => PlainData::Number(f64::from(value)),
            V::U32(value) => PlainData::Number(f64::from(value)),
            V::U64(value) => PlainData::Number(value as f64),
            V::F32(value) => PlainData::Number(f64::from(value)),
            V::F64(value) => PlainData::Number(value),
            V::Char(value) => PlainData::String(value.to_string()),
            V::String(value) => PlainData::String(value),
            V::Bytes(values) => PlainData::Array(
                values
                    .into_iter()
                    .map(|value| PlainData::Number(f64::from(value)))
                    .collect(),
            ),
            V::Seq(values) => {
                PlainData::Array(values.into_iter().map(convert).collect::<Result<_, _>>()?)
            }
            V::Map(values) => PlainData::Object(
                values
                    .into_iter()
                    .map(|(key, value)| match key {
                        V::String(key) => Ok((key, convert(value)?)),
                        _ => Err(JsAccessError::type_error(
                            "JS data records require string keys",
                        )),
                    })
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
    convert(
        serde_value::to_value(value)
            .map_err(|error| JsAccessError::type_error(error.to_string()))?,
    )
}

fn number(value: &PlainData) -> Result<f64, JsAccessError> {
    Ok(match value {
        PlainData::Undefined => f64::NAN,
        PlainData::Null => 0.0,
        PlainData::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        PlainData::Number(value) => *value,
        PlainData::String(value) => string_number(value),
        PlainData::Array(_) => string_number(&string(value)?),
        PlainData::Object(values) => {
            if values.contains_key("toString") {
                return Err(JsAccessError::type_error(
                    "Cannot convert object to primitive value",
                ));
            }
            f64::NAN
        }
    })
}
fn string(value: &PlainData) -> Result<String, JsAccessError> {
    Ok(match value {
        PlainData::Undefined => "undefined".into(),
        PlainData::Null => "null".into(),
        PlainData::Bool(value) => value.to_string(),
        PlainData::Number(value) => {
            if *value == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format(*value).into()
            }
        }
        PlainData::String(value) => value.clone(),
        PlainData::Array(values) => values
            .iter()
            .map(|value| {
                if matches!(value, PlainData::Null | PlainData::Undefined) {
                    Ok(String::new())
                } else {
                    string(value)
                }
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        PlainData::Object(values) => {
            if values.contains_key("toString") {
                return Err(JsAccessError::type_error(
                    "Cannot convert object to primitive value",
                ));
            }
            "[object Object]".into()
        }
    })
}
fn string_number(value: &str) -> f64 {
    let value = value.trim_matches(|c| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000a}'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    });
    match value {
        "" => return 0.0,
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = if value.starts_with("0x") || value.starts_with("0X") {
        Some(16)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        Some(8)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        Some(2)
    } else {
        None
    };
    if let Some(radix) = radix {
        let digits = &value[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut bits = String::new();
        for digit in digits.chars() {
            let Some(digit) = digit.to_digit(radix) else {
                return f64::NAN;
            };
            let width = if radix == 16 {
                4
            } else if radix == 8 {
                3
            } else {
                1
            };
            bits.push_str(&format!("{digit:0width$b}"));
        }
        let bits = bits.trim_start_matches('0');
        if bits.len() > 1024 {
            return f64::INFINITY;
        }
        if bits.is_empty() {
            return 0.0;
        }
        let width = bits.len().min(53);
        let mut significand =
            u64::from_str_radix(&bits[..width], 2).expect("binary digits were validated");
        if bits.len() > width {
            let tail = &bits[width..];
            if tail.starts_with('1') && (tail[1..].contains('1') || significand % 2 == 1) {
                significand += 1;
            }
        }
        return libm::scalbn(significand as f64, (bits.len() - width) as i32);
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return f64::NAN;
    }
    value.parse().unwrap_or(f64::NAN)
}

struct JsonData<'a>(&'a PlainData);
impl Serialize for JsonData<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            PlainData::Null | PlainData::Undefined => serializer.serialize_none(),
            PlainData::Bool(value) => serializer.serialize_bool(*value),
            PlainData::Number(value) => serializer.serialize_f64(*value),
            PlainData::String(value) => serializer.serialize_str(value),
            PlainData::Array(values) => serializer.collect_seq(values.iter().map(JsonData)),
            PlainData::Object(values) => {
                let mut map = serializer.serialize_map(None)?;
                for (key, value) in values {
                    if !matches!(value, PlainData::Undefined) {
                        map.serialize_entry(key, &JsonData(value))?;
                    }
                }
                map.end()
            }
        }
    }
}
