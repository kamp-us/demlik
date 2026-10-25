use demlik_code_graph::{
    api::map::{ApiCallbackError, ApiError, ApiInputError},
    cli::{
        frontdoor::{ApiDispatch, HexagonDispatch, Preparation},
        io::{CliIo, StdioStream},
    },
    engine::{
        oxc::{ParseFailure, parse_type_script},
        tsgo::TsgoBinary,
    },
    hexagon::{Hexagon, HexagonFailure, HexagonOutput},
    text::{JsString, JsValue},
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{
    cell::RefCell,
    error::Error,
    fs::{self, File},
    io::{self, Read},
    os::fd::AsFd,
    path::{Path, PathBuf},
    rc::Rc,
};
#[path = "support/number_input.rs"]
mod number_input;
use number_input::JsNumberInput;
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    trace: PathBuf,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    action: String,
    root: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PortsInput {
    action: String,
    text: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderInput {
    action: String,
    report: Hexagon,
    json: bool,
    pretty: bool,
    line: Option<JsNumberInput>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum CallbackMode {
    #[default]
    Ok,
    Callback,
    Input,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunInput {
    action: String,
    root: JsString,
    json: bool,
    pretty: bool,
    #[serde(default)]
    emit_mode: CallbackMode,
    #[serde(default)]
    report_mode: CallbackMode,
    emit_message: Option<JsString>,
    report_message: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrontdoorInput {
    action: String,
    argv: Vec<JsString>,
    compiler: Option<PathBuf>,
    initial: Option<i32>,
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn serialized(value: &impl serde::Serialize) -> JsValue {
    JsValue::parse(&serde_json::to_string(value).unwrap()).unwrap()
}
fn exception(name: &str, message: JsString) -> JsValue {
    object([
        ("name", JsValue::String(name.into())),
        ("message", JsValue::String(message)),
    ])
}
fn returned(value: JsValue) -> JsValue {
    object([("value", value), ("thrown", JsValue::Null)])
}
fn thrown(name: &str, message: JsString) -> JsValue {
    object([
        ("value", JsValue::Null),
        ("thrown", exception(name, message)),
    ])
}
fn api_details(error: &ApiError) -> JsValue {
    let mut result = exception(error.name(), error.message());
    if let JsValue::Object(fields) = &mut result {
        match error.visible() {
            ApiError::Argument(error) => {
                fields.insert("code".into(), JsValue::String(error.code().into()));
                fields.insert("argument".into(), JsValue::String(error.argument().clone()));
                fields.insert(
                    "location".into(),
                    JsValue::String(error.location().label().into()),
                );
                let source = error.source().expect("argument retains source");
                fields.insert("cause".into(), JsValue::String(source.to_string().into()));
                fields.insert(
                    "causeKind".into(),
                    JsValue::String(
                        format!("{:?}", source.downcast_ref::<io::Error>().unwrap().kind()).into(),
                    ),
                );
            }
            ApiError::Io { path, source } => {
                fields.insert("path".into(), JsValue::String(path.clone()));
                fields.insert(
                    "osCode".into(),
                    source
                        .raw_os_error()
                        .map(|code| JsValue::Number(f64::from(code)))
                        .unwrap_or(JsValue::Null),
                );
            }
            ApiError::Callback(error) => {
                if let Some(marker) = error
                    .source()
                    .and_then(|source| source.downcast_ref::<Marker>())
                {
                    fields.insert("causeMarker".into(), JsValue::String(marker.0.into()));
                }
            }
            ApiError::Input(error) => {
                if let Some(marker) = error
                    .source()
                    .and_then(|source| source.downcast_ref::<Marker>())
                {
                    fields.insert("causeMarker".into(), JsValue::String(marker.0.into()));
                }
            }
            _ => {}
        }
    }
    result
}
fn failure_details(error: &HexagonFailure) -> JsValue {
    match error {
        HexagonFailure::Emit(error) => object([
            ("kind", JsValue::String("emit".into())),
            ("error", api_details(error)),
        ]),
        HexagonFailure::Read(error) => object([
            ("kind", JsValue::String("read".into())),
            ("error", exception("Error", error.message())),
        ]),
        HexagonFailure::Render(error) => object([
            ("kind", JsValue::String("render".into())),
            ("error", exception("Error", error.to_string().into())),
        ]),
    }
}
fn state(host: &CliIo<'_>) -> JsValue {
    object([
        (
            "stored",
            host.exit_state()
                .stored_code()
                .map(|code| JsValue::Number(f64::from(code)))
                .unwrap_or(JsValue::Null),
        ),
        (
            "requested",
            host.exit_state()
                .requested_code()
                .map(JsValue::Number)
                .unwrap_or(JsValue::Null),
        ),
        (
            "pending",
            JsValue::Array(
                host.pending_stdio_failures()
                    .iter()
                    .map(|failure| {
                        object([
                            (
                                "stream",
                                JsValue::String(
                                    match failure.stream {
                                        StdioStream::Stdout => "stdout",
                                        StdioStream::Stderr => "stderr",
                                    }
                                    .into(),
                                ),
                            ),
                            (
                                "attemptedBytes",
                                JsValue::Number(failure.attempted_bytes as f64),
                            ),
                            (
                                "suppressedWrites",
                                JsValue::Number(failure.suppressed_writes as f64),
                            ),
                            (
                                "osCode",
                                failure
                                    .source
                                    .raw_os_error()
                                    .map(|code| JsValue::Number(f64::from(code)))
                                    .unwrap_or(JsValue::Null),
                            ),
                            (
                                "message",
                                JsValue::String(failure.source.to_string().into()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}
#[derive(Debug)]
struct Marker(&'static str);
impl std::fmt::Display for Marker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl Error for Marker {}
fn callback_result(
    mode: &CallbackMode,
    message: &JsString,
    marker: &'static str,
) -> Result<(), ApiError> {
    match mode {
        CallbackMode::Ok => Ok(()),
        CallbackMode::Callback => Err(ApiError::Callback(
            ApiCallbackError::new(message.clone()).with_cause(Marker(marker)),
        )),
        CallbackMode::Input => Err(ApiError::Input(
            ApiInputError::new(message.clone()).with_cause(Marker(marker)),
        )),
    }
}
fn frontdoor(
    input: FrontdoorInput,
    calls: &mut Vec<&'static str>,
) -> Result<(JsValue, i32), Box<dyn Error>> {
    assert_eq!(input.action, "frontdoor");
    let mut stdout = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let mut stderr = File::from(io::stderr().as_fd().try_clone_to_owned()?);
    let mut host = CliIo::new(&mut stdout, &mut stderr, input.initial);
    let compiler = TsgoBinary::pinned(
        input
            .compiler
            .unwrap_or_else(|| "/missing/unused/compiler".into()),
    );
    let prepared = observe!(
        calls,
        demlik_code_graph::cli::frontdoor::prepare_cli,
        &input.argv,
        None,
        &mut host
    );
    let (mut output, code) = match prepared {
        Ok(Preparation::Stopped(stop)) => {
            let code = stop.exit_code(&host);
            (
                object([
                    ("kind", JsValue::String("stopped".into())),
                    (
                        "immediate",
                        JsValue::Bool(matches!(
                            stop,
                            demlik_code_graph::cli::frontdoor::CliStop::Parser(_)
                        )),
                    ),
                ]),
                code,
            )
        }
        Ok(Preparation::Prepared(prepared)) => match observe!(
            calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_api_blocking,
            prepared,
            &compiler,
            &mut host
        ) {
            Ok(ApiDispatch::Complete(outcome)) => (
                object([
                    ("kind", JsValue::String("api".into())),
                    ("apiCode", JsValue::Number(f64::from(outcome.exit.code()))),
                    (
                        "failure",
                        outcome
                            .failure
                            .as_ref()
                            .map(api_details)
                            .unwrap_or(JsValue::Null),
                    ),
                ]),
                host.normal_exit_code(),
            ),
            Ok(ApiDispatch::Continue(prepared)) => match observe!(
                calls,
                demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_hexagon,
                prepared,
                &mut host
            ) {
                Ok(HexagonDispatch::Complete(outcome)) => (
                    object([
                        ("kind", JsValue::String("hexagon".into())),
                        (
                            "failure",
                            outcome
                                .failure
                                .as_ref()
                                .map(failure_details)
                                .unwrap_or(JsValue::Null),
                        ),
                    ]),
                    host.normal_exit_code(),
                ),
                Ok(HexagonDispatch::Continue(prepared)) => (
                    object([
                        ("kind", JsValue::String("continue".into())),
                        ("root", JsValue::String(prepared.root_absolute)),
                        ("options", serialized(&prepared.options)),
                        (
                            "given",
                            serialized(
                                &prepared
                                    .options
                                    .given()
                                    .map(|id| id.key())
                                    .collect::<Vec<_>>(),
                            ),
                        ),
                    ]),
                    host.normal_exit_code(),
                ),
                Err(error) => (
                    object([
                        ("kind", JsValue::String("thrown".into())),
                        ("error", exception(error.name(), error.message())),
                    ]),
                    1,
                ),
            },
            Err(error) => (
                object([
                    ("kind", JsValue::String("thrown".into())),
                    ("error", exception(error.name(), error.message())),
                ]),
                1,
            ),
        },
        Err(error) => (
            object([
                ("kind", JsValue::String("thrown".into())),
                ("error", exception(error.name(), error.message())),
            ]),
            1,
        ),
    };
    if let JsValue::Object(fields) = &mut output {
        fields.insert("io".into(), state(&host));
    }
    Ok((output, code))
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut body = String::new();
    io::stdin().read_to_string(&mut body)?;
    let request: Request = serde_json::from_str(&body)?;
    let input = JsValue::parse(request.input.get())?;
    let action = input
        .get("action")
        .and_then(JsValue::as_string)
        .ok_or("missing action")?
        .to_utf8()?;
    let mut calls = Vec::new();
    let mut details = JsValue::Null;
    let (output, code) = match action.as_str() {
        "frontdoor" => frontdoor(serde_json::from_str(request.input.get())?, &mut calls)?,
        "read" => {
            let input: ReadInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.action, "read");
            let output = match observe!(
                calls,
                demlik_code_graph::hexagon::read::read_hexagon,
                &input.root
            ) {
                Ok(value) => returned(serialized(&value)),
                Err(error) => thrown("Error", error.message()),
            };
            (output, 0)
        }
        "ports" => {
            let input: PortsInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.action, "ports");
            let syntax = match input
                .text
                .as_deref()
                .map(|text| parse_type_script(Path::new("ports.ts"), text))
            {
                Some(Ok(syntax)) => Some(syntax),
                Some(Err(ParseFailure::Syntax(_))) | None => None,
                Some(Err(error)) => return Err(error.into()),
            };
            let mut not_read = Vec::new();
            let ports = observe!(
                calls,
                demlik_code_graph::hexagon::ports::read_ports,
                syntax.as_ref(),
                &mut not_read
            );
            (
                returned(object([
                    ("parsed", JsValue::Bool(syntax.is_some())),
                    ("ports", serialized(&ports)),
                    ("notRead", serialized(&not_read)),
                ])),
                0,
            )
        }
        "render" => {
            let mut input: RenderInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.action, "render");
            if let Some(line) = input.line {
                input
                    .report
                    .not_read
                    .first_mut()
                    .ok_or("line override needs a notRead fact")?
                    .line = line.value();
            }
            let line = input.report.not_read.first().map(|row| row.line);
            let output = match observe!(
                calls,
                demlik_code_graph::hexagon::render::render_hexagon,
                &input.report,
                input.json,
                input.pretty
            ) {
                Ok(value) => returned(JsValue::String(value)),
                Err(error) => thrown("Error", error.to_string().into()),
            };
            details = object([(
                "negativeZero",
                JsValue::Bool(line.is_some_and(|line| line == 0.0 && line.is_sign_negative())),
            )]);
            (output, 0)
        }
        "run" => {
            let input: RunInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.action, "run");
            let events = Rc::new(RefCell::new(Vec::new()));
            let emitted = events.clone();
            let reported = events.clone();
            let emit_message = input.emit_message.unwrap_or_else(|| "emit error".into());
            let report_message = input
                .report_message
                .unwrap_or_else(|| "report error".into());
            let mut emit = |payload: &JsString| {
                emitted.borrow_mut().push(object([
                    ("kind", JsValue::String("emit".into())),
                    ("message", JsValue::String(payload.clone())),
                ]));
                callback_result(&input.emit_mode, &emit_message, "emit")
            };
            let mut report = |message: &JsString| {
                reported.borrow_mut().push(object([
                    ("kind", JsValue::String("report".into())),
                    ("message", JsValue::String(message.clone())),
                ]));
                callback_result(&input.report_mode, &report_message, "report")
            };
            let result = observe!(
                calls,
                demlik_code_graph::hexagon::cli::run_hexagon,
                &input.root,
                HexagonOutput {
                    json: input.json,
                    pretty: input.pretty,
                    emit: &mut emit,
                    report: &mut report
                }
            );
            let thrown = match result {
                Ok(outcome) => {
                    details = outcome
                        .failure
                        .as_ref()
                        .map(failure_details)
                        .unwrap_or(JsValue::Null);
                    JsValue::Null
                }
                Err(error) => {
                    details = object([
                        ("report", api_details(&error.report)),
                        ("processing", failure_details(&error.processing)),
                    ]);
                    exception(error.name(), error.message())
                }
            };
            (
                object([
                    ("events", JsValue::Array(events.borrow().clone())),
                    ("thrown", thrown),
                ]),
                0,
            )
        }
        _ => return Err("unknown action".into()),
    };
    fs::write(
        request.trace,
        serde_json::to_vec(&object([
            ("output", output),
            ("details", details),
            ("code", JsValue::Number(f64::from(code))),
            ("observedCalls", serialized(&calls)),
        ]))?,
    )?;
    std::process::exit(code);
}
