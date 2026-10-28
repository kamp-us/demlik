use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

use demlik_code_graph::checker::context::TypeContextInput;
use demlik_code_graph::declarations::uses::DeclarationUses;
use demlik_code_graph::extract::assemble::NodeFields;
use demlik_code_graph::extract::edges::EdgeResult;
use demlik_code_graph::extract::references::ReferenceResult;
use demlik_code_graph::project::EdgeScope;
use demlik_code_graph::schema::{Graph, Thresholds};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};

macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }

#[derive(Deserialize)]
struct Case {
    id: String,
    operation: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Package,
    Deep,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    scope: Option<Scope>,
    #[serde(default)]
    headers: bool,
    #[serde(default)]
    thresholds: Thresholds,
}
#[derive(Serialize)]
struct Joined {
    id: String,
    file: String,
    kind: Option<&'static str>,
    start: usize,
    line: usize,
}
#[derive(Serialize)]
struct Context {
    files: Vec<String>,
    joined: Vec<Joined>,
    unjoined: Vec<String>,
}
#[derive(Serialize)]
struct Details {
    context: Context,
    edges: EdgeResult,
    uses: DeclarationUses,
    references: ReferenceResult,
}
#[derive(Serialize)]
struct Output {
    graph: Graph,
    details: Details,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
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
) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    if case.operation != "code_graph.edges" {
        return Err(format!("unsupported operation: {}", case.operation));
    }
    let binary = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        manifest
    )
    .map_err(|error| error.to_string())?;
    let scope = match case.input.scope {
        Some(Scope::Deep) => EdgeScope::Deep,
        _ => EdgeScope::Package,
    };
    let repo_root = case.input.repo_root.as_deref().unwrap_or(&case.input.root);
    let loaded = observe!(
        calls,
        demlik_code_graph::project::load_edge_project,
        &case.input.root,
        scope,
        repo_root,
        None,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let functions = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &loaded.project.source_files,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?
    .functions;
    let declarations = observe!(
        calls,
        demlik_code_graph::declarations::discover::discover_declarations,
        &loaded.project.source_files,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let imports = observe!(
        calls,
        demlik_code_graph::syntax::imports::resolve_imports,
        &loaded.project.root_absolute,
        &loaded.project.source_files,
        &loaded.ts_config_path,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let ids: Vec<_> = functions
        .iter()
        .map(|function| function.id.clone())
        .collect();
    let names: IndexSet<_> = functions
        .iter()
        .map(|function| function.name.clone())
        .collect();
    let mut exported: IndexMap<String, Vec<String>> = IndexMap::new();
    for function in &functions {
        if function.is_exported {
            exported
                .entry(function.file.clone())
                .or_default()
                .push(function.id.clone());
        }
    }
    for bucket in exported.values_mut() {
        bucket.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    }
    let details = observe!(
        calls,
        demlik_code_graph::checker::context::with_type_context,
        &binary,
        TypeContextInput {
            project: &loaded.project,
            ts_config_path: &loaded.ts_config_path,
            functions: &functions
        },
        |context| {
            Ok(
                (|| -> Result<_, demlik_code_graph::extract::analysis::AnalysisError> {
                    let edges = observe!(
                        calls,
                        demlik_code_graph::extract::edges::resolve_edges,
                        context,
                        imports,
                        &ids,
                        &metadata_collation
                    )?;
                    let uses = observe!(
                        calls,
                        demlik_code_graph::declarations::uses::resolve_declaration_uses,
                        context,
                        &declarations,
                        &metadata_collation
                    )?;
                    let references = observe!(
                        calls,
                        demlik_code_graph::extract::references::resolve_references,
                        context,
                        &names,
                        &exported,
                        &metadata_collation
                    )?;
                    let mut joined = Vec::new();
                    for (node, id) in &context.node_to_id {
                        joined.push(Joined {
                            id: id.clone(),
                            file: context.relative_path(&node.source_file()),
                            kind: node.kind_name(),
                            start: observe!(
                                calls,
                                demlik_code_graph::engine::tsgo::NativeNode::start,
                                node
                            )?,
                            line: observe!(
                                calls,
                                demlik_code_graph::checker::context::TypeContext::start_line,
                                context,
                                node
                            )?,
                        });
                    }
                    Ok(Details {
                        context: Context {
                            files: context
                                .files
                                .iter()
                                .map(|file| file.unit.file.clone())
                                .collect(),
                            joined,
                            unjoined: context.unjoined.clone(),
                        },
                        edges,
                        uses,
                        references,
                    })
                })(),
            )
        }
    )
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let graph = observe!(
        calls,
        demlik_code_graph::extract::assemble::assemble_graph_with_edges,
        &loaded,
        case.input.thresholds,
        &binary,
        NodeFields {
            headers: case.input.headers
        },
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    to_raw_value(&Output { graph, details }).map_err(|error| error.to_string())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: edges_driver <native-preview-package.json>")?,
    );
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(case, &manifest, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(message) => Response {
                id,
                ok: false,
                output: None,
                error: Some(DriverError {
                    kind: "driver_error",
                    message,
                }),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
