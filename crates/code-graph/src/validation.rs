//! Schema issue data shared by configuration and external-input validators.
use crate::text::{JsObject, JsString, JsValue};
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PathSegment {
    Field(JsString),
    Index(usize),
}
#[derive(Debug, Clone)]
pub struct InputIssue {
    path: Vec<PathSegment>,
    message: JsString,
    details: JsObject,
}
impl InputIssue {
    pub fn new(path: Vec<PathSegment>, message: impl Into<JsString>) -> Self {
        Self {
            path,
            message: message.into(),
            details: JsObject::new(),
        }
    }
    pub fn path(&self) -> &[PathSegment] {
        &self.path
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
    pub fn details(&self) -> &JsObject {
        &self.details
    }
    pub fn with_details(mut self, mut details: JsObject) -> Self {
        details.shift_remove(&JsString::from("path"));
        details.shift_remove(&JsString::from("message"));
        self.details = details;
        self
    }
}
impl Serialize for InputIssue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = self.details.clone();
        object.insert(
            "path".into(),
            JsValue::Array(
                self.path
                    .iter()
                    .map(|part| match part {
                        PathSegment::Field(name) => JsValue::String(name.clone()),
                        PathSegment::Index(index) => JsValue::Number(*index as f64),
                    })
                    .collect(),
            ),
        );
        object.insert("message".into(), JsValue::String(self.message.clone()));
        JsValue::Object(object).serialize(serializer)
    }
}
impl std::fmt::Display for InputIssue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let path = self
            .path
            .iter()
            .map(|part| match part {
                PathSegment::Field(text) => text.to_lossy(),
                PathSegment::Index(index) => index.to_string(),
            })
            .collect::<Vec<_>>()
            .join(".");
        write!(
            formatter,
            "{}: {}",
            if path.is_empty() { "(root)" } else { &path },
            self.message.to_lossy()
        )
    }
}
impl std::error::Error for InputIssue {}
