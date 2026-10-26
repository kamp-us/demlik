//! Schema issue data shared by configuration and external-input validators.
use crate::text::{JsObject, JsString, JsValue};
use serde::{Serialize, Serializer};

pub(crate) enum NumberCheck {
    Integer { minimum: f64, maximum: Option<f64> },
    Number { minimum: f64, maximum: Option<f64> },
}

// The numeric checks used by the frozen Thresholds and CollapseSettings schemas.
// Keep safe-int format failures before the schemas' explicit range checks.
pub(crate) fn checked_number(
    value: &JsValue,
    path: Vec<PathSegment>,
    check: NumberCheck,
) -> Result<f64, InputIssue> {
    let JsValue::Number(number) = value else {
        return Err(InputIssue::invalid_type(path, "number", Some(value)));
    };
    if !number.is_finite() {
        return Err(InputIssue::invalid_type(path, "number", Some(value)));
    }
    let (integer, minimum, maximum) = match check {
        NumberCheck::Integer { minimum, maximum } => (true, minimum, maximum),
        NumberCheck::Number { minimum, maximum } => (false, minimum, maximum),
    };
    if integer {
        if number.fract() != 0.0 {
            let mut issue = InputIssue::invalid_type(path, "int", Some(value));
            issue
                .details
                .insert("format".into(), JsValue::String("safeint".into()));
            return Err(issue);
        }
        const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
        if number.abs() > MAX_SAFE {
            let too_big = *number > 0.0;
            let limit = if too_big { MAX_SAFE } else { -MAX_SAFE };
            return Err(InputIssue::new(
                path,
                format!(
                    "Too {}: expected int to be {}{}",
                    if too_big { "big" } else { "small" },
                    if too_big { "<" } else { ">" },
                    crate::render::text::number(limit)
                ),
            )
            .with_details(JsObject::from([
                (
                    "code".into(),
                    JsValue::String(if too_big { "too_big" } else { "too_small" }.into()),
                ),
                (
                    if too_big { "maximum" } else { "minimum" }.into(),
                    JsValue::Number(limit),
                ),
                (
                    "note".into(),
                    JsValue::String("Integers must be within the safe integer range.".into()),
                ),
                ("origin".into(), JsValue::String("int".into())),
            ])));
        }
    }
    let (limit, too_big) = if *number < minimum {
        (minimum, false)
    } else if let Some(maximum) = maximum.filter(|maximum| *number > *maximum) {
        (maximum, true)
    } else {
        return Ok(*number);
    };
    Err(InputIssue::new(
        path,
        format!(
            "Too {}: expected number to be {}{}",
            if too_big { "big" } else { "small" },
            if too_big { "<=" } else { ">=" },
            crate::render::text::number(limit)
        ),
    )
    .with_details(JsObject::from([
        ("origin".into(), JsValue::String("number".into())),
        (
            "code".into(),
            JsValue::String(if too_big { "too_big" } else { "too_small" }.into()),
        ),
        (
            if too_big { "maximum" } else { "minimum" }.into(),
            JsValue::Number(limit),
        ),
        ("inclusive".into(), JsValue::Bool(true)),
    ])))
}

pub(crate) fn nonempty_string(
    value: Option<&JsValue>,
    path: Vec<PathSegment>,
) -> Result<&JsString, InputIssue> {
    let Some(JsValue::String(text)) = value else {
        return Err(InputIssue::invalid_type(path, "string", value));
    };
    if text.is_empty() {
        return Err(
            InputIssue::new(path, "Too small: expected string to have >=1 characters")
                .with_details(JsObject::from([
                    ("origin".into(), JsValue::String("string".into())),
                    ("code".into(), JsValue::String("too_small".into())),
                    ("minimum".into(), JsValue::Number(1.0)),
                    ("inclusive".into(), JsValue::Bool(true)),
                ])),
        );
    }
    Ok(text)
}

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
    pub(crate) fn invalid_type(
        path: Vec<PathSegment>,
        expected: &str,
        value: Option<&JsValue>,
    ) -> Self {
        let received = match value {
            None => "undefined",
            Some(JsValue::Null) => "null",
            Some(JsValue::Bool(_)) => "boolean",
            Some(JsValue::Number(number)) if number.is_nan() => "NaN",
            Some(JsValue::Number(_)) => "number",
            Some(JsValue::String(_)) => "string",
            Some(JsValue::Array(_)) => "array",
            Some(JsValue::Object(_)) => "object",
        };
        let mut details = JsObject::from([
            ("expected".into(), JsValue::String(expected.into())),
            ("code".into(), JsValue::String("invalid_type".into())),
        ]);
        if expected == "number"
            && let Some(JsValue::Number(number)) = value
            && !number.is_finite()
        {
            details.insert(
                "received".into(),
                JsValue::String(if number.is_nan() { "NaN" } else { "Infinity" }.into()),
            );
        }
        Self::new(
            path,
            format!("Invalid input: expected {expected}, received {received}"),
        )
        .with_details(details)
    }
    pub(crate) fn unrecognized_keys(path: Vec<PathSegment>, keys: &[&JsString]) -> Self {
        let mut message = JsString::from(if keys.len() == 1 {
            "Unrecognized key: "
        } else {
            "Unrecognized keys: "
        });
        for (index, key) in keys.iter().enumerate() {
            if index > 0 {
                message.push_str(", ");
            }
            message.push_str("\"");
            message.extend(key);
            message.push_str("\"");
        }
        Self::new(path, message).with_details(JsObject::from([
            ("code".into(), JsValue::String("unrecognized_keys".into())),
            (
                "keys".into(),
                JsValue::Array(
                    keys.iter()
                        .map(|key| JsValue::String((*key).clone()))
                        .collect(),
                ),
            ),
        ]))
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

#[derive(Debug, Serialize)]
pub struct RecordTypeError {
    name: &'static str,
    message: JsString,
}
impl RecordTypeError {
    pub fn name(&self) -> &'static str {
        self.name
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
}
impl std::fmt::Display for RecordTypeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message.to_lossy())
    }
}
impl std::error::Error for RecordTypeError {}

/// Zod's plain-record constructor predicate under the pinned pristine-builtins profile.
pub fn record_constructor_value(constructor: Option<&JsValue>) -> Result<bool, RecordTypeError> {
    match constructor {
        None => Ok(true),
        Some(JsValue::Null) => Err(RecordTypeError {
            name: "TypeError",
            message: "Cannot read properties of null (reading 'prototype')".into(),
        }),
        Some(value) => Ok(value
            .get("prototype")
            .and_then(JsValue::as_object)
            .is_some_and(|prototype| prototype.contains_key(&JsString::from("isPrototypeOf")))),
    }
}
pub fn record_object(value: &JsValue) -> Result<Option<&JsObject>, RecordTypeError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    // An unmodified ordinary object's Object constructor has the required prototype.
    let plain = match object.get(&JsString::from("constructor")) {
        Some(value) => record_constructor_value(Some(value))?,
        None => true,
    };
    Ok(plain.then_some(object))
}
