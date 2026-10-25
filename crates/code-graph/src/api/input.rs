use crate::{
    config::issue_location,
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, RecordTypeError},
};

#[derive(Debug)]
pub struct ApiInputError {
    message: JsString,
}
impl ApiInputError {
    pub fn new(message: JsString) -> Self {
        Self { message }
    }
    pub fn name(&self) -> &'static str {
        "ApiInputError"
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
}
impl std::fmt::Display for ApiInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.to_lossy())
    }
}
impl std::error::Error for ApiInputError {}

#[derive(Debug)]
pub enum ApiSchemaError {
    Issues(Vec<InputIssue>),
    TypeError(RecordTypeError),
}
impl std::fmt::Display for ApiSchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issues(issues) => f.write_str(&issue_text(issues).to_lossy()),
            Self::TypeError(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for ApiSchemaError {}

#[derive(Debug)]
pub enum ApiError {
    Input(ApiInputError),
    TypeError(RecordTypeError),
    Io {
        path: JsString,
        source: std::io::Error,
    },
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input(error) => error.fmt(f),
            Self::TypeError(error) => error.fmt(f),
            Self::Io { path, source } => write!(f, "{}: {source}", path.to_lossy()),
        }
    }
}
impl std::error::Error for ApiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Input(error) => error,
            Self::TypeError(error) => error,
            Self::Io { source, .. } => source,
        })
    }
}

pub fn issue_text(issues: &[InputIssue]) -> JsString {
    let Some(issue) = issues.first() else {
        return "(root): parse error".into();
    };
    let mut out = issue_location(issue);
    out.push_str(": ");
    out.extend(issue.message());
    out
}
pub(crate) fn refusal(prefix: &str, error: ApiSchemaError) -> ApiError {
    match error {
        ApiSchemaError::TypeError(error) => ApiError::TypeError(error),
        ApiSchemaError::Issues(issues) => {
            let mut message = JsString::from(prefix);
            message.extend(&issue_text(&issues));
            ApiError::Input(ApiInputError::new(message))
        }
    }
}
pub(crate) fn nonempty_string(
    value: Option<&JsValue>,
    path: Vec<PathSegment>,
    message: &'static str,
    issues: &mut Vec<InputIssue>,
) -> Option<JsString> {
    let Some(JsValue::String(text)) = value else {
        issues.push(InputIssue::invalid_type(path, "string", value));
        return None;
    };
    if text.is_empty() {
        issues.push(minimum_string(path, message));
    }
    Some(text.clone())
}
fn minimum_string(path: Vec<PathSegment>, message: &'static str) -> InputIssue {
    InputIssue::new(path, message).with_details(JsObject::from([
        ("origin".into(), JsValue::String("string".into())),
        ("code".into(), JsValue::String("too_small".into())),
        ("minimum".into(), JsValue::Number(1.0)),
        ("inclusive".into(), JsValue::Bool(true)),
    ]))
}
pub(crate) fn record_key(
    key: &JsString,
    path: Vec<PathSegment>,
    message: &'static str,
    issues: &mut Vec<InputIssue>,
) -> bool {
    if !key.is_empty() {
        return true;
    }
    // Zod reports a failed record key without visiting that key's value.
    let nested = minimum_string(vec![], message);
    let nested = JsValue::parse(&serde_json::to_string(&nested).expect("issue is JSON data"))
        .expect("serialized issue is JSON data");
    issues.push(
        InputIssue::new(path, "Invalid key in record").with_details(JsObject::from([
            ("origin".into(), JsValue::String("record".into())),
            ("code".into(), JsValue::String("invalid_key".into())),
            ("issues".into(), JsValue::Array(vec![nested])),
        ])),
    );
    false
}
pub(crate) fn unknown_keys(
    object: &JsObject,
    allowed: &[&str],
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) {
    let keys = object_keys(object)
        .into_iter()
        .filter(|key| !allowed.iter().any(|allowed| *key == *allowed))
        .collect::<Vec<_>>();
    if !keys.is_empty() {
        issues.push(InputIssue::unrecognized_keys(path, &keys));
    }
}
