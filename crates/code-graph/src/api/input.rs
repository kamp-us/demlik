use crate::{
    config::issue_location,
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, RecordTypeError},
};

#[derive(Debug)]
pub struct ApiInputError {
    message: JsString,
    cause: Option<Box<dyn std::error::Error + Send>>,
}
impl ApiInputError {
    pub fn new(message: JsString) -> Self {
        Self {
            message,
            cause: None,
        }
    }
    pub fn with_cause(mut self, cause: impl std::error::Error + Send + 'static) -> Self {
        self.cause = Some(Box::new(cause));
        self
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
impl std::error::Error for ApiInputError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_ref().map(|cause| cause.as_ref() as _)
    }
}

#[derive(Debug)]
pub struct ApiCallbackError {
    message: JsString,
    cause: Option<Box<dyn std::error::Error + Send>>,
}
impl ApiCallbackError {
    pub fn new(message: JsString) -> Self {
        Self {
            message,
            cause: None,
        }
    }
    pub fn with_cause(mut self, cause: impl std::error::Error + Send + 'static) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }
    pub fn name(&self) -> &'static str {
        "Error"
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
}
impl std::fmt::Display for ApiCallbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.to_lossy())
    }
}
impl std::error::Error for ApiCallbackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_ref().map(|cause| cause.as_ref() as _)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiArgumentLocation {
    Argument(usize),
    WorkingDirectory,
    Path,
    SymlinkTarget,
}
impl ApiArgumentLocation {
    pub fn label(self) -> String {
        match self {
            Self::Argument(index) => format!("args[{index}]"),
            Self::WorkingDirectory => "options.cwd".into(),
            Self::Path => "path".into(),
            Self::SymlinkTarget => "target".into(),
        }
    }
}
#[derive(Debug)]
pub struct ApiArgumentError {
    argument: JsString,
    location: ApiArgumentLocation,
    cause: std::io::Error,
    message: JsString,
}
impl ApiArgumentError {
    /// Classify a native spawn refusal using the pinned Node validation order:
    /// first argument containing NUL, then cwd. No process is launched here.
    pub fn from_null_byte(
        cwd: &JsString,
        arguments: &[JsString],
        cause: std::io::Error,
    ) -> Result<Self, std::io::Error> {
        let selected = arguments
            .iter()
            .enumerate()
            .find(|(_, value)| value.units().contains(&0))
            .map(|(index, value)| (ApiArgumentLocation::Argument(index), value))
            .or_else(|| {
                cwd.units()
                    .contains(&0)
                    .then_some((ApiArgumentLocation::WorkingDirectory, cwd))
            });
        let Some((location, argument)) = selected else {
            return Err(cause);
        };
        Ok(Self::null_value(location, argument, cause))
    }
    pub fn from_null_path(
        argument: &JsString,
        cause: std::io::Error,
    ) -> Result<Self, std::io::Error> {
        if !argument.units().contains(&0) {
            return Err(cause);
        }
        Ok(Self::null_value(ApiArgumentLocation::Path, argument, cause))
    }
    pub fn from_null_symlink(
        target: &JsString,
        destination: &JsString,
        cause: std::io::Error,
    ) -> Result<Self, std::io::Error> {
        if target.units().contains(&0) {
            return Ok(Self::null_value(
                ApiArgumentLocation::SymlinkTarget,
                target,
                cause,
            ));
        }
        Self::from_null_path(destination, cause)
    }
    fn null_value(
        location: ApiArgumentLocation,
        argument: &JsString,
        cause: std::io::Error,
    ) -> Self {
        // Keep the actual native diagnostic instead of recreating Node's util.inspect.
        let message = format!(
            "{} contains a null byte (native argument diagnostic: {cause})",
            location.label()
        )
        .into();
        Self {
            argument: argument.clone(),
            location,
            cause,
            message,
        }
    }
    pub fn argument(&self) -> &JsString {
        &self.argument
    }
    pub fn location(&self) -> ApiArgumentLocation {
        self.location
    }
    pub fn code(&self) -> &'static str {
        "ERR_INVALID_ARG_VALUE"
    }
    pub fn name(&self) -> &'static str {
        "TypeError"
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
}
impl std::fmt::Display for ApiArgumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.to_lossy())
    }
}
impl std::error::Error for ApiArgumentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

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
    Callback(ApiCallbackError),
    Argument(ApiArgumentError),
    TypeError(RecordTypeError),
    Io {
        path: JsString,
        source: std::io::Error,
    },
    Symlink {
        path: JsString,
        destination: JsString,
        source: std::io::Error,
    },
    Compiler(crate::engine::tsgo::TsgoError),
    OperationAndCleanup {
        operation: Box<Self>,
        cleanup: Box<Self>,
    },
}
impl ApiError {
    pub fn visible(&self) -> &Self {
        match self {
            Self::OperationAndCleanup { cleanup, .. } => cleanup.visible(),
            error => error,
        }
    }
    pub fn is_input(&self) -> bool {
        matches!(self.visible(), Self::Input(_))
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Input(error) => error.name(),
            Self::Callback(error) => error.name(),
            Self::Argument(error) => error.name(),
            Self::TypeError(error) => error.name(),
            Self::OperationAndCleanup { cleanup, .. } => cleanup.name(),
            Self::Io { .. } | Self::Symlink { .. } | Self::Compiler(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Input(error) => error.message().clone(),
            Self::Callback(error) => error.message().clone(),
            Self::Argument(error) => error.message().clone(),
            Self::TypeError(error) => error.message().clone(),
            Self::Io { source, .. } | Self::Symlink { source, .. } => source.to_string().into(),
            Self::Compiler(error) => error.to_string().into(),
            Self::OperationAndCleanup { cleanup, .. } => cleanup.message(),
        }
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input(error) => error.fmt(f),
            Self::Callback(error) => error.fmt(f),
            Self::Argument(error) => error.fmt(f),
            Self::TypeError(error) => error.fmt(f),
            Self::Io { path, source } => write!(f, "{}: {source}", path.to_lossy()),
            Self::Symlink {
                path,
                destination,
                source,
            } => write!(
                f,
                "symlink {} -> {}: {source}",
                path.to_lossy(),
                destination.to_lossy()
            ),
            Self::Compiler(error) => error.fmt(f),
            Self::OperationAndCleanup { operation, cleanup } => {
                write!(f, "{operation}; temporary cleanup also failed: {cleanup}")
            }
        }
    }
}
impl std::error::Error for ApiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Input(error) => error,
            Self::Callback(error) => error,
            Self::Argument(error) => error,
            Self::TypeError(error) => error,
            Self::Io { source, .. } | Self::Symlink { source, .. } => source,
            Self::Compiler(error) => error,
            Self::OperationAndCleanup { operation, .. } => operation.as_ref(),
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
