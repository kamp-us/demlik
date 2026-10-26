use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, FrontdoorError, GatePreflightDispatch, HexagonDispatch, Preparation,
        },
        io::{CliIo, StdioStream},
    },
    engine::tsgo::TsgoBinary,
    schema::{SmellKind, UnreachableCategory},
    smells::{
        gate::{SmellGateOpts, SmellPreparation, SmellPreparationError},
        ledger::{RuleNameConversionError, SmellFinding, SmellLedgerEntry, SmellLedgerRead},
    },
    text::{JsObject, JsString, JsValue},
    unreachable::{
        gate::{UnreachableOpts, UnreachablePreparation},
        ledger::{UnreachableFinding, UnreachableLedgerEntry, UnreachableLedgerRead},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    error::Error,
    fs::File,
    io::{self, Read},
    os::fd::AsFd,
    path::PathBuf,
    sync::Arc,
};
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    trace: PathBuf,
    input: Box<RawValue>,
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(JsObject::from(
        fields.map(|(key, value)| (key.into(), value)),
    ))
}
fn serialized(value: &impl Serialize) -> JsValue {
    JsValue::parse(&serde_json::to_string(value).unwrap()).unwrap()
}
fn string<'a>(value: &'a JsValue, key: &str) -> Result<&'a JsString, Box<dyn Error>> {
    value
        .get(key)
        .and_then(JsValue::as_string)
        .ok_or_else(|| format!("{key} must be a string").into())
}
fn flag(value: &JsValue, key: &str) -> Result<bool, Box<dyn Error>> {
    match value.get(key) {
        None => Ok(false),
        Some(JsValue::Bool(value)) => Ok(*value),
        _ => Err(format!("{key} must be a boolean").into()),
    }
}
fn optional_string<'a>(
    value: &'a JsValue,
    key: &str,
) -> Result<Option<&'a JsString>, Box<dyn Error>> {
    value.get(key).map(|_| string(value, key)).transpose()
}
fn items<'a>(value: &'a JsValue, key: &str) -> Result<&'a [JsValue], Box<dyn Error>> {
    value
        .get(key)
        .and_then(JsValue::as_array)
        .ok_or_else(|| format!("{key} must be an array").into())
}
fn only(value: &JsValue, keys: &[&str]) -> Result<(), Box<dyn Error>> {
    let Some(object) = value.as_object() else {
        return Err("input must be an object".into());
    };
    for key in object.keys() {
        if !keys.iter().any(|allowed| key == allowed) {
            return Err(format!("unknown input field: {}", key.to_lossy()).into());
        }
    }
    Ok(())
}
fn thrown(name: &str, message: JsString) -> JsValue {
    object([
        ("name", JsValue::String(name.into())),
        ("message", JsValue::String(message)),
    ])
}
fn success(value: JsValue) -> JsValue {
    object([("value", value), ("thrown", JsValue::Null)])
}
fn io_detail(error: Option<&io::Error>) -> JsValue {
    error
        .map(|error| {
            object([
                (
                    "kind",
                    JsValue::String(format!("{:?}", error.kind()).into()),
                ),
                ("message", JsValue::String(error.to_string().into())),
                (
                    "code",
                    error
                        .raw_os_error()
                        .map(|code| JsValue::Number(f64::from(code)))
                        .unwrap_or(JsValue::Null),
                ),
            ])
        })
        .unwrap_or(JsValue::Null)
}
fn rule_error(error: &RuleNameConversionError) -> JsValue {
    object([
        ("input", error.input.clone()),
        ("path", serialized(&error.path)),
    ])
}
fn frontdoor_error(error: &FrontdoorError) -> JsValue {
    match error {
        FrontdoorError::RuleNameConversion(error) => rule_error(error),
        _ => object([("message", JsValue::String(error.message()))]),
    }
}
fn u_opts(value: &JsValue) -> Result<UnreachableOpts<'_>, Box<dyn Error>> {
    only(
        value,
        &[
            "unreachable",
            "ci",
            "acceptDead",
            "deadOnly",
            "boundaries",
            "reason",
        ],
    )?;
    Ok(UnreachableOpts {
        unreachable: flag(value, "unreachable")?,
        ci: flag(value, "ci")?,
        accept_dead: flag(value, "acceptDead")?,
        dead_only: flag(value, "deadOnly")?,
        boundaries: flag(value, "boundaries")?,
        reason: optional_string(value, "reason")?,
    })
}
fn s_opts(value: &JsValue) -> Result<SmellGateOpts<'_>, Box<dyn Error>> {
    only(
        value,
        &[
            "ci",
            "acceptSmells",
            "unreachable",
            "boundaries",
            "comments",
            "collapse",
            "layers",
            "reason",
        ],
    )?;
    Ok(SmellGateOpts {
        ci: flag(value, "ci")?,
        accept_smells: flag(value, "acceptSmells")?,
        unreachable: flag(value, "unreachable")?,
        boundaries: flag(value, "boundaries")?,
        comments: flag(value, "comments")?,
        collapse: flag(value, "collapse")?,
        layers: flag(value, "layers")?,
        reason: optional_string(value, "reason")?,
    })
}
fn prepare_u_output(preparation: UnreachablePreparation) -> (JsValue, JsValue) {
    match preparation {
        UnreachablePreparation::Refused { message, source } => (
            object([
                (
                    "preparation",
                    object([("kind", JsValue::String("refused".into()))]),
                ),
                ("reports", JsValue::Array(vec![JsValue::String(message)])),
            ]),
            io_detail(source.as_ref()),
        ),
        preparation => (
            object([
                ("preparation", serialized(&preparation)),
                ("reports", JsValue::Array(vec![])),
            ]),
            JsValue::Null,
        ),
    }
}
fn prepare_s_output(preparation: SmellPreparation) -> (JsValue, JsValue) {
    match preparation {
        SmellPreparation::Refused { message, source } => (
            object([
                (
                    "preparation",
                    object([("kind", JsValue::String("refused".into()))]),
                ),
                ("reports", JsValue::Array(vec![JsValue::String(message)])),
            ]),
            io_detail(source.as_ref()),
        ),
        preparation => (
            object([
                ("preparation", serialized(&preparation)),
                ("reports", JsValue::Array(vec![])),
            ]),
            JsValue::Null,
        ),
    }
}
fn smell_kind(value: &JsString) -> Result<SmellKind, Box<dyn Error>> {
    SmellKind::ALL
        .into_iter()
        .find(|kind| value == kind.as_str())
        .ok_or_else(|| "invalid typed smell rule".into())
}
fn unreachable_entry(value: &JsValue) -> Result<Arc<UnreachableLedgerEntry>, Box<dyn Error>> {
    only(value, &["scope", "kind", "id", "reason"])?;
    let kind = string(value, "kind")?;
    let kind = [
        UnreachableCategory::Dead,
        UnreachableCategory::OnlyCalledFromTests,
    ]
    .into_iter()
    .find(|item| kind == item.as_str())
    .ok_or("invalid typed unreachable kind")?;
    Ok(Arc::new(UnreachableLedgerEntry {
        finding: UnreachableFinding {
            scope: string(value, "scope")?.clone(),
            kind,
            id: string(value, "id")?.clone(),
        },
        reason: string(value, "reason")?.clone(),
    }))
}
fn numeric(value: &JsValue) -> Result<f64, Box<dyn Error>> {
    match value {
        JsValue::Number(value) => Ok(*value),
        JsValue::String(value) => match value.to_lossy().as_str() {
            "-0" => Ok(-0.0),
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            _ => Err("unsupported number tag".into()),
        },
        _ => Err("number required".into()),
    }
}
fn number_kind(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value == f64::INFINITY {
        "Infinity"
    } else if value == f64::NEG_INFINITY {
        "-Infinity"
    } else if value == 0.0 && value.is_sign_negative() {
        "-0"
    } else {
        "number"
    }
}
fn smell_entry(value: &JsValue) -> Result<Arc<SmellLedgerEntry>, Box<dyn Error>> {
    only(value, &["rule", "target", "value", "reason"])?;
    Ok(Arc::new(SmellLedgerEntry {
        finding: SmellFinding {
            rule: smell_kind(string(value, "rule")?)?,
            target: string(value, "target")?.clone(),
            value: numeric(value.get("value").ok_or("value required")?)?,
        },
        reason: string(value, "reason")?.clone(),
    }))
}
fn io_state(host: &CliIo<'_>) -> JsValue {
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
                            ("cause", io_detail(Some(&failure.source))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}
fn frontdoor(
    input: &JsValue,
    calls: &mut Vec<&'static str>,
) -> Result<(JsValue, JsValue, i32), Box<dyn Error>> {
    only(input, &["action", "argv", "initial"])?;
    let argv = items(input, "argv")?
        .iter()
        .map(|value| {
            value
                .as_string()
                .cloned()
                .ok_or("argv must contain strings")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let initial = match input.get("initial") {
        None => None,
        Some(JsValue::Number(n))
            if n.is_finite()
                && n.fract() == 0.0
                && *n >= f64::from(i32::MIN)
                && *n <= f64::from(i32::MAX) =>
        {
            Some(*n as i32)
        }
        _ => return Err("initial must be int32".into()),
    };
    let mut stdout = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let mut stderr = File::from(io::stderr().as_fd().try_clone_to_owned()?);
    let mut host = CliIo::new(&mut stdout, &mut stderr, initial);
    let mut details = JsValue::Null;
    let mut immediate_code = None;
    let result = (|| -> Result<JsValue, FrontdoorError> {
        let prepared = match observe!(
            calls,
            demlik_code_graph::cli::frontdoor::prepare_cli,
            &argv,
            None,
            &mut host
        )? {
            Preparation::Prepared(prepared) => prepared,
            Preparation::Stopped(stop) => {
                let immediate =
                    matches!(stop, demlik_code_graph::cli::frontdoor::CliStop::Parser(_));
                if immediate {
                    immediate_code = Some(stop.exit_code(&host));
                }
                return Ok(object([
                    ("kind", JsValue::String("stopped".into())),
                    ("immediate", JsValue::Bool(immediate)),
                ]));
            }
        };
        let ApiDispatch::Continue(prepared) = observe!(
            calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_api_blocking,
            prepared,
            &TsgoBinary::pinned("/missing/unused/compiler"),
            &mut host
        )?
        else {
            return Ok(object([("kind", JsValue::String("api".into()))]));
        };
        let HexagonDispatch::Continue(prepared) = observe!(
            calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_hexagon,
            prepared,
            &mut host
        )?
        else {
            return Ok(object([("kind", JsValue::String("hexagon".into()))]));
        };
        let address = std::ptr::from_ref(prepared.as_ref());
        match observe!(
            calls,
            demlik_code_graph::cli::frontdoor::PreparedCli::prepare_gates,
            prepared,
            &mut host
        )? {
            GatePreflightDispatch::Stopped(refusal) => {
                details = io_detail(refusal.source.as_ref());
                Ok(object([("kind",JsValue::String("refused".into())),("stage",JsValue::String(match refusal.stage{demlik_code_graph::cli::frontdoor::GatePreparationKind::Unreachable=>"unreachable",demlik_code_graph::cli::frontdoor::GatePreparationKind::Smell=>"smell"}.into())),("message",JsValue::String(refusal.message))]))
            }
            GatePreflightDispatch::Continue(prepared) => {
                let same = std::ptr::eq(address, prepared.prepared.as_ref());
                let needs = observe!(
                    calls,
                    demlik_code_graph::smells::gate::smell_gate_needs_edges,
                    &prepared.smells
                );
                Ok(object([
                    ("kind", JsValue::String("ready".into())),
                    ("sameBox", JsValue::Bool(same)),
                    ("root", JsValue::String(prepared.prepared.root_absolute)),
                    ("repoRoot", JsValue::String(prepared.repo_root)),
                    ("options", serialized(&prepared.prepared.options)),
                    ("thresholds", serialized(&prepared.prepared.thresholds)),
                    ("kindRules", serialized(&prepared.prepared.kind_rules)),
                    ("collapse", serialized(&prepared.prepared.collapse_settings)),
                    (
                        "given",
                        serialized(
                            &prepared
                                .prepared
                                .options
                                .given()
                                .map(|id| id.key())
                                .collect::<Vec<_>>(),
                        ),
                    ),
                    ("unreachable", serialized(&prepared.unreachable)),
                    ("smells", serialized(&prepared.smells)),
                    ("needsEdges", JsValue::Bool(needs)),
                ]))
            }
        }
    })();
    let (output, code) = match result {
        Ok(output) => (
            output,
            immediate_code.unwrap_or_else(|| host.normal_exit_code()),
        ),
        Err(error) => {
            details = frontdoor_error(&error);
            (
                object([
                    ("kind", JsValue::String("thrown".into())),
                    ("error", thrown(error.name(), error.message())),
                ]),
                1,
            )
        }
    };
    let mut fields = output.as_object().unwrap().clone();
    fields.insert("io".into(), io_state(&host));
    Ok((JsValue::Object(fields), details, code))
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text)?;
    let request: Request = serde_json::from_str(&text)?;
    let input = JsValue::parse(request.input.get())?;
    let action = string(&input, "action")?.to_utf8()?;
    let mut calls = Vec::new();
    let mut details = JsValue::Null;
    let (output, code) = match action.as_str() {
        "frontdoor" => {
            let (out, meta, code) = frontdoor(&input, &mut calls)?;
            details = meta;
            (out, code)
        }
        "root" => {
            only(&input, &["action", "root"])?;
            (
                success(serialized(&observe!(
                    calls,
                    demlik_code_graph::project::find_repo_root_text,
                    string(&input, "root")?
                ))),
                0,
            )
        }
        "json" => {
            only(&input, &["action", "text"])?;
            let result = observe!(
                calls,
                demlik_code_graph::text::JsValue::parse_js,
                string(&input, "text")?
            );
            (
                match result {
                    Ok(value) => object([("accepted", JsValue::Bool(true)), ("value", value)]),
                    Err(_) => object([("accepted", JsValue::Bool(false))]),
                },
                0,
            )
        }
        "unreachable-parse" | "unreachable-read" => {
            only(
                &input,
                &[
                    "action",
                    if action.ends_with("parse") {
                        "text"
                    } else {
                        "file"
                    },
                ],
            )?;
            let read = if action.ends_with("parse") {
                observe!(
                    calls,
                    demlik_code_graph::unreachable::ledger::parse_unreachable_ledger,
                    string(&input, "text")?
                )
            } else {
                observe!(
                    calls,
                    demlik_code_graph::unreachable::ledger::read_unreachable_ledger,
                    string(&input, "file")?
                )
            };
            if let UnreachableLedgerRead::Invalid { source, .. } = &read {
                details = io_detail(source.as_ref());
            }
            (success(serialized(&read)), 0)
        }
        "smell-parse" | "smell-read" => {
            only(
                &input,
                &[
                    "action",
                    if action.ends_with("parse") {
                        "text"
                    } else {
                        "file"
                    },
                ],
            )?;
            let read = if action.ends_with("parse") {
                observe!(
                    calls,
                    demlik_code_graph::smells::ledger::parse_smell_ledger,
                    string(&input, "text")?
                )
            } else {
                observe!(
                    calls,
                    demlik_code_graph::smells::ledger::read_smell_ledger,
                    string(&input, "file")?
                )
            };
            (
                match read {
                    Ok(read) => {
                        match &read {
                            SmellLedgerRead::Invalid { source, .. } => {
                                details = io_detail(source.as_ref())
                            }
                            SmellLedgerRead::Read { ledger } => {
                                details = serialized(
                                    &ledger
                                        .entries
                                        .iter()
                                        .map(|entry| number_kind(entry.finding.value))
                                        .collect::<Vec<_>>(),
                                )
                            }
                            _ => {}
                        }
                        success(serialized(&read))
                    }
                    Err(error) => {
                        details = rule_error(&error);
                        object([
                            ("value", JsValue::Null),
                            ("thrown", thrown(error.name(), error.message())),
                        ])
                    }
                },
                0,
            )
        }
        "unreachable-of" => {
            only(&input, &["action", "entries"])?;
            let entries = items(&input, "entries")?
                .iter()
                .map(unreachable_entry)
                .collect::<Result<Vec<_>, _>>()?;
            let ledger = observe!(
                calls,
                demlik_code_graph::unreachable::ledger::unreachable_ledger_of,
                &entries
            );
            let origin = ledger
                .entries
                .iter()
                .map(|entry| {
                    entries
                        .iter()
                        .position(|original| Arc::ptr_eq(entry, original))
                })
                .collect::<Vec<_>>();
            let keys = entries
                .iter()
                .map(|entry| {
                    observe!(
                        calls,
                        demlik_code_graph::unreachable::ledger::finding_key,
                        &entry.finding
                    )
                })
                .collect::<Vec<_>>();
            (
                success(object([
                    ("ledger", serialized(&ledger)),
                    ("origin", serialized(&origin)),
                    ("keys", serialized(&keys)),
                ])),
                0,
            )
        }
        "smell-of" => {
            only(&input, &["action", "entries", "gated"])?;
            let entries = items(&input, "entries")?
                .iter()
                .map(smell_entry)
                .collect::<Result<Vec<_>, _>>()?;
            let gated = items(&input, "gated")?
                .iter()
                .map(|value| smell_kind(value.as_string().ok_or("gated must contain strings")?))
                .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
            let ledger = observe!(
                calls,
                demlik_code_graph::smells::ledger::smell_ledger_of,
                &gated,
                &entries
            );
            let origin = ledger
                .entries
                .iter()
                .map(|entry| {
                    entries
                        .iter()
                        .position(|original| Arc::ptr_eq(entry, original))
                })
                .collect::<Vec<_>>();
            let keys = entries
                .iter()
                .map(|entry| {
                    observe!(
                        calls,
                        demlik_code_graph::smells::ledger::smell_key,
                        &entry.finding
                    )
                })
                .collect::<Vec<_>>();
            (
                success(object([
                    ("ledger", serialized(&ledger)),
                    ("origin", serialized(&origin)),
                    ("keys", serialized(&keys)),
                    (
                        "numberKinds",
                        serialized(
                            &ledger
                                .entries
                                .iter()
                                .map(|entry| number_kind(entry.finding.value))
                                .collect::<Vec<_>>(),
                        ),
                    ),
                ])),
                0,
            )
        }
        "needs-edges" => {
            only(&input, &["action", "gated"])?;
            let gated = items(&input, "gated")?
                .iter()
                .map(|value| smell_kind(value.as_string().ok_or("gated must contain strings")?))
                .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
            (
                success(JsValue::Bool(observe!(
                    calls,
                    demlik_code_graph::smells::ledger::needs_edges,
                    &gated
                ))),
                0,
            )
        }
        "prepare-unreachable" | "prepare-smell" => {
            only(&input, &["action", "opts", "root", "repoRoot"])?;
            let opts = input.get("opts").ok_or("opts required")?;
            let root = string(&input, "root")?;
            let repo = string(&input, "repoRoot")?;
            if action == "prepare-unreachable" {
                let result = observe!(
                    calls,
                    demlik_code_graph::unreachable::gate::prepare_unreachable_gate,
                    u_opts(opts)?,
                    root,
                    repo
                )?;
                let (out, meta) = prepare_u_output(result);
                details = meta;
                (success(out), 0)
            } else {
                let result = observe!(
                    calls,
                    demlik_code_graph::smells::gate::prepare_smell_gate,
                    s_opts(opts)?,
                    root,
                    repo
                );
                (
                    match result {
                        Ok(result) => {
                            let (out, meta) = prepare_s_output(result);
                            details = meta;
                            success(out)
                        }
                        Err(error) => {
                            details = match &error {
                                SmellPreparationError::RuleName(error) => rule_error(error),
                                SmellPreparationError::Scope(error) => io_detail(Some(error)),
                            };
                            object([
                                ("value", JsValue::Null),
                                ("thrown", thrown(error.name(), error.message())),
                            ])
                        }
                    },
                    0,
                )
            }
        }
        _ => return Err("unknown action".into()),
    };
    std::fs::write(
        request.trace,
        serde_json::to_vec(&object([
            ("output", output),
            ("details", details),
            ("code", JsValue::Number(f64::from(code))),
            ("observedCalls", serialized(&calls)),
        ]))?,
    )?;
    std::process::exit(code)
}
