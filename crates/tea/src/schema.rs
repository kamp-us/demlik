use crate::{
    PlainData,
    command::{Issue, SchemaError},
};

pub(crate) fn undefined_only(value: PlainData) -> Result<PlainData, SchemaError> {
    if matches!(value, PlainData::Undefined) {
        Ok(value)
    } else {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "expected no value",
        )]))
    }
}
