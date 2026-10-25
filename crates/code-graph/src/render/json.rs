use crate::text::{JsValue, object_keys};
use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};
use std::io::Write;

fn sort_keys(value: JsValue) -> JsValue {
    match value {
        JsValue::Array(values) => JsValue::Array(values.into_iter().map(sort_keys).collect()),
        JsValue::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            JsValue::Object(
                entries
                    .into_iter()
                    // Source sortKeys assigns into {}; __proto__ never becomes an own key.
                    .filter(|(key, _)| key != "__proto__")
                    .map(|(key, value)| (key, sort_keys(value)))
                    .collect(),
            )
        }
        value => value,
    }
}
fn pretty_value(
    value: &JsValue,
    formatter: &mut PrettyFormatter<'_>,
    out: &mut Vec<u8>,
) -> Result<(), serde_json::Error> {
    match value {
        JsValue::Array(values) => {
            formatter.begin_array(out).map_err(serde_json::Error::io)?;
            for (index, value) in values.iter().enumerate() {
                formatter
                    .begin_array_value(out, index == 0)
                    .map_err(serde_json::Error::io)?;
                pretty_value(value, formatter, out)?;
                formatter
                    .end_array_value(out)
                    .map_err(serde_json::Error::io)?;
            }
            formatter.end_array(out).map_err(serde_json::Error::io)?;
        }
        JsValue::Object(object) => {
            formatter.begin_object(out).map_err(serde_json::Error::io)?;
            for (index, key) in object_keys(object).into_iter().enumerate() {
                formatter
                    .begin_object_key(out, index == 0)
                    .map_err(serde_json::Error::io)?;
                out.write_all(&serde_json::to_vec(key)?)
                    .map_err(serde_json::Error::io)?;
                formatter
                    .end_object_key(out)
                    .map_err(serde_json::Error::io)?;
                formatter
                    .begin_object_value(out)
                    .map_err(serde_json::Error::io)?;
                pretty_value(&object[key], formatter, out)?;
                formatter
                    .end_object_value(out)
                    .map_err(serde_json::Error::io)?;
            }
            formatter.end_object(out).map_err(serde_json::Error::io)?;
        }
        value => out
            .write_all(&serde_json::to_vec(value)?)
            .map_err(serde_json::Error::io)?,
    }
    Ok(())
}
pub fn stable_stringify(value: &impl Serialize, pretty: bool) -> Result<String, serde_json::Error> {
    let normalized = sort_keys(JsValue::parse(&serde_json::to_string(value)?)?);
    if !pretty {
        return serde_json::to_string(&normalized);
    }
    let mut out = Vec::new();
    pretty_value(&normalized, &mut PrettyFormatter::new(), &mut out)?;
    Ok(String::from_utf8(out).expect("JSON values and formatter punctuation are UTF-8"))
}
