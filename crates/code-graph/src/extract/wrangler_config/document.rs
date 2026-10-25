use crate::text::{JsObject, JsString, JsValue, object_keys};
use crate::validation::{RecordTypeError, record_constructor_value};
use indexmap::IndexMap;
use serde::{
    Deserialize, Deserializer,
    de::{Error, MapAccess, Visitor},
};
use serde_json::value::RawValue;
use std::fmt;

pub(super) enum Document {
    Scalar(JsValue),
    Array(Vec<Document>),
    Object(DocumentObject),
    Date,
}
pub(super) struct DocumentObject {
    own: IndexMap<JsString, Document>,
    prototype: Prototype,
}
enum Prototype {
    Object,
    Null,
    Value(Box<Document>),
}
pub(super) enum Property<'a> {
    Value(&'a Document),
    ObjectConstructor,
    ArrayConstructor,
}
impl DocumentObject {
    fn new() -> Self {
        Self {
            own: IndexMap::new(),
            prototype: Prototype::Object,
        }
    }
    fn has_proto_setter(&self) -> bool {
        !self.own.contains_key(&JsString::from("__proto__"))
            && match &self.prototype {
                Prototype::Object => true,
                Prototype::Null => false,
                Prototype::Value(value) => match value.as_ref() {
                    Document::Object(object) => object.has_proto_setter(),
                    Document::Array(_) => true,
                    _ => false,
                },
            }
    }
    fn assign(&mut self, key: JsString, value: Document) {
        if key == "__proto__" && self.has_proto_setter() {
            match value {
                Document::Scalar(JsValue::Null) => self.prototype = Prototype::Null,
                value @ (Document::Object(_) | Document::Array(_)) => {
                    self.prototype = Prototype::Value(Box::new(value))
                }
                _ => {}
            }
        } else {
            self.own.insert(key, value);
        }
    }
    pub(super) fn entries(&self) -> impl Iterator<Item = (&JsString, &Document)> {
        object_keys(&self.own)
            .into_iter()
            .map(|key| (key, &self.own[key]))
    }
    fn property(&self, name: &str) -> Option<Property<'_>> {
        if let Some(value) = self.own.get(&JsString::from(name)) {
            return Some(Property::Value(value));
        }
        match &self.prototype {
            Prototype::Object if name == "constructor" => Some(Property::ObjectConstructor),
            Prototype::Object | Prototype::Null => None,
            Prototype::Value(value) => value.property(name),
        }
    }
}
impl Document {
    pub(super) fn object(&self) -> Option<&DocumentObject> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub(super) fn array(&self) -> Option<&[Self]> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub(super) fn string(&self) -> Option<&JsString> {
        if let Self::Scalar(JsValue::String(value)) = self {
            Some(value)
        } else {
            None
        }
    }
    pub(super) fn property(&self, name: &str) -> Option<Property<'_>> {
        match self {
            Self::Object(value) => value.property(name),
            Self::Array(_) if name == "constructor" => Some(Property::ArrayConstructor),
            _ => None,
        }
    }
    pub(super) fn get(&self, name: &str) -> Option<&Document> {
        match self.property(name)? {
            Property::Value(value) => Some(value),
            _ => None,
        }
    }
    pub(super) fn record(&self) -> Result<Option<&DocumentObject>, RecordTypeError> {
        let Some(object) = self.object() else {
            return Ok(None);
        };
        let plain = match self.property("constructor") {
            None => record_constructor_value(None)?,
            Some(Property::Value(Self::Scalar(JsValue::Null))) => {
                record_constructor_value(Some(&JsValue::Null))?
            }
            constructor => {
                let has_own = match constructor {
                    Some(Property::ObjectConstructor) => true,
                    Some(Property::Value(value)) => value
                        .get("prototype")
                        .and_then(Document::object)
                        .is_some_and(|prototype| {
                            prototype.own.contains_key(&JsString::from("isPrototypeOf"))
                        }),
                    _ => false,
                };
                let prototype: JsObject = if has_own {
                    [("isPrototypeOf".into(), JsValue::Null)]
                        .into_iter()
                        .collect()
                } else {
                    JsObject::new()
                };
                let projected = JsValue::Object(
                    [("prototype".into(), JsValue::Object(prototype))]
                        .into_iter()
                        .collect(),
                );
                record_constructor_value(Some(&projected))?
            }
        };
        Ok(plain.then_some(object))
    }
    pub(super) fn from_toml(value: toml::Value) -> Option<Self> {
        Some(match value {
            toml::Value::String(value) => Self::Scalar(JsValue::String(value.into())),
            toml::Value::Boolean(value) => Self::Scalar(JsValue::Bool(value)),
            toml::Value::Integer(value) => {
                if value.unsigned_abs() > 9_007_199_254_740_991 {
                    return None;
                }
                Self::Scalar(JsValue::Number(value as f64))
            }
            toml::Value::Float(value) => Self::Scalar(JsValue::Number(value)),
            toml::Value::Datetime(value) => {
                if value.time.is_some_and(|time| time.second == Some(60)) {
                    return None;
                }
                Self::Date
            }
            toml::Value::Array(values) => Self::Array(
                values
                    .into_iter()
                    .map(Self::from_toml)
                    .collect::<Option<_>>()?,
            ),
            toml::Value::Table(table) => {
                let mut object = DocumentObject::new();
                for (key, value) in table {
                    object.own.insert(key.into(), Self::from_toml(value)?);
                }
                Self::Object(object)
            }
        })
    }
}
struct ObjectVisitor;
impl<'de> Visitor<'de> for ObjectVisitor {
    type Value = Document;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSONC object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut object = DocumentObject::new();
        while let Some((key, value)) = map.next_entry()? {
            object.assign(key, value);
        }
        Ok(Document::Object(object))
    }
}
impl<'de> Deserialize<'de> for Document {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let raw = raw.get();
        match raw.as_bytes()[0] {
            b'{' => {
                let mut parser = serde_json::Deserializer::from_str(raw);
                parser.disable_recursion_limit();
                parser
                    .deserialize_map(ObjectVisitor)
                    .map_err(D::Error::custom)
            }
            b'[' => serde_json::from_str(raw)
                .map(Self::Array)
                .map_err(D::Error::custom),
            _ => JsValue::parse(raw)
                .map(Self::Scalar)
                .map_err(D::Error::custom),
        }
    }
}

