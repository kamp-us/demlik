use demlik_code_graph::{
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::AnalysisOptions,
        assemble::{NodeFields, assemble_graph},
    },
    kinds::rules::NodeKindRules,
    project::{EdgeScope, load_cheap_project},
    schema::{ReachabilityReport, Thresholds, UnreachableCategory, UnreachableSymbol},
    text::JsString,
    unreachable::{
        gate::{
            PreparedUnreachableGate, UnreachableMode, UnreachableOpts, UnreachableOutput,
            UnreachablePreparation, UnreachableRunError,
        },
        ledger::{
            UnreachableFinding, UnreachableLedger, UnreachableLedgerEntry, UnreachableWriteError,
        },
    },
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    cell::RefCell,
    fs,
    io::{self, BufRead, Write},
    path::Path,
    rc::Rc,
    sync::Arc,
};
macro_rules! observe { ($calls:expr, $f:path $(, $arg:expr)* $(,)?) => {{ $calls.push(stringify!($f)); $f($($arg),*) }}; }
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Dead,
    OnlyCalledFromTests,
}
impl From<Kind> for UnreachableCategory {
    fn from(value: Kind) -> Self {
        match value {
            Kind::Dead => Self::Dead,
            Kind::OnlyCalledFromTests => Self::OnlyCalledFromTests,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finding {
    scope: JsString,
    kind: Kind,
    id: JsString,
}
impl Finding {
    fn owned(self) -> UnreachableFinding {
        UnreachableFinding {
            scope: self.scope,
            kind: self.kind.into(),
            id: self.id,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    scope: JsString,
    kind: Kind,
    id: JsString,
    reason: JsString,
}
impl Entry {
    fn owned(self) -> Arc<UnreachableLedgerEntry> {
        Arc::new(UnreachableLedgerEntry {
            finding: UnreachableFinding {
                scope: self.scope,
                kind: self.kind.into(),
                id: self.id,
            },
            reason: self.reason,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenderInput {
    root: String,
    report: Option<RenderFacts>,
    json: bool,
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenderFacts {
    entry_count: usize,
    exported_count: usize,
    reachable_count: usize,
    unreachable: Vec<RenderSymbol>,
    withheld: Vec<RenderWithheld>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenderSymbol {
    id: String,
    file: String,
    start_line: usize,
    category: Kind,
    test_references: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderWithheld {
    id: String,
    reason: Reason,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Reason {
    ReferencedInNonTestFile,
    PublicEntrySurface,
    TestSupportSurface,
}
impl From<Reason> for demlik_code_graph::schema::WithheldReason {
    fn from(reason: Reason) -> Self {
        match reason {
            Reason::ReferencedInNonTestFile => Self::ReferencedInNonTestFile,
            Reason::PublicEntrySurface => Self::PublicEntrySurface,
            Reason::TestSupportSurface => Self::TestSupportSurface,
        }
    }
}
fn ordinary_render(
    input: RenderInput,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let loaded = load_cheap_project(Path::new(&input.root), None)?;
    let mut graph = assemble_graph(&loaded, Thresholds::default(), NodeFields::default())?;
    graph.reachability = input.report.map(|r| ReachabilityReport {
        entry_count: r.entry_count,
        exported_count: r.exported_count,
        reachable_count: r.reachable_count,
        unreachable: r
            .unreachable
            .into_iter()
            .map(|s| UnreachableSymbol {
                id: s.id,
                file: s.file,
                start_line: s.start_line,
                category: s.category.into(),
                test_references: s.test_references,
            })
            .collect(),
        withheld: r
            .withheld
            .into_iter()
            .map(|s| demlik_code_graph::schema::WithheldSymbol {
                id: s.id,
                reason: s.reason.into(),
            })
            .collect(),
        unguarded: vec![],
    });
    let text = observe!(
        calls,
        demlik_code_graph::render::analysis::render_unreachable,
        &graph,
        input.json,
        input.pretty
    )?;
    Ok(to_raw_value(&text)?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsString,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
struct Response<'a> {
    id: &'a JsString,
    result: Box<RawValue>,
    calls: Vec<&'static str>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pure {
    scope: JsString,
    gated: Vec<Kind>,
    findings: Vec<Finding>,
    entries: Vec<Entry>,
    reason: JsString,
    json: bool,
    pretty: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PureResult<'a> {
    keys: Vec<String>,
    ledger: &'a UnreachableLedger,
    serialized: String,
    result: demlik_code_graph::unreachable::ledger::UnreachableReconciliation<'a>,
    accepted: UnreachableLedger,
    accepted_all: UnreachableLedger,
    gate: demlik_code_graph::unreachable::render::UnreachableRender,
    accepted_text: JsString,
    unrecorded_identity: Vec<i64>,
    pruned_identity: Vec<i64>,
    kept_identity: Vec<i64>,
}
fn pure(
    input: Pure,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let collation = observe!(
        calls,
        demlik_code_graph::project::Collation::try_node22_en_us
    )?;
    let entries: Vec<_> = input.entries.into_iter().map(Entry::owned).collect();
    let findings: Vec<_> = input.findings.into_iter().map(Finding::owned).collect();
    let gated: Vec<_> = input.gated.into_iter().map(Into::into).collect();
    let ledger = observe!(
        calls,
        demlik_code_graph::unreachable::ledger::unreachable_ledger_of,
        &entries,
        &collation
    )?;
    let keys = findings
        .iter()
        .map(|f| {
            observe!(
                calls,
                demlik_code_graph::unreachable::ledger::finding_key,
                f
            )
        })
        .collect();
    let result = observe!(
        calls,
        demlik_code_graph::unreachable::ledger::reconcile_unreachable,
        &ledger,
        &input.scope,
        &findings,
        &gated,
        &collation
    )?;
    let accepted = observe!(
        calls,
        demlik_code_graph::unreachable::ledger::with_accepted_findings,
        &result.kept,
        &result.unrecorded,
        &input.reason,
        &collation
    )?;
    let accepted_all = observe!(
        calls,
        demlik_code_graph::unreachable::ledger::with_accepted_findings,
        &ledger,
        &findings.iter().collect::<Vec<_>>(),
        &input.reason,
        &collation
    )?;
    let serialized = observe!(
        calls,
        demlik_code_graph::unreachable::ledger::serialize_unreachable_ledger,
        &ledger,
        &collation
    )?;
    let gate = observe!(
        calls,
        demlik_code_graph::unreachable::render::render_unreachable_gate,
        &result,
        input.json,
        input.pretty
    )?;
    let accepted_text = observe!(
        calls,
        demlik_code_graph::unreachable::render::render_accepted_dead,
        &result,
        &input.reason,
        input.json,
        input.pretty
    )?;
    let unrecorded_identity = result
        .unrecorded
        .iter()
        .map(|f| {
            findings
                .iter()
                .position(|v| std::ptr::eq(*f, v))
                .map_or(-1, |index| index as i64)
        })
        .collect();
    let pruned_identity = result
        .pruned
        .iter()
        .map(|f| {
            entries
                .iter()
                .position(|v| Arc::ptr_eq(v, f))
                .map_or(-1, |index| index as i64)
        })
        .collect();
    let kept_identity = result
        .kept
        .entries
        .iter()
        .map(|f| {
            entries
                .iter()
                .position(|v| Arc::ptr_eq(v, f))
                .map_or(-1, |index| index as i64)
        })
        .collect();
    Ok(to_raw_value(&PureResult {
        keys,
        ledger: &ledger,
        serialized,
        result,
        accepted,
        accepted_all,
        gate,
        accepted_text,
        unrecorded_identity,
        pruned_identity,
        kept_identity,
    })?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Run {
    root: JsString,
    repo_root: JsString,
    #[serde(default)]
    project: bool,
    #[serde(default)]
    prepare: bool,
    #[serde(default)]
    unreachable: bool,
    #[serde(default)]
    ci: bool,
    #[serde(default)]
    accept_dead: bool,
    #[serde(default)]
    dead_only: bool,
    reason: Option<JsString>,
    file: JsString,
    scope: JsString,
    #[serde(default)]
    accept: bool,
    #[serde(default)]
    entries: Vec<Entry>,
    gated: Vec<Kind>,
    reach: Option<Vec<Symbol>>,
    json: bool,
    pretty: bool,
    #[serde(default)]
    fail_emit: bool,
    #[serde(default)]
    fail_report: bool,
    output_file: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Symbol {
    id: String,
    kind: Kind,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    exit: Option<i32>,
    thrown: Option<Failure>,
    emitted: Vec<JsString>,
    reported: Vec<JsString>,
    ledger_at_emit: Vec<Option<String>>,
    preparation: Option<UnreachablePreparation>,
    source_files: Option<usize>,
    symbols: Option<Vec<UnreachableSymbol>>,
}
fn run(
    input: Run,
    binary: &TsgoBinary,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let collation = observe!(
        calls,
        demlik_code_graph::project::Collation::try_node22_en_us
    )?;
    let mut output = RunResult {
        exit: None,
        thrown: None,
        emitted: vec![],
        reported: vec![],
        ledger_at_emit: vec![],
        preparation: None,
        source_files: None,
        symbols: None,
    };
    let gate = if input.prepare {
        let prep = observe!(
            calls,
            demlik_code_graph::unreachable::gate::prepare_unreachable_gate,
            UnreachableOpts {
                unreachable: input.unreachable,
                ci: input.ci,
                accept_dead: input.accept_dead,
                dead_only: input.dead_only,
                boundaries: false,
                reason: input.reason.as_ref()
            },
            &input.root,
            &input.repo_root,
            &collation
        )?;
        match prep {
            UnreachablePreparation::Prepared { gate } => gate,
            other => {
                output.preparation = Some(other);
                return Ok(to_raw_value(&output)?);
            }
        }
    } else {
        PreparedUnreachableGate {
            file: input.file.clone(),
            scope: input.scope,
            mode: if input.accept {
                UnreachableMode::Accept {
                    reason: input.reason.unwrap_or_default(),
                }
            } else {
                UnreachableMode::Gate {
                    gated: input.gated.into_iter().map(Into::into).collect(),
                }
            },
            ledger: UnreachableLedger {
                entries: input.entries.into_iter().map(Entry::owned).collect(),
            },
        }
    };
    let physical_root = input.root.to_lossy();
    let physical_repo = input.repo_root.to_lossy();
    let graph = if input.project {
        let loaded = observe!(
            calls,
            demlik_code_graph::project::load_edge_project_text,
            &input.root,
            EdgeScope::Package,
            Path::new(&physical_repo),
            None
        )?;
        output.source_files = Some(loaded.project.source_files.len());
        let rules = NodeKindRules::default();
        observe!(
            calls,
            demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
            &loaded,
            &input.root,
            Thresholds::default(),
            binary,
            NodeFields::default(),
            &AnalysisOptions {
                cross_runtime: false,
                kinds: false,
                reach: true,
                clusters: false,
                interface_width: false,
                kind_rules: &rules,
                repo_root: Path::new(&physical_repo)
            }
        )?
    } else {
        let loaded = load_cheap_project(Path::new(&physical_root), None)?;
        let mut graph = assemble_graph(&loaded, Thresholds::default(), NodeFields::default())?;
        graph.reachability = input.reach.map(|symbols| ReachabilityReport {
            entry_count: 0,
            exported_count: symbols.len(),
            reachable_count: 0,
            unreachable: symbols
                .into_iter()
                .map(|symbol| UnreachableSymbol {
                    id: symbol.id,
                    file: "fixture.ts".into(),
                    start_line: 1,
                    category: symbol.kind.into(),
                    test_references: vec![],
                })
                .collect(),
            withheld: vec![],
            unguarded: vec![],
        });
        graph
    };
    output.symbols = graph.reachability.as_ref().map(|r| {
        r.unreachable
            .iter()
            .map(|s| UnreachableSymbol {
                id: s.id.clone(),
                file: s.file.clone(),
                start_line: s.start_line,
                category: s.category,
                test_references: s.test_references.clone(),
            })
            .collect()
    });
    let original = Rc::new(17);
    let expected = Rc::clone(&original);
    let emitted = RefCell::new(vec![]);
    let reported = RefCell::new(vec![]);
    let snapshots = RefCell::new(vec![]);
    let mut emit = |payload: &JsString| -> Result<(), Rc<i32>> {
        snapshots.borrow_mut().push(
            fs::read(gate.file.to_lossy())
                .ok()
                .map(|b| String::from_utf8_lossy(&b).into_owned()),
        );
        if let Some(file) = &input.output_file {
            fs::write(file.to_lossy(), payload.to_lossy()).map_err(|_| Rc::clone(&original))?;
        }
        emitted.borrow_mut().push(payload.clone());
        if input.fail_emit {
            Err(Rc::clone(&original))
        } else {
            Ok(())
        }
    };
    let mut report = |payload: &JsString| -> Result<(), Rc<i32>> {
        reported.borrow_mut().push(payload.clone());
        if input.fail_report {
            Err(Rc::clone(&original))
        } else {
            Ok(())
        }
    };
    match observe!(
        calls,
        demlik_code_graph::unreachable::gate::run_unreachable_gate,
        &gate,
        &graph,
        UnreachableOutput {
            emit: &mut emit,
            report: &mut report,
            json: input.json,
            pretty: input.pretty
        },
        &collation
    ) {
        Ok(code) => output.exit = Some(code),
        Err(error) => {
            output.thrown = Some(match error {
                UnreachableRunError::Collation(cause)
                | UnreachableRunError::Write(UnreachableWriteError::Collation(cause)) => Failure {
                    stage: "collation",
                    name: "Error",
                    message: cause.to_string().into(),
                    io_kind: None,
                    callback_identity: false,
                },
                UnreachableRunError::Emit(cause) => Failure {
                    stage: "emit",
                    name: "Error",
                    message: "original callback".into(),
                    io_kind: None,
                    callback_identity: Rc::ptr_eq(&cause, &expected),
                },
                UnreachableRunError::Report(cause) => Failure {
                    stage: "report",
                    name: "Error",
                    message: "original callback".into(),
                    io_kind: None,
                    callback_identity: Rc::ptr_eq(&cause, &expected),
                },
                UnreachableRunError::Render(cause) => Failure {
                    stage: "render",
                    name: "Error",
                    message: cause.to_string().into(),
                    io_kind: None,
                    callback_identity: false,
                },
                UnreachableRunError::Write(UnreachableWriteError::Json(cause)) => Failure {
                    stage: "write",
                    name: "Error",
                    message: cause.to_string().into(),
                    io_kind: None,
                    callback_identity: false,
                },
                UnreachableRunError::Write(UnreachableWriteError::Io { source, .. }) => Failure {
                    stage: "write",
                    name: "Error",
                    message: source.to_string().into(),
                    io_kind: Some(format!("{:?}", source.kind())),
                    callback_identity: false,
                },
            })
        }
    }
    output.emitted = emitted.into_inner();
    output.reported = reported.into_inner();
    output.ledger_at_emit = snapshots.into_inner();
    Ok(to_raw_value(&output)?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("native-preview package manifest required")?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&manifest))?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let request: Request = serde_json::from_str(&line)?;
        let mut calls = vec![];
        let result = match request.operation.as_str() {
            "pure" => pure(serde_json::from_str(request.input.get())?, &mut calls)?,
            "ordinary-render" => {
                ordinary_render(serde_json::from_str(request.input.get())?, &mut calls)?
            }
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
