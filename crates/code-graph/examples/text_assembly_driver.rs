use demlik_code_graph::checker::context::{TypeContext, TypeContextInput};
use demlik_code_graph::engine::tsgo::TsgoError;
use demlik_code_graph::extract::analysis::{AnalysisError, AnalysisOptions};
use demlik_code_graph::extract::assemble::{AssemblyError, NodeFields};
use demlik_code_graph::extract::wrangler_config::CatalogError;
use demlik_code_graph::kinds::glob::GlobError;
use demlik_code_graph::kinds::rules::NodeKindRules;
use demlik_code_graph::project::{EdgeScope, ProjectLoadError};
use demlik_code_graph::schema::{Graph, Thresholds};
use demlik_code_graph::text::{JsObject, JsString, JsValue};
use demlik_code_graph::validation::RecordTypeError;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    cell::Cell,
    error::Error,
    io::{self, Read, Write},
    path::PathBuf,
    rc::Rc,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let result = $function($($arg),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    ContextText,
    ContextPath,
    AssemblyText,
    AssemblyPath,
    GlobProjection,
}
#[derive(Deserialize)]
struct Tag {
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextRequest {
    #[serde(rename = "operation")]
    _operation: Operation,
    project: Project,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AssemblyRequest {
    #[serde(rename = "operation")]
    _operation: Operation,
    project: Project,
    #[serde(default = "empty_rules")]
    kind_rules: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobRequest {
    #[serde(rename = "operation")]
    _operation: Operation,
    pattern: JsString,
}
enum Request {
    ContextText {
        project: Project,
    },
    ContextPath {
        project: Project,
    },
    AssemblyText {
        project: Project,
        kind_rules: JsValue,
    },
    AssemblyPath {
        project: Project,
        kind_rules: JsValue,
    },
    GlobProjection {
        pattern: JsString,
    },
}
impl Request {
    fn parse(raw: &RawValue) -> Result<Self, serde_json::Error> {
        // RawValue fields need serde_json's direct deserializer, rather than enum buffering.
        let tag: Tag = serde_json::from_str(raw.get())?;
        match tag.operation {
            Operation::ContextText => {
                let value: ContextRequest = serde_json::from_str(raw.get())?;
                Ok(Self::ContextText {
                    project: value.project,
                })
            }
            Operation::ContextPath => {
                let value: ContextRequest = serde_json::from_str(raw.get())?;
                Ok(Self::ContextPath {
                    project: value.project,
                })
            }
            Operation::AssemblyText => {
                let value: AssemblyRequest = serde_json::from_str(raw.get())?;
                Ok(Self::AssemblyText {
                    project: value.project,
                    kind_rules: value.kind_rules,
                })
            }
            Operation::AssemblyPath => {
                let value: AssemblyRequest = serde_json::from_str(raw.get())?;
                Ok(Self::AssemblyPath {
                    project: value.project,
                    kind_rules: value.kind_rules,
                })
            }
            Operation::GlobProjection => {
                let value: GlobRequest = serde_json::from_str(raw.get())?;
                Ok(Self::GlobProjection {
                    pattern: value.pattern,
                })
            }
        }
    }
}
fn empty_rules() -> JsValue {
    JsValue::Object(JsObject::new())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Project {
    root: JsString,
    repo_root: JsString,
    native_preview_manifest: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextFacts {
    files: Vec<String>,
    joined_ids: Vec<String>,
    unjoined: Vec<String>,
    symbols: Vec<(String, Option<String>)>,
    borrowed_visits: usize,
}
#[derive(Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum Returned {
    Context(ContextFacts),
    Graph(Box<Graph>),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thrown {
    stage: &'static str,
    name: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_method: Option<String>,
}
#[derive(Serialize)]
struct Cause {
    kind: &'static str,
    message: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Returned>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thrown: Option<Thrown>,
    native_causes: Vec<Cause>,
    observed_calls: Vec<&'static str>,
}
enum Failure {
    Project(ProjectLoadError),
    Compiler(TsgoError),
    Assembly(AssemblyError),
    Projection(AssemblyError),
}
fn backend(error: &TsgoError) -> Option<String> {
    match error {
        TsgoError::Compiler { method, .. } => Some(method.clone()),
        _ => None,
    }
}
fn describe<'a>(failure: &'a Failure, calls: &mut Vec<&'static str>) -> (Thrown, &'a dyn Error) {
    match failure {
        Failure::Project(error) => (
            Thrown {
                stage: "load",
                name: "Error",
                message: error.message(),
                backend_method: None,
            },
            error,
        ),
        Failure::Compiler(error) => (
            Thrown {
                stage: "context",
                name: "Error",
                message: error.to_string().into(),
                backend_method: backend(error),
            },
            error,
        ),
        Failure::Assembly(error) | Failure::Projection(error) => (
            Thrown {
                stage: if matches!(failure, Failure::Projection(_)) {
                    "projection"
                } else {
                    "assembly"
                },
                name: observe!(
                    calls,
                    demlik_code_graph::extract::assemble::AssemblyError::name,
                    error
                ),
                message: observe!(
                    calls,
                    demlik_code_graph::extract::assemble::AssemblyError::message,
                    error
                ),
                backend_method: match error {
                    AssemblyError::Compiler(error) => backend(error),
                    _ => None,
                },
            },
            error,
        ),
    }
}
fn causes(error: &dyn Error) -> Vec<Cause> {
    let mut result = Vec::new();
    let mut source = error.source();
    while let Some(error) = source {
        let (kind, message) = if let Some(error) = error.downcast_ref::<AnalysisError>() {
            ("AnalysisError", error.message())
        } else if let Some(error) = error.downcast_ref::<CatalogError>() {
            ("CatalogError", error.message())
        } else if let Some(error) = error.downcast_ref::<RecordTypeError>() {
            ("RecordTypeError", error.message().clone())
        } else if let Some(GlobError::Syntax(message)) = error.downcast_ref::<GlobError>() {
            ("GlobError", message.clone())
        } else {
            ("native-error", error.to_string().into())
        };
        result.push(Cause { kind, message });
        source = error.source();
    }
    result
}
fn context_facts(
    context: &mut TypeContext<'_, '_>,
    visits: &Rc<Cell<usize>>,
) -> Result<ContextFacts, TsgoError> {
    visits.set(visits.get() + 1);
    let entries: Vec<_> = context
        .node_to_id
        .iter()
        .map(|(node, id)| (node.clone(), id.clone()))
        .collect();
    let mut symbols = Vec::new();
    for (node, id) in &entries {
        symbols.push((
            id.clone(),
            context.symbol_of(node)?.map(|symbol| symbol.name()),
        ));
    }
    Ok(ContextFacts {
        files: context
            .files
            .iter()
            .map(|file| file.unit.file.clone())
            .collect(),
        joined_ids: entries.into_iter().map(|(_, id)| id).collect(),
        unjoined: context.unjoined.clone(),
        symbols,
        borrowed_visits: visits.get(),
    })
}
fn run(
    project: &Project,
    text: bool,
    rules: Option<&NodeKindRules>,
    calls: &mut Vec<&'static str>,
) -> Result<Returned, Failure> {
    let binary = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        &project.native_preview_manifest
    )
    .map_err(Failure::Compiler)?;
    let root_native = PathBuf::from(project.root.to_lossy());
    let repo_native = PathBuf::from(project.repo_root.to_lossy());
    let loaded = if text {
        observe!(
            calls,
            demlik_code_graph::project::load_edge_project_text,
            &project.root,
            EdgeScope::Package,
            &repo_native,
            None
        )
    } else {
        observe!(
            calls,
            demlik_code_graph::project::load_edge_project,
            &root_native,
            EdgeScope::Package,
            &repo_native,
            None
        )
    }
    .map_err(Failure::Project)?;
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| Failure::Assembly(AssemblyError::Collation(error)))?;

    if let Some(rules) = rules {
        let options = AnalysisOptions {
            cross_runtime: true,
            kinds: true,
            reach: false,
            clusters: false,
            interface_width: false,
            kind_rules: rules,
            repo_root: &repo_native,
        };
        let graph = if text {
            observe!(
                calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
                &loaded,
                &project.root,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                &options,
                &metadata_collation
            )
        } else {
            observe!(
                calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_analysis,
                &loaded,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                &options,
                &metadata_collation
            )
        }
        .map_err(Failure::Assembly)?;
        return Ok(Returned::Graph(Box::new(graph)));
    }
    let functions = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &loaded.project.source_files,
        &metadata_collation
    )
    .map_err(|error| {
        Failure::Assembly(demlik_code_graph::extract::assemble::AssemblyError::Collation(error))
    })?
    .functions;
    let input = TypeContextInput {
        project: &loaded.project,
        ts_config_path: &loaded.ts_config_path,
        functions: &functions,
    };
    let visits = Rc::new(Cell::new(0));
    let read = |context: &mut TypeContext<'_, '_>| context_facts(context, &visits);
    let facts = if text {
        observe!(
            calls,
            demlik_code_graph::checker::context::with_type_context_text,
            &binary,
            input,
            &project.root,
            read
        )
    } else {
        observe!(
            calls,
            demlik_code_graph::checker::context::with_type_context,
            &binary,
            input,
            read
        )
    }
    .map_err(Failure::Compiler)?;
    Ok(Returned::Context(facts))
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let case: Case = serde_json::from_str(&input)?;
    let request = Request::parse(&case.input)?;
    let mut calls = Vec::new();
    let result = match &request {
        Request::ContextText { project } => run(project, true, None, &mut calls),
        Request::ContextPath { project } => run(project, false, None, &mut calls),
        Request::AssemblyText {
            project,
            kind_rules,
        }
        | Request::AssemblyPath {
            project,
            kind_rules,
        } => {
            let rules = NodeKindRules::parse(kind_rules)?;
            run(
                project,
                matches!(request, Request::AssemblyText { .. }),
                Some(&rules),
                &mut calls,
            )
        }
        Request::GlobProjection { pattern } => {
            let error = observe!(
                calls,
                demlik_code_graph::kinds::glob::glob_to_regexp,
                pattern
            )
            .err()
            .ok_or("glob projection needs an actually refused input")?;
            Err(Failure::Projection(AssemblyError::Analysis(
                AnalysisError::Convention(error),
            )))
        }
    };
    let (result, thrown, native_causes) = match result {
        Ok(value) => (Some(value), None, Vec::new()),
        Err(error) => {
            let (thrown, source) = describe(&error, &mut calls);
            (None, Some(thrown), causes(source))
        }
    };
    let response = Response {
        id: case.id,
        result,
        thrown,
        native_causes,
        observed_calls: calls,
    };
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &response)?;
    writeln!(output)?;
    Ok(())
}
