use demlik_code_graph::{
    api::map::ApiError,
    cli::io::CliIo,
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::AnalysisOptions,
        assemble::{NodeFields, assemble_graph},
    },
    kinds::rules::NodeKindRules,
    project::{Collation, EdgeScope, load_cheap_project},
    schema::{Graph, Provenance, Severity, Smell, SmellKind, SmellTarget, Thresholds},
    smells::{
        gate::{PreparedSmellGate, SmellGateMode, SmellGateOpts, SmellPreparation},
        ledger::{SmellFinding, SmellLedger, SmellLedgerEntry, SmellLedgerError},
    },
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::Path,
    rc::Rc,
    sync::Arc,
};

macro_rules! observe {
    ($calls:expr,$function:path $(,$argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
struct Response<'a> {
    id: &'a str,
    result: Box<RawValue>,
    calls: Vec<&'static str>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Finite(f64),
    Special(Special),
}
#[derive(Deserialize)]
enum Special {
    NaN,
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    #[serde(rename = "-0")]
    NegativeZero,
}
impl Number {
    fn value(self) -> f64 {
        match self {
            Self::Finite(n) => n,
            Self::Special(Special::NaN) => f64::NAN,
            Self::Special(Special::Infinity) => f64::INFINITY,
            Self::Special(Special::NegativeInfinity) => f64::NEG_INFINITY,
            Self::Special(Special::NegativeZero) => -0.0,
        }
    }
}
fn number_tag(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n == 0.0 && n.is_sign_negative() {
        "-0".into()
    } else if n == f64::INFINITY {
        "Infinity".into()
    } else if n == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        n.to_string()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finding {
    rule: SmellKind,
    target: JsString,
    value: Number,
}
impl Finding {
    fn owned(self) -> SmellFinding {
        SmellFinding {
            rule: self.rule,
            target: self.target,
            value: self.value.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    rule: SmellKind,
    target: JsString,
    value: Number,
    reason: JsString,
}
impl Entry {
    fn owned(self) -> Arc<SmellLedgerEntry> {
        Arc::new(SmellLedgerEntry {
            finding: SmellFinding {
                rule: self.rule,
                target: self.target,
                value: self.value.value(),
            },
            reason: self.reason,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pure {
    scope: JsString,
    gated: Vec<SmellKind>,
    measured: Vec<SmellKind>,
    findings: Vec<Finding>,
    entries: Vec<Entry>,
    reason: JsString,
    json: bool,
    pretty: bool,
}
fn pure(
    input: Pure,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let collation = Collation::try_node22_en_us()?;
    let ledger = SmellLedger {
        gated: input.gated,
        entries: input.entries.into_iter().map(Entry::owned).collect(),
    };
    let findings: Vec<_> = input.findings.into_iter().map(Finding::owned).collect();
    let canonical = observe!(
        calls,
        demlik_code_graph::smells::ledger::smell_ledger_of,
        &ledger.gated,
        &ledger.entries,
        &collation
    )?;
    let keys: Vec<_> = findings
        .iter()
        .map(|f| observe!(calls, demlik_code_graph::smells::ledger::smell_key, f))
        .collect();
    let result = observe!(
        calls,
        demlik_code_graph::smells::ledger::reconcile_smells,
        &ledger,
        &input.scope,
        &findings,
        &input.measured,
        &collation
    )?;
    let accepted = observe!(
        calls,
        demlik_code_graph::smells::ledger::with_accepted_smells,
        &result,
        &input.reason,
        &collation
    )?;
    let serialized = observe!(
        calls,
        demlik_code_graph::smells::ledger::serialize_smell_ledger,
        &ledger,
        &collation
    )?;
    let gate = observe!(
        calls,
        demlik_code_graph::smells::ledger_render::render_smell_ledger_gate,
        &result,
        input.json,
        input.pretty
    )?;
    let accepted_text = observe!(
        calls,
        demlik_code_graph::smells::ledger_render::render_accepted_smells,
        &result,
        &input.reason,
        input.json,
        input.pretty
    )?;
    let original = |entry: &Arc<SmellLedgerEntry>| {
        ledger
            .entries
            .iter()
            .position(|old| Arc::ptr_eq(old, entry))
            .map_or(-1, |n| n as i64)
    };
    let kept_identity: Vec<_> = result.kept.entries.iter().map(original).collect();
    let pruned_identity: Vec<_> = result.pruned.iter().map(original).collect();
    let canonical_identity: Vec<_> = canonical.entries.iter().map(original).collect();
    let accepted_identity: Vec<_> = accepted
        .entries
        .iter()
        .map(|entry| {
            result
                .kept
                .entries
                .iter()
                .position(|old| Arc::ptr_eq(old, entry))
                .map_or(-1, |n| n as i64)
        })
        .collect();
    let unrecorded_identity: Vec<_> = result
        .unrecorded
        .iter()
        .map(|f| {
            findings
                .iter()
                .position(|old| std::ptr::eq(old, *f))
                .unwrap()
        })
        .collect();
    let kept_numbers: Vec<_> = result
        .kept
        .entries
        .iter()
        .map(|entry| number_tag(entry.finding.value))
        .collect();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output<'a> {
        keys: Vec<String>,
        canonical: SmellLedger,
        serialized: JsString,
        result: demlik_code_graph::smells::ledger::SmellReconciliation<'a>,
        accepted: SmellLedger,
        gate: demlik_code_graph::smells::ledger_render::SmellLedgerRender,
        accepted_text: JsString,
        gated_identity: bool,
        canonical_identity: Vec<i64>,
        unrecorded_identity: Vec<usize>,
        kept_identity: Vec<i64>,
        pruned_identity: Vec<i64>,
        accepted_identity: Vec<i64>,
        kept_numbers: Vec<String>,
    }
    let gated_identity = std::ptr::eq(result.gated, ledger.gated.as_slice());
    Ok(to_raw_value(&Output {
        keys,
        canonical,
        serialized,
        result,
        accepted,
        gate,
        accepted_text,
        gated_identity,
        canonical_identity,
        unrecorded_identity,
        kept_identity,
        pruned_identity,
        accepted_identity,
        kept_numbers,
    })?)
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Target {
    Function {
        id: String,
        file: String,
        start_line: usize,
    },
    Module {
        file: String,
    },
    Directory {
        dir: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputSmell {
    kind: SmellKind,
    target: Target,
    value: usize,
}
impl InputSmell {
    fn owned(self) -> Smell {
        Smell {
            kind: self.kind,
            target: match self.target {
                Target::Function {
                    id,
                    file,
                    start_line,
                } => SmellTarget::Function {
                    id,
                    file,
                    start_line,
                },
                Target::Module { file } => SmellTarget::Module { file },
                Target::Directory { dir } => SmellTarget::Directory { dir },
            },
            value: self.value,
            threshold: 1,
            severity: Severity::Warn,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Targets {
    scope: JsString,
    smells: Vec<InputSmell>,
}
fn targets(
    input: Targets,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let collation = Collation::try_node22_en_us()?;
    let smells: Vec<_> = input.smells.into_iter().map(InputSmell::owned).collect();
    let targets: Vec<_> = smells
        .iter()
        .map(|s| {
            observe!(
                calls,
                demlik_code_graph::smells::ledger::repo_target,
                &input.scope,
                s
            )
        })
        .collect();
    let findings = observe!(
        calls,
        demlik_code_graph::smells::ledger::findings_of,
        &input.scope,
        &smells,
        &collation
    )?;
    #[derive(Serialize)]
    struct Output {
        targets: Vec<JsString>,
        findings: Vec<SmellFinding>,
    }
    Ok(to_raw_value(&Output { targets, findings })?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Run {
    root: JsString,
    repo_root: JsString,
    file: JsString,
    scope: JsString,
    prepare: bool,
    accept: bool,
    ci: bool,
    reason: Option<JsString>,
    gated: Vec<SmellKind>,
    entries: Vec<Entry>,
    smells: Vec<InputSmell>,
    project: bool,
    edges: bool,
    json: bool,
    pretty: bool,
    fail_emit: bool,
    output_file: Option<JsString>,
    thresholds: Thresholds,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    stage: &'static str,
    name: &'static str,
    message: JsString,
    io_kind: Option<String>,
    callback_identity: bool,
}
fn api_failure(stage: &'static str, error: ApiError) -> Failure {
    let io_kind = match &error {
        ApiError::Io { source, .. } => Some(format!("{:?}", source.kind())),
        _ => None,
    };
    Failure {
        stage,
        name: error.name(),
        message: error.message(),
        io_kind,
        callback_identity: false,
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    exit: Option<u8>,
    process_exit: Option<i32>,
    thrown: Option<Failure>,
    payloads: Vec<JsString>,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    ledger_at_emit: Vec<Option<JsString>>,
    preparation: Option<SmellPreparation>,
    source_files: Option<usize>,
    smells: Vec<Smell>,
    measured: Vec<SmellKind>,
    pending_stdio: usize,
}
fn run(
    input: Run,
    binary: &TsgoBinary,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()?;

    let collation = Collation::try_node22_en_us()?;
    let mut output = RunResult {
        exit: None,
        process_exit: None,
        thrown: None,
        payloads: vec![],
        stdout_bytes: vec![],
        stderr_bytes: vec![],
        ledger_at_emit: vec![],
        preparation: None,
        source_files: None,
        smells: vec![],
        measured: vec![],
        pending_stdio: 0,
    };
    let gate = if input.prepare {
        match observe!(
            calls,
            demlik_code_graph::smells::gate::prepare_smell_gate,
            SmellGateOpts {
                ci: input.ci,
                accept_smells: input.accept,
                reason: input.reason.as_ref(),
                ..Default::default()
            },
            &input.root,
            &input.repo_root,
            &collation
        )? {
            SmellPreparation::Prepared { gate } => gate,
            other => {
                output.preparation = Some(other);
                return Ok(to_raw_value(&output)?);
            }
        }
    } else {
        PreparedSmellGate {
            scope: input.scope,
            file: input.file,
            mode: if input.accept {
                SmellGateMode::Accept {
                    reason: input.reason.unwrap_or_default(),
                }
            } else {
                SmellGateMode::Gate
            },
            ledger: SmellLedger {
                gated: input.gated,
                entries: input.entries.into_iter().map(Entry::owned).collect(),
            },
        }
    };
    let physical_root = input.root.to_lossy();
    let physical_repo = input.repo_root.to_lossy();
    let graph: Graph = if input.project {
        let loaded = observe!(
            calls,
            demlik_code_graph::project::load_edge_project_text,
            &input.root,
            EdgeScope::Package,
            Path::new(&physical_repo),
            None
        )?;
        output.source_files = Some(loaded.project.source_files.len());
        observe!(
            calls,
            demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
            &loaded,
            &input.root,
            input.thresholds,
            binary,
            NodeFields::default(),
            &AnalysisOptions {
                cross_runtime: false,
                kinds: false,
                reach: false,
                clusters: false,
                interface_width: false,
                kind_rules: &NodeKindRules::default(),
                repo_root: Path::new(&physical_repo)
            },
            &metadata_collation
        )?
    } else {
        let loaded = load_cheap_project(Path::new(&physical_root), None)?;
        let mut graph = assemble_graph(
            &loaded,
            input.thresholds,
            NodeFields::default(),
            &metadata_collation,
        )?;
        graph.smells = input.smells.into_iter().map(InputSmell::owned).collect();
        if input.edges {
            graph.provenance = Provenance::Edges {
                ts_config: "fixture.json".into(),
                scope: EdgeScope::Package,
            };
        }
        graph
    };
    output.measured = observe!(
        calls,
        demlik_code_graph::smells::ledger::measured_rules,
        &graph
    );
    output.smells = graph.smells.clone();
    match observe!(
        calls,
        demlik_code_graph::smells::gate::run_smell_ledger_gate,
        &gate,
        &graph,
        input.json,
        input.pretty,
        &collation
    ) {
        Err(SmellLedgerError::Write(error)) => output.thrown = Some(api_failure("write", error)),
        Err(SmellLedgerError::Collation(error)) => return Err(error.into()),
        Err(SmellLedgerError::Json(error)) => {
            output.thrown = Some(Failure {
                stage: "write",
                name: "Error",
                message: error.to_string().into(),
                io_kind: None,
                callback_identity: false,
            })
        }
        Ok(rendered) => {
            output.ledger_at_emit.push(
                fs::read(gate.file.to_lossy())
                    .ok()
                    .map(|bytes| String::from_utf8_lossy(&bytes).as_ref().into()),
            );
            output.payloads.push(rendered.stdout.clone());
            let original = Rc::new(17);
            let expected = Rc::clone(&original);
            let emit = |_: &JsString| {
                if input.fail_emit {
                    Err(Rc::clone(&original))
                } else {
                    Ok(())
                }
            };
            if let Err(cause) = emit(&rendered.stdout) {
                output.thrown = Some(Failure {
                    stage: "emit",
                    name: "Error",
                    message: "original callback".into(),
                    io_kind: None,
                    callback_identity: Rc::ptr_eq(&cause, &expected),
                });
            } else {
                let mut io = CliIo::new(&mut output.stdout_bytes, &mut output.stderr_bytes, None);
                let destination = observe!(
                    calls,
                    demlik_code_graph::cli::io::output_to,
                    input.output_file.as_ref()
                );
                match destination.emit(&mut io, &rendered.stdout) {
                    Err(error) => output.thrown = Some(api_failure("emit", error)),
                    Ok(()) => {
                        observe!(
                            calls,
                            demlik_code_graph::cli::io::exit_with,
                            &mut io,
                            f64::from(rendered.exit_code)
                        )?;
                        output.exit = Some(rendered.exit_code);
                    }
                }
                output.process_exit = io.exit_state().stored_code();
                output.pending_stdio = io.pending_stdio_failures().len();
            }
        }
    }
    Ok(to_raw_value(&output)?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("native-preview manifest required")?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&manifest))?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let mut calls = vec![];
        let result = match request.operation.as_str() {
            "pure" => pure(serde_json::from_str(request.input.get())?, &mut calls)?,
            "targets" => targets(serde_json::from_str(request.input.get())?, &mut calls)?,
            "run" => run(
                serde_json::from_str(request.input.get())?,
                &binary,
                &mut calls,
            )?,
            _ => return Err("unknown operation".into()),
        };
        serde_json::to_writer(
            &mut stdout,
            &Response {
                id: &request.id,
                result,
                calls,
            },
        )?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
