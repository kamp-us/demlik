use std::fmt;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

mod encoder;
mod json;
pub use json::{JsText, JsonData, decode_json, stringify_json};

#[derive(Clone, Debug)]
pub enum PlainData {
    Null,
    Undefined,
    Bool(bool),
    Number(f64),
    String(JsText),
    Array(Vec<Self>),
    Object(IndexMap<JsText, Self>),
}

impl From<&Value> for PlainData {
    fn from(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(value) => Self::Bool(*value),
            Value::Number(value) => Self::Number(value.as_f64().expect("JSON number fits f64")),
            Value::String(value) => Self::String(value.clone().into()),
            Value::Array(values) => Self::Array(values.iter().map(Self::from).collect()),
            Value::Object(values) => Self::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone().into(), Self::from(value)))
                    .collect(),
            ),
        }
    }
}

pub fn structural_hash(value: &PlainData) -> String {
    match value {
        PlainData::Null => "null".into(),
        PlainData::Undefined => "undefined".into(),
        PlainData::Bool(value) => value.to_string(),
        PlainData::Number(value) => {
            if *value == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format(*value).to_owned()
            }
        }
        PlainData::String(value) => serde_json::to_string(value).expect("strings serialize"),
        PlainData::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(structural_hash)
                .collect::<Vec<_>>()
                .join(",")
        ),
        PlainData::Object(values) => {
            let mut keys = values
                .keys()
                .filter(|key| !matches!(values[*key], PlainData::Undefined))
                .collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_units().cmp(right.as_units()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("keys serialize"),
                        structural_hash(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn sub_id_of(kind: &str, deps: &PlainData) -> SubId {
    SubId(structural_hash(&PlainData::Object(IndexMap::from([
        ("type".into(), PlainData::String(kind.into())),
        ("deps".into(), deps.clone()),
    ]))))
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Deserialize, Serialize)]
#[serde(transparent)]
pub struct SubId(String);

impl SubId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SubId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

mod private {
    pub trait Sealed {}
}

/// Subscription identity is derived by the library's validated constructor.
///
/// ```compile_fail,E0277
/// use demlik_tea::{Subscription, SubId};
/// struct Forged;
/// impl Subscription for Forged {
///     fn id(&self) -> &SubId { unimplemented!() }
///     fn kind(&self) -> &str { "forged" }
/// }
/// ```
pub trait Subscription: private::Sealed {
    fn id(&self) -> &SubId;
    fn kind(&self) -> &str;
}

#[derive(Debug, Clone, Serialize)]
pub struct Sub<D = Value> {
    id: SubId,
    #[serde(rename = "type")]
    kind: String,
    deps: D,
}

impl<D: Serialize> Sub<D> {
    pub fn new(kind: impl Into<String>, deps: D) -> Result<Self, DependencyError> {
        let kind = kind.into();
        let id = sub_id_of(&kind, &plain_data(&deps)?);
        Ok(Self { id, kind, deps })
    }
}

impl<D> Sub<D> {
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn deps(&self) -> &D {
        &self.deps
    }
    pub fn into_parts(self) -> (SubId, String, D) {
        (self.id, self.kind, self.deps)
    }
}

impl<'de, D: serde::Deserialize<'de> + Serialize> serde::Deserialize<'de> for Sub<D> {
    fn deserialize<T: serde::Deserializer<'de>>(deserializer: T) -> Result<Self, T::Error> {
        #[derive(serde::Deserialize)]
        struct Wire<D> {
            id: SubId,
            #[serde(rename = "type")]
            kind: String,
            deps: D,
        }
        let wire = Wire::deserialize(deserializer)?;
        let sub = Self::new(wire.kind, wire.deps).map_err(serde::de::Error::custom)?;
        if wire.id != sub.id {
            return Err(serde::de::Error::custom(format!(
                "subscription identity mismatch: received {}, derived {}",
                wire.id, sub.id
            )));
        }
        Ok(sub)
    }
}

impl<D> private::Sealed for Sub<D> {}

impl<D> Subscription for Sub<D> {
    fn id(&self) -> &SubId {
        &self.id
    }
    fn kind(&self) -> &str {
        &self.kind
    }
}

#[derive(Debug)]
pub enum DependencyError {
    Serialization(serde_value::SerializerError),
    ObjectKey,
}
impl fmt::Display for DependencyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(error) => {
                write!(f, "cannot serialize subscription dependencies: {error}")
            }
            Self::ObjectKey => f.write_str("subscription dependency object keys must be strings"),
        }
    }
}
impl std::error::Error for DependencyError {}

/// Preserve floating-point dependency values before their JSON transport encoding.
pub fn plain_data<T: Serialize + ?Sized>(value: &T) -> Result<PlainData, DependencyError> {
    value.serialize(encoder::Encoder::new())
}
