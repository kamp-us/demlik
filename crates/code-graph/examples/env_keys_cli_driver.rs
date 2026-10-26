use demlik_code_graph::{
    api::map::ApiError,
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, CliStop, EnvKeyDispatch, FrontdoorError,
            GatePreflightDispatch, HexagonDispatch, LayerDispatch, Preparation,
        },
        io::{CliIo, StdioStream},
    },
    engine::tsgo::TsgoBinary,
    text::{JsObject, JsString, JsValue},
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    error::Error,
    fs::{self, File},
    io::{self, Read},
    os::fd::AsFd,
    path::PathBuf,
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};}
fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(input: D) -> Result<Option<T>, D::Error> {
    T::deserialize(input).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    trace: PathBuf,
    argv: Vec<JsString>,
    compiler: PathBuf,
    #[serde(default, deserialize_with = "some")]
    initial: Option<i32>,
    #[serde(default, deserialize_with = "some")]
    remove_marker: Option<JsString>,
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect::<JsObject>(),
    )
}
fn serialized(value: &impl Serialize) -> JsValue {
    JsValue::parse(&serde_json::to_string(value).expect("encodable trace facts"))
        .expect("canonical JSON")
}
fn io_error(source: &io::Error) -> JsValue {
    object([
        (
            "kind",
            JsValue::String(format!("{:?}", source.kind()).into()),
        ),
        (
            "rawCode",
            source
                .raw_os_error()
                .map(|n| JsValue::Number(f64::from(n)))
                .unwrap_or(JsValue::Null),
        ),
        ("message", JsValue::String(source.to_string().into())),
    ])
}
fn failure(error: &FrontdoorError) -> JsValue {
    let details = match error {
        FrontdoorError::LayerEmit(ApiError::Io { path, source })
        | FrontdoorError::BoundaryEmit(ApiError::Io { path, source })
        | FrontdoorError::EnvKeyEmit(ApiError::Io { path, source }) => object([
            ("path", JsValue::String(path.clone())),
            ("cause", io_error(source)),
        ]),
        FrontdoorError::LayerEmit(ApiError::Argument(error))
        | FrontdoorError::BoundaryEmit(ApiError::Argument(error))
        | FrontdoorError::EnvKeyEmit(ApiError::Argument(error)) => object([
            ("argument", JsValue::String(error.argument().clone())),
            ("location", JsValue::String(error.location().label().into())),
            ("code", JsValue::String(error.code().into())),
            (
                "cause",
                error
                    .source()
                    .and_then(|e| e.downcast_ref::<io::Error>())
                    .map(io_error)
                    .unwrap_or(JsValue::Null),
            ),
        ]),
        FrontdoorError::Boundaries(demlik_code_graph::boundaries::gate::BoundaryGateError::Io(
            error,
        )) => object([("cause", io_error(error))]),
        _ => JsValue::Null,
    };
    object([
        ("name", JsValue::String(error.name().into())),
        ("message", JsValue::String(error.message())),
        ("details", details),
    ])
}
fn io_state(host: &CliIo<'_>) -> JsValue {
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
            "normal",
            JsValue::Number(f64::from(host.normal_exit_code())),
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
                            ("cause", io_error(&failure.source)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    let mut stdout = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let mut stderr = File::from(io::stderr().as_fd().try_clone_to_owned()?);
    let mut host = CliIo::new(&mut stdout, &mut stderr, request.initial);
    let mut calls = Vec::new();
    let mut immediate = None;
    let outcome = (|| -> Result<JsValue, Box<dyn Error>> {
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::prepare_cli,
            &request.argv,
            None,
            &mut host
        )? {
            Preparation::Prepared(value) => value,
            Preparation::Stopped(stop) => {
                if matches!(stop, CliStop::Parser(_)) {
                    immediate = Some(stop.exit_code(&host));
                }
                return Ok(object([("kind", JsValue::String("stopped".into()))]));
            }
        };
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_api_blocking,
            prepared,
            &TsgoBinary::pinned(&request.compiler),
            &mut host
        )? {
            ApiDispatch::Continue(value) => value,
            ApiDispatch::Complete(_) => {
                return Ok(object([("kind", JsValue::String("api".into()))]));
            }
        };
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_hexagon,
            prepared,
            &mut host
        )? {
            HexagonDispatch::Continue(value) => value,
            HexagonDispatch::Complete(_) => {
                return Ok(object([("kind", JsValue::String("hexagon".into()))]));
            }
        };
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::prepare_gates,
            prepared,
            &mut host
        )? {
            GatePreflightDispatch::Continue(value) => value,
            GatePreflightDispatch::Stopped(_) => {
                return Ok(object([("kind", JsValue::String("refused".into()))]));
            }
        };
        let before = std::ptr::from_ref(prepared.as_ref());
        let original = std::ptr::from_ref(prepared.prepared.as_ref());
        if let Some(marker) = &request.remove_marker {
            fs::remove_file(marker.to_lossy())?;
        }
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_layers,
            prepared,
            &mut host
        )? {
            LayerDispatch::Complete(result) => {
                return Ok(object([
                    ("kind", JsValue::String("layers".into())),
                    ("result", serialized(&result)),
                ]));
            }
            LayerDispatch::Continue(value) => value,
        };
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_boundaries,
            prepared,
            &mut host
        )? {
            BoundaryDispatch::Complete(result) => {
                return Ok(object([
                    ("kind", JsValue::String("boundaries".into())),
                    ("result", serialized(&result)),
                ]));
            }
            BoundaryDispatch::Continue(value) => value,
        };
        match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_env_keys,
            prepared,
            &mut host
        ) {
            Ok(EnvKeyDispatch::Complete(report)) => Ok(object([
                ("kind", JsValue::String("env-keys".into())),
                ("report", serialized(&report)),
            ])),
            Ok(EnvKeyDispatch::Continue(value)) => Ok(object([
                ("kind", JsValue::String("continue".into())),
                (
                    "sameCarrier",
                    JsValue::Bool(std::ptr::eq(before, value.as_ref())),
                ),
                (
                    "samePrepared",
                    JsValue::Bool(std::ptr::eq(original, value.prepared.as_ref())),
                ),
                ("root", JsValue::String(value.prepared.root_absolute)),
                ("repoRoot", JsValue::String(value.repo_root)),
                ("options", serialized(&value.prepared.options)),
            ])),
            Err(error) => Ok(object([
                ("kind", JsValue::String("thrown".into())),
                ("error", failure(&error)),
            ])),
        }
    })();
    let outcome = match outcome {
        Ok(value) => value,
        Err(error) => {
            let value = error
                .downcast_ref::<FrontdoorError>()
                .map(failure)
                .unwrap_or_else(|| {
                    object([
                        ("name", JsValue::String("Error".into())),
                        ("message", JsValue::String(error.to_string().into())),
                        ("details", JsValue::Null),
                    ])
                });
            object([("kind", JsValue::String("thrown".into())), ("error", value)])
        }
    };
    let thrown = outcome
        .get("kind")
        .and_then(JsValue::as_string)
        .is_some_and(|kind| kind == "thrown");
    let code = if thrown {
        1
    } else {
        immediate.unwrap_or_else(|| host.normal_exit_code())
    };
    let trace = object([
        ("id", JsValue::String(request.id.into())),
        ("outcome", outcome),
        ("io", io_state(&host)),
        ("exitCode", JsValue::Number(f64::from(code))),
        ("observedCalls", serialized(&calls)),
    ]);
    fs::write(request.trace, serde_json::to_vec(&trace)?)?;
    std::process::exit(code)
}
