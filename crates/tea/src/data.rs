use std::fmt;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug)]
pub enum PlainData {
    Null,
    Undefined,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Self>),
    Object(IndexMap<String, Self>),
}

impl From<&Value> for PlainData {
    fn from(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(value) => Self::Bool(*value),
            Value::Number(value) => Self::Number(value.as_f64().expect("JSON number fits f64")),
            Value::String(value) => Self::String(value.clone()),
            Value::Array(values) => Self::Array(values.iter().map(Self::from).collect()),
            Value::Object(values) => Self::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from(value)))
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
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
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
/// }
/// ```
pub trait Subscription: private::Sealed {
    fn id(&self) -> &SubId;
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
pub fn plain_data<T: Serialize>(value: &T) -> Result<PlainData, DependencyError> {
    use serde_value::Value as V;
    fn convert(value: V) -> Result<PlainData, DependencyError> {
        Ok(match value {
            V::Unit | V::Option(None) => PlainData::Null,
            V::Bool(value) => PlainData::Bool(value),
            V::String(value) => PlainData::String(value),
            V::Char(value) => PlainData::String(value.to_string()),
            V::U8(value) => PlainData::Number(f64::from(value)),
            V::U16(value) => PlainData::Number(f64::from(value)),
            V::U32(value) => PlainData::Number(f64::from(value)),
            V::U64(value) => PlainData::Number(value as f64),
            V::I8(value) => PlainData::Number(f64::from(value)),
            V::I16(value) => PlainData::Number(f64::from(value)),
            V::I32(value) => PlainData::Number(f64::from(value)),
            V::I64(value) => PlainData::Number(value as f64),
            V::F32(value) => PlainData::Number(f64::from(value)),
            V::F64(value) => PlainData::Number(value),
            V::Option(Some(value)) | V::Newtype(value) => convert(*value)?,
            V::Seq(values) => {
                PlainData::Array(values.into_iter().map(convert).collect::<Result<_, _>>()?)
            }
            V::Bytes(values) => PlainData::Array(
                values
                    .into_iter()
                    .map(|value| PlainData::Number(f64::from(value)))
                    .collect(),
            ),
            V::Map(values) => PlainData::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        let V::String(key) = key else {
                            return Err(DependencyError::ObjectKey);
                        };
                        Ok((key, convert(value)?))
                    })
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
    convert(serde_value::to_value(value).map_err(DependencyError::Serialization)?)
}
