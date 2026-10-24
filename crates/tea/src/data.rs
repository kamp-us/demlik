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
pub struct SubId(pub String);

impl fmt::Display for SubId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

pub trait Subscription {
    fn id(&self) -> &SubId;
}

#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct Sub<D = Value> {
    pub id: SubId,
    #[serde(rename = "type")]
    pub kind: String,
    pub deps: D,
}

impl Sub<Value> {
    pub fn new(kind: impl Into<String>, deps: Value) -> Self {
        let kind = kind.into();
        let id = sub_id_of(&kind, &PlainData::from(&deps));
        Self { id, kind, deps }
    }
}

impl<D> Subscription for Sub<D> {
    fn id(&self) -> &SubId {
        &self.id
    }
}
