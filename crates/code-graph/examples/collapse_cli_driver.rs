use demlik_code_graph::{
    api::map::ApiError,
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, CliStop, CollapseDispatch, CommentDispatch,
            EnvKeyDispatch, FrontdoorError, GatePreflightDispatch, HexagonDispatch, LayerDispatch,
            PlainCollapseDispatch, Preparation, SmellDispatch, UnreachableDispatch,
        },
        io::{CliIo, StdioStream},
    },
    engine::tsgo::TsgoBinary,
    text::{JsObject, JsString, JsValue},
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    cell::RefCell,
    error::Error,
    fs::{self, File},
    io::{self, Read, Write},
    os::fd::AsFd,
    path::PathBuf,
    rc::Rc,
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
    #[serde(default)]
    plain: bool,
    #[serde(default)]
    late_unreachable: bool,
    #[serde(default)]
    late_smell: bool,
    #[serde(default, deserialize_with = "some")]
    warning_marker: Option<JsString>,
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
        FrontdoorError::CollapseEmit(ApiError::Io { path, source })
        | FrontdoorError::Collapse(demlik_code_graph::collapse::gate::CollapseGateError::Write(
            ApiError::Io { path, source },
        ))
        | FrontdoorError::LayerEmit(ApiError::Io { path, source })
        | FrontdoorError::BoundaryEmit(ApiError::Io { path, source })
        | FrontdoorError::EnvKeyEmit(ApiError::Io { path, source })
        | FrontdoorError::CommentEmit(ApiError::Io { path, source })
        | FrontdoorError::SmellEmit(ApiError::Io { path, source })
        | FrontdoorError::SmellLedger(
            demlik_code_graph::smells::ledger::SmellLedgerError::Write(ApiError::Io {
                path,
                source,
            }),
        ) => object([
            ("path", JsValue::String(path.clone())),
            ("cause", io_error(source)),
        ]),
        FrontdoorError::CollapseEmit(ApiError::Argument(error))
        | FrontdoorError::Collapse(demlik_code_graph::collapse::gate::CollapseGateError::Write(
            ApiError::Argument(error),
        ))
        | FrontdoorError::LayerEmit(ApiError::Argument(error))
        | FrontdoorError::BoundaryEmit(ApiError::Argument(error))
        | FrontdoorError::EnvKeyEmit(ApiError::Argument(error))
        | FrontdoorError::CommentEmit(ApiError::Argument(error))
        | FrontdoorError::SmellEmit(ApiError::Argument(error))
        | FrontdoorError::SmellLedger(
            demlik_code_graph::smells::ledger::SmellLedgerError::Write(ApiError::Argument(error)),
        ) => object([
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
        FrontdoorError::Comments(demlik_code_graph::comments::gate::CommentGateError::Write {
            file,
            source,
        }) => object([
            (
                "path",
                JsValue::String(file.to_string_lossy().as_ref().into()),
            ),
            ("cause", io_error(source)),
        ]),
        FrontdoorError::Unreachable(
            demlik_code_graph::unreachable::gate::UnreachableRunError::Write(
                demlik_code_graph::unreachable::ledger::UnreachableWriteError::Io { file, source },
            ),
        ) => object([
            ("path", JsValue::String(file.clone())),
            ("cause", io_error(source)),
        ]),
        FrontdoorError::Unreachable(
            demlik_code_graph::unreachable::gate::UnreachableRunError::Emit(ApiError::Io {
                path,
                source,
            })
            | demlik_code_graph::unreachable::gate::UnreachableRunError::Report(ApiError::Io {
                path,
                source,
            }),
        ) => object([
            ("path", JsValue::String(path.clone())),
            ("cause", io_error(source)),
        ]),
        FrontdoorError::Unreachable(
            demlik_code_graph::unreachable::gate::UnreachableRunError::Emit(ApiError::Argument(
                error,
            ))
            | demlik_code_graph::unreachable::gate::UnreachableRunError::Report(ApiError::Argument(
                error,
            )),
        ) => object([
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
struct ObservedFile<'a> {
    inner: File,
    stream: &'static str,
    enabled: bool,
    events: Rc<RefCell<Vec<JsValue>>>,
    warning_marker: Option<&'a JsString>,
    marked: bool,
}
impl Write for ObservedFile<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.enabled {
            let text = String::from_utf8_lossy(bytes);
            let mut event = object([
                ("stream", JsValue::String(self.stream.into())),
                ("payload", JsValue::String(text.as_ref().into())),
            ]);
            if self.stream == "stderr"
                && let Some(rest) = text.strip_prefix("code-graph: wrote ")
                && let Some((_, path)) = rest.split_once(" bytes to ")
            {
                let path = path.strip_suffix('\n').unwrap_or(path);
                let captured = fs::read(path).ok();
                if let JsValue::Object(fields) = &mut event {
                    fields.insert(
                        "fileAtAck".into(),
                        captured.map(|b| serialized(&b)).unwrap_or(JsValue::Null),
                    );
                }
            }
            self.events.borrow_mut().push(event);
        }
        let result = self.inner.write(bytes);
        if self.enabled
            && !self.marked
            && self.stream == "stderr"
            && bytes.starts_with(b"warning: --by ")
            && let Some(marker) = self.warning_marker
        {
            fs::write(marker.to_lossy(), "packages: []\n")?;
            self.marked = true;
        }
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    let writes = Rc::new(RefCell::new(Vec::new()));
    let mut stdout = ObservedFile {
        inner: File::from(io::stdout().as_fd().try_clone_to_owned()?),
        stream: "stdout",
        enabled: request.plain || request.late_unreachable,
        events: Rc::clone(&writes),
        warning_marker: None,
        marked: false,
    };
    let mut stderr = ObservedFile {
        inner: File::from(io::stderr().as_fd().try_clone_to_owned()?),
        stream: "stderr",
        enabled: request.plain || request.late_unreachable,
        events: Rc::clone(&writes),
        warning_marker: request.warning_marker.as_ref(),
        marked: false,
    };
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
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_env_keys,
            prepared,
            &mut host
        )? {
            EnvKeyDispatch::Complete(report) => {
                return Ok(object([
                    ("kind", JsValue::String("env-keys".into())),
                    ("report", serialized(&report)),
                ]));
            }
            EnvKeyDispatch::Continue(value) => value,
        };
        let prepared = match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_comments,
            prepared,
            &mut host
        )? {
            CommentDispatch::Complete(result) => {
                return Ok(object([
                    ("kind", JsValue::String("comments".into())),
                    ("result", serialized(&result)),
                ]));
            }
            CommentDispatch::Continue(value) => value,
        };
        match observe!(
            &mut calls,
            demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_collapse_gate,
            prepared,
            &mut host,
            &TsgoBinary::pinned(&request.compiler)
        ) {
            Ok(CollapseDispatch::Complete(result)) => Ok(object([
                ("kind", JsValue::String("collapse".into())),
                ("result", serialized(&result)),
            ])),
            Ok(CollapseDispatch::Continue(value)) if request.late_unreachable || request.late_smell => {
                let value = match observe!(
                    &mut calls,
                    demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_unreachable_blocking,
                    value,
                    &mut host,
                    &TsgoBinary::pinned(&request.compiler)
                ) {
                    Ok(UnreachableDispatch::Complete) => return Ok(object([("kind", JsValue::String("unreachable".into()))])),
                    Ok(UnreachableDispatch::Refused { cause }) => return Ok(object([
                        ("kind", JsValue::String("unreachable-load-refused".into())),
                        ("cause", JsValue::String(cause.message())),
                    ])),
                    Ok(UnreachableDispatch::Continue(value)) => value,
                    Err(error) => return Ok(object([("kind", JsValue::String("thrown".into())), ("error", failure(&error))])),
                };
                let value = if request.late_smell {
                    match observe!(
                        &mut calls,
                        demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_smell_ledger_blocking,
                        value,
                        &mut host,
                        &TsgoBinary::pinned(&request.compiler)
                    ) {
                        Ok(SmellDispatch::Complete) => return Ok(object([("kind", JsValue::String("smell-ledger".into()))])),
                        Ok(SmellDispatch::Refused { cause }) => return Ok(object([
                            ("kind", JsValue::String("smell-load-refused".into())),
                            ("cause", JsValue::String(cause.message())),
                        ])),
                        Ok(SmellDispatch::Continue(value)) => value,
                        Err(error) => return Ok(object([("kind", JsValue::String("thrown".into())), ("error", failure(&error))])),
                    }
                } else { value };
                match observe!(
                    &mut calls,
                    demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_plain_collapse_blocking,
                    value,
                    &mut host,
                    &TsgoBinary::pinned(&request.compiler)
                ) {
                    Ok(PlainCollapseDispatch::Complete) => Ok(object([("kind", JsValue::String("plain-collapse".into()))])),
                    Ok(PlainCollapseDispatch::Refused { cause }) => Ok(object([
                        ("kind", JsValue::String("plain-load-refused".into())),
                        ("cause", JsValue::String(cause.message())),
                    ])),
                    Ok(PlainCollapseDispatch::Continue(value)) => Ok(object([
                        ("kind", JsValue::String("continue".into())),
                        ("sameCarrier", JsValue::Bool(std::ptr::eq(before, value.as_ref()))),
                        ("samePrepared", JsValue::Bool(std::ptr::eq(original, value.prepared.as_ref()))),
                    ])),
                    Err(error) => Ok(object([("kind", JsValue::String("thrown".into())), ("error", failure(&error))])),
                }
            }
            Ok(CollapseDispatch::Continue(value)) if request.plain => {
                match observe!(
                    &mut calls,
                    demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_plain_collapse_blocking,
                    value,
                    &mut host,
                    &TsgoBinary::pinned(&request.compiler)
                ) {
                    Ok(PlainCollapseDispatch::Complete) => Ok(object([("kind", JsValue::String("plain-collapse".into()))])),
                    Ok(PlainCollapseDispatch::Refused { cause }) => Ok(object([
                        ("kind", JsValue::String("plain-load-refused".into())),
                        ("cause", JsValue::String(cause.message())),
                    ])),
                    Ok(PlainCollapseDispatch::Continue(value)) => Ok(object([
                        ("kind", JsValue::String("continue".into())),
                        ("sameCarrier", JsValue::Bool(std::ptr::eq(before, value.as_ref()))),
                        ("samePrepared", JsValue::Bool(std::ptr::eq(original, value.prepared.as_ref()))),
                    ])),
                    Err(error) => Ok(object([("kind", JsValue::String("thrown".into())),("error", failure(&error))])),
                }
            }
            Ok(CollapseDispatch::Continue(value)) => Ok(object([
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
    let mut trace = object([
        ("id", JsValue::String(request.id.into())),
        ("outcome", outcome),
        ("io", io_state(&host)),
        ("exitCode", JsValue::Number(f64::from(code))),
        ("observedCalls", serialized(&calls)),
    ]);
    if (request.plain || request.late_unreachable || request.late_smell)
        && let JsValue::Object(fields) = &mut trace
    {
        fields.insert("writeObservations".into(), serialized(&*writes.borrow()));
    }
    fs::write(request.trace, serde_json::to_vec(&trace)?)?;
    std::process::exit(code)
}
