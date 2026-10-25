use demlik_code_graph::{
    api::{
        cli::{ApiFlags, ApiHost, ApiRun},
        diff::BaseMapStep,
        map::{ApiCallbackError, ApiError, ApiInputError},
        model::ApiDiff,
        view::PublishedApiOptions,
    },
    engine::tsgo::TsgoBinary,
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    cell::RefCell,
    error::Error,
    fs,
    io::{self, BufRead, Write},
    path::Path,
    rc::Rc,
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};}
fn present_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<JsString>, D::Error> {
    JsString::deserialize(d).map(Some)
}
fn present_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<JsValue>, D::Error> {
    JsValue::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsString,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailureSpec {
    kind: String,
    message: JsString,
}
impl FailureSpec {
    fn error(&self) -> Result<ApiError, String> {
        Ok(match self.kind.as_str() {
            "input" => ApiError::Input(ApiInputError::new(self.message.clone())),
            "callback" => ApiError::Callback(ApiCallbackError::new(self.message.clone())),
            "cleanup-input" => ApiError::OperationAndCleanup {
                operation: Box::new(ApiError::Callback(ApiCallbackError::new(
                    "first failure".into(),
                ))),
                cleanup: Box::new(ApiError::Input(ApiInputError::new(self.message.clone()))),
            },
            _ => return Err("unsupported failure kind".into()),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BaseMapSpec {
    kind: String,
    #[serde(default, deserialize_with = "present_string")]
    file: Option<JsString>,
    #[serde(default, deserialize_with = "present_value")]
    value: Option<JsValue>,
    failure: Option<FailureSpec>,
    #[serde(default)]
    awaited: bool,
    #[serde(default)]
    readonly: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiffInput {
    root: JsString,
    map: JsValue,
    base: JsString,
    #[serde(default, deserialize_with = "present_string")]
    repo_root: Option<JsString>,
    base_map: Option<BaseMapSpec>,
    warn_failure: Option<FailureSpec>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModeInput {
    root: JsString,
    #[serde(default, deserialize_with = "present_string")]
    map_file: Option<JsString>,
    #[serde(default, deserialize_with = "present_string")]
    base: Option<JsString>,
    #[serde(default, deserialize_with = "present_string")]
    policy_file: Option<JsString>,
    given: Vec<JsString>,
    json: bool,
    pretty: bool,
    entry: String,
    emit_failure: Option<FailureSpec>,
    report_failure: Option<FailureSpec>,
    #[serde(default, deserialize_with = "present_string")]
    out_file: Option<JsString>,
}
#[derive(Serialize)]
struct ErrorView {
    name: &'static str,
    message: JsString,
}
fn error_view(error: &ApiError) -> ErrorView {
    ErrorView {
        name: error.name(),
        message: error.message(),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorData {
    variant: &'static str,
    visible: ErrorView,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<Box<ErrorData>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleanup: Option<Box<ErrorData>>,
    causes: Vec<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<JsString>,
}
fn error_data(error: &ApiError) -> ErrorData {
    let mut source = error.source();
    let mut causes = Vec::new();
    while let Some(cause) = source {
        causes.push(cause.to_string().into());
        source = cause.source();
    }
    let (variant, operation, cleanup) = match error {
        ApiError::Input(_) => ("input", None, None),
        ApiError::Callback(_) => ("callback", None, None),
        ApiError::Io { .. } => ("io", None, None),
        ApiError::TypeError(_) => ("type", None, None),
        ApiError::Compiler(_) => ("compiler", None, None),
        ApiError::OperationAndCleanup { operation, cleanup } => (
            "compound",
            Some(Box::new(error_data(operation))),
            Some(Box::new(error_data(cleanup))),
        ),
        _ => ("other", None, None),
    };
    let (path, destination) = match error {
        ApiError::Io { path, .. } => (Some(path.clone()), None),
        ApiError::Symlink {
            path, destination, ..
        } => (Some(path.clone()), Some(destination.clone())),
        _ => (None, None),
    };
    ErrorData {
        variant,
        visible: error_view(error),
        operation,
        cleanup,
        causes,
        path,
        destination,
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BaseMapTrace {
    calls: usize,
    outside_checkout: Vec<bool>,
    exists_after: Vec<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<ApiDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorView>,
    warnings: Vec<JsString>,
    base_map: BaseMapTrace,
}
async fn base_map(
    root: &JsString,
    spec: &BaseMapSpec,
    roots: &Rc<RefCell<Vec<JsString>>>,
) -> Result<JsValue, ApiError> {
    roots.borrow_mut().push(root.clone());
    if spec.awaited {
        tokio::task::yield_now().await;
    }
    #[cfg(unix)]
    if spec.readonly {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.to_lossy(), fs::Permissions::from_mode(0o555)).map_err(
            |source| ApiError::Io {
                path: root.clone(),
                source,
            },
        )?;
    }
    match spec.kind.as_str() {
        "value" => Ok(spec.value.clone().unwrap_or(JsValue::Null)),
        "fail" => Err(spec
            .failure
            .as_ref()
            .expect("validated failure")
            .error()
            .expect("validated kind")),
        "file" => {
            let mut file = root.clone();
            file.push_str("/");
            file.extend(spec.file.as_ref().expect("validated file"));
            let bytes = if spec.awaited {
                tokio::fs::read(file.to_lossy()).await
            } else {
                fs::read(file.to_lossy())
            }
            .map_err(|source| ApiError::Io {
                path: file.clone(),
                source,
            })?;
            JsValue::parse(&String::from_utf8_lossy(&bytes)).map_err(|cause| {
                ApiError::Callback(
                    ApiCallbackError::new(cause.to_string().into()).with_cause(cause),
                )
            })
        }
        _ => unreachable!("validated base map kind"),
    }
}
fn validate_map(spec: &BaseMapSpec) -> Result<(), String> {
    match spec.kind.as_str() {
        "value" => {
            if spec.value.is_none() {
                return Err("value map needs value".into());
            }
        }
        "file" => {
            if spec.file.is_none() {
                return Err("file map needs file".into());
            }
        }
        "fail" => {
            spec.failure
                .as_ref()
                .ok_or("failed map needs failure")?
                .error()?;
        }
        _ => return Err("unsupported base map kind".into()),
    }
    Ok(())
}
async fn diff(
    input: DiffInput,
    compiler: &TsgoBinary,
    calls: &mut Vec<&'static str>,
    details: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    if let Some(spec) = &input.base_map {
        validate_map(spec)?;
    }
    if let Some(failure) = &input.warn_failure {
        failure.error()?;
    }
    let warnings = Rc::new(RefCell::new(Vec::new()));
    let recorded = Rc::clone(&warnings);
    let roots = Rc::new(RefCell::new(Vec::new()));
    let mut warn = |line: &JsString| {
        recorded.borrow_mut().push(line.clone());
        if let Some(failure) = &input.warn_failure {
            Err(failure.error().expect("validated failure"))
        } else {
            Ok(())
        }
    };
    let options = PublishedApiOptions {
        repo_root: input.repo_root.as_ref(),
        warn: Some(&mut warn),
    };
    let value = if let Some(spec) = &input.base_map {
        let prepared = observe!(
            calls,
            demlik_code_graph::api::diff::prepare_api_diff_with_base_map_blocking,
            &input.root,
            &input.map,
            &input.base,
            compiler,
            options
        );
        match prepared {
            Err(error) => Err(error),
            Ok(BaseMapStep::Complete(value)) => Ok(value),
            Ok(BaseMapStep::Awaiting(request)) => {
                let value = base_map(request.root(), spec, &roots).await;
                observe!(
                    calls,
                    demlik_code_graph::api::diff::BaseMapRequest::finish_blocking,
                    request,
                    value
                )
            }
        }
    } else {
        observe!(
            calls,
            demlik_code_graph::api::diff::diff_published_api_blocking,
            &input.root,
            &input.map,
            &input.base,
            compiler,
            options
        )
    };
    let (value, error) = match value {
        Ok(value) => (Some(value), None),
        Err(error) => {
            *details = Some(to_raw_value(&error_data(&error)).map_err(|e| e.to_string())?);
            (None, Some(error_view(&error)))
        }
    };
    let roots = roots.borrow();
    let base_map = BaseMapTrace {
        calls: roots.len(),
        outside_checkout: roots
            .iter()
            .map(|root| !Path::new(&root.to_lossy()).starts_with(input.root.to_lossy()))
            .collect(),
        exists_after: roots
            .iter()
            .map(|root| Path::new(&root.to_lossy()).exists())
            .collect(),
    };
    to_raw_value(&DiffOutput {
        value,
        error,
        warnings: warnings.borrow().clone(),
        base_map,
    })
    .map_err(|e| e.to_string())
}
#[derive(Serialize)]
struct Event {
    kind: &'static str,
    message: JsString,
}
#[derive(Serialize)]
struct ModeOutput {
    code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorView>,
    events: Vec<Event>,
}
#[derive(Serialize)]
struct ModeFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    processing: Option<ErrorData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<ErrorData>,
}
fn mode(
    input: ModeInput,
    compiler: &TsgoBinary,
    calls: &mut Vec<&'static str>,
    details: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    if let Some(failure) = &input.emit_failure {
        failure.error()?;
    }
    if let Some(failure) = &input.report_failure {
        failure.error()?;
    }
    let events = Rc::new(RefCell::new(Vec::new()));
    let emitted = Rc::clone(&events);
    let reported = Rc::clone(&events);
    let mut emit = |line: &JsString| {
        emitted.borrow_mut().push(Event {
            kind: "emit",
            message: line.clone(),
        });
        if let Some(failure) = &input.emit_failure {
            return Err(failure.error().expect("validated"));
        }
        if let Some(file) = &input.out_file {
            fs::write(file.to_lossy(), line.to_lossy()).map_err(|source| ApiError::Io {
                path: file.clone(),
                source,
            })?;
        }
        Ok(())
    };
    let mut report = |line: &JsString| {
        reported.borrow_mut().push(Event {
            kind: "report",
            message: line.clone(),
        });
        if let Some(failure) = &input.report_failure {
            Err(failure.error().expect("validated"))
        } else {
            Ok(())
        }
    };
    let host = ApiHost {
        root_absolute: &input.root,
        given: &input.given,
        json: input.json,
        pretty: input.pretty,
        emit: &mut emit,
        report: &mut report,
    };
    let result = match input.entry.as_str() {
        "flags" => observe!(
            calls,
            demlik_code_graph::api::cli::run_api_flags_blocking,
            ApiFlags {
                api: input.map_file.as_ref(),
                api_base: input.base.as_ref(),
                api_policy: input.policy_file.as_ref()
            },
            host,
            compiler
        ),
        "view" => observe!(
            calls,
            demlik_code_graph::api::cli::run_api_view_blocking,
            ApiRun {
                host,
                map_file: input.map_file.as_ref().ok_or("view needs mapFile")?,
                base: input.base.as_ref(),
                policy_file: input.policy_file.as_ref()
            },
            compiler
        )
        .map(Some),
        _ => return Err("unsupported mode entry".into()),
    };
    let (code, error) = match result {
        Ok(result) => {
            let code = result.as_ref().map(|outcome| outcome.exit.code());
            if let Some(failure) = result.and_then(|outcome| outcome.failure) {
                *details = Some(
                    to_raw_value(&ModeFailure {
                        processing: Some(error_data(&failure)),
                        report: None,
                    })
                    .map_err(|e| e.to_string())?,
                );
            }
            (code, None)
        }
        Err(failure) => {
            let view = error_view(&failure.report);
            *details = Some(
                to_raw_value(&ModeFailure {
                    processing: failure.processing.as_deref().map(error_data),
                    report: Some(error_data(&failure.report)),
                })
                .map_err(|e| e.to_string())?,
            );
            (None, Some(view))
        }
    };
    let events = std::mem::take(&mut *events.borrow_mut());
    to_raw_value(&ModeOutput {
        code,
        error,
        events,
    })
    .map_err(|e| e.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<JsString>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsString>,
    observed_calls: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_details: Option<Box<RawValue>>,
}
async fn run(compiler: &TsgoBinary) -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|r| r.id.clone());
        let mut calls = Vec::new();
        let mut native_details = None;
        if let Some(id) = &id {
            writeln!(io::stderr(), "API_CASE {}", serde_json::to_string(id)?)?;
        }
        let result = match request {
            Err(error) => Err(error.to_string()),
            Ok(request) => match request.operation.as_str() {
                "diff" => match serde_json::from_str(request.input.get()) {
                    Ok(input) => diff(input, compiler, &mut calls, &mut native_details).await,
                    Err(error) => Err(error.to_string()),
                },
                "mode" => match serde_json::from_str(request.input.get()) {
                    Ok(input) => mode(input, compiler, &mut calls, &mut native_details),
                    Err(error) => Err(error.to_string()),
                },
                _ => Err("unsupported operation".into()),
            },
        };
        let (ok, output, error) = match result {
            Ok(value) => (true, Some(value), None),
            Err(error) => (false, None, Some(error.into())),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
                id,
                ok,
                output,
                error,
                observed_calls: calls,
                native_details
            })?
        );
    }
    Ok(())
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let compiler = TsgoBinary::pinned(args.next().ok_or("usage: api_mode_driver <compiler>")?);
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run(&compiler))
}
