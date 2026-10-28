use demlik_code_graph::checker::context::TypeContextInput;
use demlik_code_graph::extract::cross_runtime::CrossRuntimeInput;
use demlik_code_graph::extract::edges::EdgeResult;
use demlik_code_graph::extract::wrangler_config::{BindingCatalog, CatalogError};
use demlik_code_graph::project::EdgeScope;
use demlik_code_graph::schema::CrossRuntimeEdge;
use demlik_code_graph::text::JsString;
use indexmap::IndexSet;
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
    scope: Option<EdgeScopeInput>,
    #[serde(default)]
    owner_files: Vec<String>,
    #[serde(default)]
    classes: IndexSet<JsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum EdgeScopeInput {
    Package,
    Deep,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Callee {
    callee_id: JsString,
    declaration: Option<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    caller_id: String,
    line: usize,
    callee: Option<Callee>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Details {
    methods: Vec<String>,
    probes: Vec<Probe>,
    edges: EdgeResult,
    cross_edges: Vec<CrossRuntimeEdge>,
    unjoined: Vec<String>,
}
#[derive(Serialize)]
struct Output {
    catalog: BindingCatalog,
    owners: Vec<Option<JsString>>,
    functions: usize,
    details: Details,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
impl DriverError {
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
            message: error.to_string(),
        }
    }
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string(),
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

    if case.operation != "code_graph.cross_runtime" {
        return Err(DriverError::transport(format!(
            "unsupported operation: {}",
            case.operation
        )));
    }
    let binary = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        manifest
    )
    .map_err(DriverError::backend)?;
    let repo = case.input.repo_root.as_deref().unwrap_or(&case.input.root);
    let scope = match case.input.scope {
        Some(EdgeScopeInput::Deep) => EdgeScope::Deep,
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
    let catalog = observe!(
        calls,
        demlik_code_graph::extract::wrangler_config::load_binding_catalog,
        repo,
        None,
        &metadata_collation
    )
    .map_err(|error| DriverError {
        kind: if matches!(error, CatalogError::Record(_)) {
            "type-error"
        } else {
            "backend-error"
        },
        message: error.to_string(),
    })?;
    let owners = case
        .input
        .owner_files
        .iter()
        .map(|file| {
            observe!(
                calls,
                demlik_code_graph::extract::cross_runtime::owner_of,
                &catalog.manifests,
                file
            )
            .map(|owner| owner.service.clone())
        })
        .collect();
    let functions = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &loaded.project.source_files,
        &metadata_collation
    )
    .map_err(DriverError::backend)?
    .functions;
    let ids = functions
        .iter()
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    let imports = observe!(
        calls,
        demlik_code_graph::syntax::imports::resolve_imports,
        &case.input.root,
        &loaded.project.source_files,
        &loaded.ts_config_path,
        &metadata_collation
    )
    .map_err(DriverError::backend)?;
    let input = || CrossRuntimeInput {
        catalog: &catalog,
        root_absolute: &case.input.root,
        repo_root: repo,
    };
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
                (|| -> Result<_, demlik_code_graph::extract::ResolveError> {
                    let methods = observe!(
                        calls,
                        demlik_code_graph::extract::cross_runtime::method_ids_of_classes,
                        context,
                        &case.input.classes
                    )?
                    .into_iter()
                    .collect();
                    let mut probe_resolver = observe!(
                        calls,
                        demlik_code_graph::extract::cross_runtime::create_cross_runtime_resolver,
                        input(),
                        context,
                        &metadata_collation
                    )?;
                    let mut probes = Vec::new();
                    for file in &context.files {
                        for node in file.source.root().descendants()? {
                            if !node.is_kind("CallExpression") {
                                continue;
                            }
                            let Some(caller_id) =
                                demlik_code_graph::extract::callee::resolve::enclosing_id(
                                    &node,
                                    &context.node_to_id,
                                )?
                            else {
                                continue;
                            };
                            let resolved = observe!(
                        calls,
                        demlik_code_graph::extract::cross_runtime::CrossRuntimeResolver::resolve,
                        &mut probe_resolver,
                        context,
                        &node,
                        &caller_id,
                        &context.relative_path(&node.source_file())
                    )?;
                            probes.push(Probe {
                                caller_id,
                                line: context.start_line(&node)?,
                                callee: resolved.map(|callee| Callee {
                                    callee_id: callee.callee_id,
                                    declaration: callee.declaration,
                                }),
                            });
                        }
                    }
                    let mut resolver = observe!(
                        calls,
                        demlik_code_graph::extract::cross_runtime::create_cross_runtime_resolver,
                        input(),
                        context,
                        &metadata_collation
                    )?;
                    let edges = observe!(
                        calls,
                        demlik_code_graph::extract::edges::resolve_edges_with_cross_runtime,
                        context,
                        imports,
                        &ids,
                        Some(&mut resolver),
                        &metadata_collation
                    )?;
                    let cross_edges = observe!(
                        calls,
                        demlik_code_graph::extract::cross_runtime::CrossRuntimeResolver::edges,
                        &resolver,
                        &metadata_collation
                    )?;
                    Ok(Details {
                        methods,
                        probes,
                        edges,
                        cross_edges,
                        unjoined: context.unjoined.clone(),
                    })
                })(),
            )
        }
    )
    .map_err(DriverError::backend)?
    .map_err(DriverError::backend)?;
    to_raw_value(&Output {
        catalog,
        owners,
        functions: functions.len(),
        details,
    })
    .map_err(DriverError::transport)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: cross_runtime_driver <native-preview-package.json>")?,
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
