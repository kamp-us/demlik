use demlik_code_graph::{
    api::map::ApiError,
    cli::{
        frontdoor::{ApiDispatch, CliStop, Preparation},
        io::{CliIo, StdioStream},
    },
    engine::tsgo::TsgoBinary,
    text::{JsString, JsValue},
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{
    fs::{self, File},
    io::{self, Read},
    os::fd::AsFd,
    path::PathBuf,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrontdoorInput {
    action: String,
    argv: Vec<JsString>,
    compiler: Option<PathBuf>,
    initial: Option<i32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutInput {
    action: String,
    payload: JsString,
    destination: Option<JsString>,
    initial: Option<i32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanInput {
    action: String,
    payload: JsString,
    initial: Option<i32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExitInput {
    action: String,
    code: JsNumberInput,
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
fn state(host: &CliIo<'_>) -> JsValue {
    object([
        (
            "stored",
            host.exit_state()
                .stored_code()
                .map(|n| JsValue::Number(f64::from(n)))
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
                                    .map(|n| JsValue::Number(f64::from(n)))
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
fn api_failure(error: &ApiError) -> JsValue {
    let mut data = object([
        ("name", JsValue::String(error.name().into())),
        ("message", JsValue::String(error.message())),
    ]);
    if let JsValue::Object(fields) = &mut data {
        match error.visible() {
            ApiError::Io { path, source } => {
                fields.insert("path".into(), JsValue::String(path.clone()));
                fields.insert(
                    "osCode".into(),
                    source
                        .raw_os_error()
                        .map(|n| JsValue::Number(f64::from(n)))
                        .unwrap_or(JsValue::Null),
                );
            }
            ApiError::Argument(error) => {
                fields.insert("code".into(), JsValue::String(error.code().into()));
                fields.insert("argument".into(), JsValue::String(error.argument().clone()));
                fields.insert(
                    "location".into(),
                    JsValue::String(error.location().label().into()),
                );
                let cause =
                    std::error::Error::source(error).expect("argument retains native cause");
                fields.insert("cause".into(), JsValue::String(cause.to_string().into()));
                fields.insert(
                    "causeKind".into(),
                    JsValue::String(
                        format!("{:?}", cause.downcast_ref::<io::Error>().unwrap().kind()).into(),
                    ),
                );
            }
            _ => {}
        }
    }
    data
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut body = String::new();
    io::stdin().read_to_string(&mut body)?;
    let request: Request = serde_json::from_str(&body)?;
    let input = JsValue::parse(request.input.get())?;
    let action = input
        .get("action")
        .and_then(JsValue::as_string)
        .ok_or("missing action")?
        .to_utf8()?;
    let mut stdout = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let mut stderr = File::from(io::stderr().as_fd().try_clone_to_owned()?);
    let mut calls = Vec::new();
    let (output, code) = match action.as_str() {
        "frontdoor" => {
            let FrontdoorInput {
                action,
                argv,
                compiler,
                initial,
            } = serde_json::from_str(request.input.get())?;
            assert_eq!(action, "frontdoor");
            let compiler = TsgoBinary::pinned(
                compiler.unwrap_or_else(|| "/missing/unused/frontend/compiler".into()),
            );
            let mut host = CliIo::new(&mut stdout, &mut stderr, initial);
            let result = observe!(
                calls,
                demlik_code_graph::cli::frontdoor::prepare_cli,
                &argv,
                None,
                &mut host
            );
            let (mut data, code) = match result {
                Ok(Preparation::Stopped(stop)) => {
                    let code = stop.exit_code(&host);
                    let immediate = matches!(stop, CliStop::Parser(_));
                    (
                        object([
                            ("kind", JsValue::String("stopped".into())),
                            ("immediate", JsValue::Bool(immediate)),
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
                    Ok(ApiDispatch::Continue(prepared)) => (
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
                            ("thresholds", serialized(&prepared.thresholds)),
                            ("rules", prepared.kind_rules.as_value()),
                            ("collapse", prepared.collapse_settings.as_value()),
                        ]),
                        host.normal_exit_code(),
                    ),
                    Ok(ApiDispatch::Complete(outcome)) => (
                        object([
                            ("kind", JsValue::String("api".into())),
                            ("apiCode", JsValue::Number(f64::from(outcome.exit.code()))),
                            (
                                "failure",
                                outcome
                                    .failure
                                    .as_ref()
                                    .map(api_failure)
                                    .unwrap_or(JsValue::Null),
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
            };
            if let JsValue::Object(fields) = &mut data {
                fields.insert("io".into(), state(&host));
            }
            (data, code)
        }
        "out" => {
            let OutInput {
                action,
                payload,
                destination,
                initial,
            } = serde_json::from_str(request.input.get())?;
            assert_eq!(action, "out");
            let mut host = CliIo::new(&mut stdout, &mut stderr, initial);
            let output = observe!(
                calls,
                demlik_code_graph::cli::io::output_to,
                destination.as_ref()
            );
            let result = observe!(
                calls,
                demlik_code_graph::cli::io::OutputTo::emit,
                &output,
                &mut host,
                &payload
            );
            let thrown = result.err().map(|error| api_failure(&error));
            let code = if thrown.is_some() {
                1
            } else {
                host.normal_exit_code()
            };
            (
                object([
                    ("kind", JsValue::String("helper".into())),
                    ("io", state(&host)),
                    ("error", thrown.unwrap_or(JsValue::Null)),
                ]),
                code,
            )
        }
        "clean" => {
            let CleanInput {
                action,
                payload,
                initial,
            } = serde_json::from_str(request.input.get())?;
            assert_eq!(action, "clean");
            let mut host = CliIo::new(&mut stdout, &mut stderr, initial);
            observe!(
                calls,
                demlik_code_graph::cli::io::clean_exit,
                &mut host,
                &payload
            );
            (
                object([
                    ("kind", JsValue::String("helper".into())),
                    ("io", state(&host)),
                    ("error", JsValue::Null),
                ]),
                host.normal_exit_code(),
            )
        }
        "exit" => {
            let ExitInput {
                action,
                code,
                initial,
            } = serde_json::from_str(request.input.get())?;
            assert_eq!(action, "exit");
            let mut host = CliIo::new(&mut stdout, &mut stderr, initial);
            let result = observe!(
                calls,
                demlik_code_graph::cli::io::exit_with,
                &mut host,
                code.value()
            );
            let error = result.err().map(|error| {
                object([
                    ("name", JsValue::String(error.name().into())),
                    ("code", JsValue::String(error.code().into())),
                    ("message", JsValue::String(error.message())),
                ])
            });
            let code = if error.is_some() {
                1
            } else {
                host.normal_exit_code()
            };
            (
                object([
                    ("kind", JsValue::String("helper".into())),
                    ("io", state(&host)),
                    ("error", error.unwrap_or(JsValue::Null)),
                ]),
                code,
            )
        }
        _ => return Err("unknown action".into()),
    };
    fs::write(
        request.trace,
        serde_json::to_vec(&object([
            ("output", output),
            ("code", JsValue::Number(f64::from(code))),
            ("observedCalls", serialized(&calls)),
        ]))?,
    )?;
    std::process::exit(code);
}
