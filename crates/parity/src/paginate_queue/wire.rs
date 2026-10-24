use demlik_tea::{PlainData, data::JsText};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize)]
#[serde(untagged)]
pub enum Number {
    Finite(f64),
    Special {
        #[serde(rename = "$number")]
        value: Special,
    },
}
#[derive(Clone, Copy, Deserialize)]
pub enum Special {
    NaN,
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    #[serde(rename = "-0")]
    NegativeZero,
}
impl Number {
    pub fn value(self) -> f64 {
        match self {
            Self::Finite(value) => value,
            Self::Special {
                value: Special::NaN,
            } => f64::NAN,
            Self::Special {
                value: Special::Infinity,
            } => f64::INFINITY,
            Self::Special {
                value: Special::NegativeInfinity,
            } => f64::NEG_INFINITY,
            Self::Special {
                value: Special::NegativeZero,
            } => -0.0,
        }
    }
}
pub fn number(value: f64) -> Value {
    if value.is_nan() {
        json!({"$number":"NaN"})
    } else if value == f64::INFINITY {
        json!({"$number":"Infinity"})
    } else if value == f64::NEG_INFINITY {
        json!({"$number":"-Infinity"})
    } else if value == 0.0 && value.is_sign_negative() {
        json!({"$number":"-0"})
    } else {
        json!(value)
    }
}
pub fn text(value: &JsText) -> Value {
    value
        .as_utf8()
        .map_or_else(|| json!({"$utf16":value.as_units()}), |value| json!(value))
}
pub fn normalized(value: &PlainData) -> Value {
    match value {
        PlainData::Null => Value::Null,
        PlainData::Undefined => json!({"$undefined":true}),
        PlainData::Bool(value) => json!(value),
        PlainData::Number(value) => number(*value),
        PlainData::String(value) => text(value),
        PlainData::Array(values) => json!(values.iter().map(normalized).collect::<Vec<_>>()),
        PlainData::Object(values) if values.keys().all(|key| key.as_utf8().is_some()) => {
            Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.as_utf8().unwrap().to_owned(), normalized(value)))
                    .collect(),
            )
        }
        PlainData::Object(values) => {
            json!({"$object":values.iter().map(|(key,value)|json!([text(key),normalized(value)])).collect::<Vec<_>>()})
        }
    }
}
pub fn data(value: &Value) -> PlainData {
    if let Some(value) = value.as_object() {
        if value.len() == 1 {
            if value.get("$undefined") == Some(&Value::Bool(true)) {
                return PlainData::Undefined;
            }
            if let Some(raw) = value.get("$number") {
                let raw: Number =
                    serde_json::from_value(json!({"$number":raw})).expect("number protocol");
                return PlainData::Number(raw.value());
            }
            if let Some(raw) = value.get("$utf16") {
                return PlainData::String(JsText::from_units(
                    serde_json::from_value(raw.clone()).expect("UTF-16 protocol"),
                ));
            }
            if let Some(raw) = value.get("$object") {
                return PlainData::Object(
                    raw.as_array()
                        .expect("object entries")
                        .iter()
                        .map(|pair| {
                            let PlainData::String(key) = data(&pair[0]) else {
                                panic!("object key text")
                            };
                            (key, data(&pair[1]))
                        })
                        .collect(),
                );
            }
        }
        return PlainData::Object(
            value
                .iter()
                .map(|(key, value)| (key.into(), data(value)))
                .collect(),
        );
    }
    match value {
        Value::Array(values) => PlainData::Array(values.iter().map(data).collect()),
        _ => PlainData::from(value),
    }
}
pub fn snapshot(value: &impl serde::Serialize) -> Value {
    normalized(&demlik_tea::data::plain_data(value).expect("plain model"))
}
