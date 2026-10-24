mod file;
mod memory;
mod restore;
pub use file::execute as file;
pub use memory::execute as memory;
pub use restore::{execute as restore_case, schema};

use demlik_tea::{PlainData, data::JsText};
use serde_json::{Value, json};

pub fn text(value: &JsText) -> Value {
    match value.as_utf8() {
        Some(value) => json!(value),
        None => json!({ "$utf16": value.as_units() }),
    }
}
pub fn normalized(value: &PlainData) -> Value {
    match value {
        PlainData::Null => Value::Null,
        PlainData::Undefined => json!({ "$undefined": true }),
        PlainData::Bool(value) => json!(value),
        PlainData::Number(value) => super::encode_number(*value),
        PlainData::String(value) => text(value),
        PlainData::Array(values) => Value::Array(values.iter().map(normalized).collect()),
        PlainData::Object(values) if values.keys().all(|key| key.as_utf8().is_some()) => {
            Value::Object(
                values
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.as_utf8().expect("checked UTF-8 key").to_owned(),
                            normalized(value),
                        )
                    })
                    .collect(),
            )
        }
        PlainData::Object(values) => {
            json!({ "$object": values.iter().map(|(key, value)| json!([text(key), normalized(value)])).collect::<Vec<_>>() })
        }
    }
}
pub fn conflict(error: &demlik_tea::storage::StoreConflictError) -> Value {
    json!({ "name": error.name(), "_tag": error.tag(), "message": error.to_string(), "expectedVersion": super::encode_number(error.expected_version), "actualVersion": super::encode_number(error.actual_version) })
}
pub fn helpers(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    use demlik_tea::storage::{RestoreCause, StoreConflictError, StoreRefusedError};
    let reason = input["reason"].as_str().ok_or("reason is required")?;
    let refusal = observe!(calls, demlik_tea::storage::refuse, reason);
    let refused = StoreRefusedError {
        reason: reason.into(),
        cause: input.get("cause").cloned().map(RestoreCause::Load),
    };
    let expected: super::Number =
        serde_json::from_value(input["expected"].clone()).map_err(|error| error.to_string())?;
    let actual: super::Number =
        serde_json::from_value(input["actual"].clone()).map_err(|error| error.to_string())?;
    let conflict = StoreConflictError {
        expected_version: expected.value(),
        actual_version: actual.value(),
    };
    let _ = observe!(
        calls,
        demlik_tea::storage::StoreRefusedError::name,
        &refused
    );
    let _ = observe!(calls, demlik_tea::storage::StoreRefusedError::tag, &refused);
    let _ = observe!(
        calls,
        demlik_tea::storage::StoreConflictError::name,
        &conflict
    );
    let _ = observe!(
        calls,
        demlik_tea::storage::StoreConflictError::tag,
        &conflict
    );
    Ok(json!({ "refusal": refusal, "refused": refused, "conflict": self::conflict(&conflict) }))
}
pub fn data(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input = input
        .get("json")
        .and_then(Value::as_str)
        .ok_or("json text is required")?;
    let data =
        observe!(calls, demlik_tea::data::decode_json, input).map_err(|error| error.to_string())?;
    let stringified = observe!(calls, demlik_tea::data::stringify_json, &data);
    let hash = observe!(calls, demlik_tea::data::structural_hash, &data);
    let sub_id = observe!(calls, demlik_tea::data::sub_id_of, "pulse", &data);
    Ok(json!({ "value": normalized(&data), "json": stringified, "hash": hash, "subId": sub_id }))
}
