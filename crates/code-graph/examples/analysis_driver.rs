use demlik_code_graph::extract::analysis::{AnalysisError, AnalysisOptions};
use demlik_code_graph::extract::assemble::{AssemblyError, NodeFields};
use demlik_code_graph::extract::package_exports::Manifest;
use demlik_code_graph::extract::wrangler_config::CatalogError;
use demlik_code_graph::kinds::{glob::GlobError, rules::RuleInputError};
use demlik_code_graph::project::EdgeScope;
use demlik_code_graph::schema::{Graph, Thresholds};
use demlik_code_graph::text::{JsObject, JsString, JsValue};
use demlik_code_graph::validation::InputIssue;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    scope: Option<Scope>,
    #[serde(default)]
    headers: bool,
    #[serde(default)]
    thresholds: Thresholds,
    analysis: AnalysisInput,
    #[serde(default = "root_package")]
    package_dirs: Vec<String>,
    #[serde(default)]
    pattern_files: Vec<JsString>,
}
fn root_package() -> Vec<String> {
    vec![String::new()]
}
fn empty_rules() -> JsValue {
    JsValue::Object(JsObject::new())
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Package,
    Deep,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnalysisInput {
    #[serde(default)]
    cross_runtime: bool,
    #[serde(default)]
    kinds: bool,
    #[serde(default)]
    reach: bool,
    #[serde(default)]
    clusters: bool,
    #[serde(default)]
    interface_width: bool,
    #[serde(default = "empty_rules")]
    kind_rules: JsValue,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    dir: String,
    manifest: Option<Manifest>,
    name: Option<JsString>,
    source_entry: Option<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    graph: Graph,
    packages: Vec<Package>,
    pattern_files: Vec<JsString>,
    pattern_matches: Vec<Vec<bool>>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue: Option<Box<InputIssue>>,
}
impl DriverError {
    fn new(kind: &'static str, message: impl Into<JsString>) -> Self {
        Self {
            kind,
            message: message.into(),
            issue: None,
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self::new("backend-error", error.to_string())
    }
    fn transport(error: impl std::fmt::Display) -> Self {
        Self::new("driver-error", error.to_string())
    }
}
impl From<RuleInputError> for DriverError {
    fn from(error: RuleInputError) -> Self {
        match error {
            RuleInputError::Issue(issue) => Self {
                kind: "schema-issue",
                message: issue.message().clone(),
                issue: Some(Box::new(issue)),
            },
            RuleInputError::TypeError(message) => Self::new("type-error", message),
        }
    }
}
impl From<AssemblyError> for DriverError {
    fn from(error: AssemblyError) -> Self {
        match error {
            AssemblyError::Analysis(AnalysisError::Catalog(CatalogError::Record(error))) => {
                Self::new("type-error", error.message().clone())
            }
            AssemblyError::Analysis(AnalysisError::Pattern(error)) => {
                Self::new("regex-error", error.to_string())
            }
            AssemblyError::Analysis(AnalysisError::Convention(GlobError::Syntax(message))) => {
                Self::new("glob-error", message)
            }
            error => Self::backend(error),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DriverError>,
    observed_calls: Vec<&'static str>,
}
fn execute(
    case: Case,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, DriverError> {
    let metadata_collation =
        demlik_code_graph::project::Collation::try_node22_en_us().map_err(DriverError::backend)?;

    if case.operation != "code_graph.analysis" {
        return Err(DriverError::transport(format!(
            "unsupported operation: {}",
            case.operation
        )));
    }
    let rules = observe!(
        calls,
        demlik_code_graph::kinds::rules::NodeKindRules::parse,
        &case.input.analysis.kind_rules
    )?;
    let binary = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        manifest
    )
    .map_err(DriverError::backend)?;
    let repo = case.input.repo_root.as_deref().unwrap_or(&case.input.root);
    let scope = match case.input.scope {
        Some(Scope::Deep) => EdgeScope::Deep,
        _ => EdgeScope::Package,
    };
    let loaded = observe!(
        calls,
        demlik_code_graph::project::load_edge_project,
        &case.input.root,
        scope,
        repo,
        None
    )
    .map_err(DriverError::backend)?;
    let options = AnalysisOptions {
        cross_runtime: case.input.analysis.cross_runtime,
        kinds: case.input.analysis.kinds,
        reach: case.input.analysis.reach,
        clusters: case.input.analysis.clusters,
        interface_width: case.input.analysis.interface_width,
        kind_rules: &rules,
        repo_root: repo,
    };
    let graph = observe!(
        calls,
        demlik_code_graph::extract::assemble::assemble_graph_with_analysis,
        &loaded,
        case.input.thresholds,
        &binary,
        NodeFields {
            headers: case.input.headers
        },
        &options,
        &metadata_collation
    )?;
    let mut packages = Vec::new();
    for dir in &case.input.package_dirs {
        let manifest = observe!(
            calls,
            demlik_code_graph::extract::package_exports::read_manifest,
            repo,
            dir
        );
        let name = manifest
            .as_ref()
            .and_then(|manifest| {
                observe!(
                    calls,
                    demlik_code_graph::extract::package_exports::package_name,
                    manifest
                )
            })
            .cloned();
        let source_entry = observe!(
            calls,
            demlik_code_graph::extract::package_exports::package_source_entry,
            repo,
            dir,
            &metadata_collation
        )
        .map_err(DriverError::backend)?;
        packages.push(Package {
            dir: dir.clone(),
            manifest,
            name,
            source_entry,
        });
    }
    let patterns = observe!(
        calls,
        demlik_code_graph::extract::package_exports::public_export_patterns,
        repo,
        &case.input.root,
        &case.input.package_dirs
    )
    .map_err(DriverError::backend)?;
    let pattern_files = graph
        .modules
        .iter()
        .map(|module| JsString::from(module.file.as_str()))
        .chain(case.input.pattern_files)
        .collect::<Vec<_>>();
    let pattern_matches = patterns
        .iter()
        .map(|pattern| {
            pattern_files
                .iter()
                .map(|file| pattern.test(file))
                .collect()
        })
        .collect();
    to_raw_value(&Output {
        graph,
        packages,
        pattern_files,
        pattern_matches,
    })
    .map_err(DriverError::transport)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: analysis_driver <native-preview-package.json>")?,
    );
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(DriverError::transport)
            .and_then(|case| execute(case, &manifest, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(error) => Response {
                id,
                ok: false,
                output: None,
                error: Some(error),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