pub(super) fn jsonc(raw: &str) -> Option<Document> {
    let mut bytes = raw.as_bytes().to_vec();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\\' {
                        index += 2;
                    } else if bytes[index] == b'"' {
                        index += 1;
                        break;
                    } else {
                        index += 1;
                    }
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                bytes[index] = b' ';
                bytes[index + 1] = b' ';
                index += 2;
                while index < bytes.len() && !b"\n\r".contains(&bytes[index]) {
                    bytes[index] = b' ';
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                bytes[index] = b' ';
                bytes[index + 1] = b' ';
                index += 2;
                loop {
                    if index + 1 >= bytes.len() {
                        return None;
                    }
                    if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                        bytes[index] = b' ';
                        bytes[index + 1] = b' ';
                        index += 2;
                        break;
                    }
                    if !b"\n\r".contains(&bytes[index]) {
                        bytes[index] = b' ';
                    }
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }
    index = 0;
    let mut previous = None;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\\' {
                        index += 2;
                    } else if bytes[index] == b'"' {
                        index += 1;
                        break;
                    } else {
                        index += 1;
                    }
                }
                previous = Some(b'"');
                continue;
            }
            b',' => {
                let next = bytes[index + 1..]
                    .iter()
                    .find(|byte| !b" \t\r\n".contains(byte));
                let ends_value = previous.is_some_and(|byte| {
                    byte == b'"'
                        || byte == b'}'
                        || byte == b']'
                        || byte == b'e'
                        || byte == b'l'
                        || byte.is_ascii_digit()
                });
                if ends_value && next.is_some_and(|byte| *byte == b'}' || *byte == b']') {
                    bytes[index] = b' ';
                }
                previous = Some(b',');
            }
            byte if !b" \t\r\n".contains(&byte) => previous = Some(byte),
            _ => {}
        }
        index += 1;
    }
    let text = String::from_utf8(bytes).ok()?;
    let mut parser = serde_json::Deserializer::from_str(&text);
    parser.disable_recursion_limit();
    let document = Document::deserialize(&mut parser).ok()?;
    parser.end().ok()?;
    Some(document)
}

pub(super) fn toml(raw: &str) -> Option<Document> {
    use toml_parser::parser::{Event, EventKind, parse_document};
    let source = toml_parser::Source::new(raw);
    let tokens = source.lex().into_vec();
    let mut replacements = Vec::new();
    let mut errors = Vec::new();
    parse_document(
        &tokens,
        &mut |event: Event| {
            if event.kind() != EventKind::Scalar || event.encoding().is_some() {
                return;
            }
            let span = event.span();
            let Some(text) = source.get(span) else {
                return;
            };
            let bytes = text.as_str().as_bytes();
            if bytes.len() >= 10
                && bytes[4] == b'-'
                && bytes[7] == b'-'
                && [0, 1, 2, 3, 5, 6, 8, 9]
                    .into_iter()
                    .all(|index| bytes[index].is_ascii_digit())
            {
                let month = (bytes[5] - b'0') * 10 + bytes[6] - b'0';
                let day = (bytes[8] - b'0') * 10 + bytes[9] - b'0';
                if (1..=12).contains(&month) && (1..=31).contains(&day) {
                    replacements.push(span.start() + 8);
                }
            }
        },
        &mut errors,
    );
    if !errors.is_empty() {
        return None;
    }
    // smol-toml's legacy Date normalizes calendar overflow; only the date's type is retained.
    let mut adjusted = raw.as_bytes().to_vec();
    for start in replacements {
        adjusted[start..start + 2].copy_from_slice(b"01");
    }
    let table = String::from_utf8(adjusted)
        .ok()?
        .parse::<toml::Table>()
        .ok()?;
    Document::from_toml(toml::Value::Table(table))
}
