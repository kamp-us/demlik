use crate::{
    PlainData,
    data::JsText,
    js_record::{self, JsAccessError},
};

/// The host identifies actual errors; a message-shaped plain record remains a value.
pub enum ErrorView<'a> {
    ErrorMessage(&'a JsText),
    Value(&'a PlainData),
}

pub fn describe_error(error: ErrorView<'_>) -> Result<JsText, JsAccessError> {
    match error {
        ErrorView::ErrorMessage(message) => Ok(message.clone()),
        ErrorView::Value(value) => js_record::string(value),
    }
}
