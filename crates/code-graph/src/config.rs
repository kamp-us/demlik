//! File decoding and refusal text shared by the source config entry points.
use crate::{
    text::{JsString, JsValue},
    validation::{InputIssue, PathSegment},
};
use std::{fs, path::Path};

pub(crate) enum ConfigFile<'a> {
    Native(&'a Path),
    Text(&'a JsString),
}
pub(crate) fn read_config(file: ConfigFile<'_>) -> Result<JsValue, JsString> {
    let (file, bytes) = match file {
        ConfigFile::Native(path) => (
            JsString::from(path.to_string_lossy().as_ref()),
            fs::read(path),
        ),
        ConfigFile::Text(text) => (text.clone(), fs::read(text.to_lossy())),
    };
    let bytes = bytes.map_err(|_| {
        let mut message = JsString::from("cannot read config file \"");
        message.extend(&file);
        message.push_str("\".");
        message
    })?;
    JsValue::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| {
        let mut message = JsString::from("config file \"");
        message.extend(&file);
        message.push_str("\" is not valid JSON.");
        message
    })
}
pub(crate) fn issue_location(issue: &InputIssue) -> JsString {
    let mut location = JsString::default();
    for (index, part) in issue.path().iter().enumerate() {
        if index > 0 {
            location.push_str(".");
        }
        match part {
            PathSegment::Field(field) => location.extend(field),
            PathSegment::Index(index) => location.push_str(&index.to_string()),
        }
    }
    if location.is_empty() {
        location.push_str("(root)");
    }
    location
}
pub(crate) fn invalid_config(file: &JsString, issue: &InputIssue) -> JsString {
    let mut message = JsString::from("invalid config in \"");
    message.extend(file);
    message.push_str("\": ");
    message.extend(&issue_location(issue));
    message.push_str(": ");
    message.extend(issue.message());
    message.push_str(".");
    message
}
