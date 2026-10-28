use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::{NamedSymbol, analysis_inputs},
        assemble::{NodeFields, assemble_graph},
        functions::discover_functions,
        references::ReferenceResult,
    },
    project::{Collation, load_cheap_project},
    schema::{CallSite, Edges, ImportEdge, Thresholds},
    syntax::imports::resolve_imports,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::Path,
};
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Partition,
    Reports,
    Workflow,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputEdge {
    a: String,
    b: String,
    weight: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleLink {
    from: String,
    to: Option<String>,
    #[serde(default)]
    type_only: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallLink {
    caller_id: String,
    callee_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation: Operation,
    root: String,
    #[serde(default)]
    nodes: Vec<String>,
    #[serde(default)]
    edges: Vec<InputEdge>,
    #[serde(default)]
    module_links: Vec<ModuleLink>,
    #[serde(default)]
    call_links: Vec<CallLink>,
    #[serde(default)]
    package_dirs: Vec<String>,
    #[serde(default)]
    identifier_files: IndexMap<String, Vec<String>>,
    #[serde(default)]
    lookup_files: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    observed_calls: Vec<&'static str>,
}
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{$calls.push(stringify!($function));$function($($arg),*)}};}
fn execute(
    input: &Request,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let collation = Collation::try_node22_en_us()?;
    if matches!(input.operation, Operation::Partition) {
        let edges = input
            .edges
            .iter()
            .map(|e| demlik_code_graph::query::louvain::Edge {
                a: e.a.clone(),
                b: e.b.clone(),
                weight: e.weight,
            })
            .collect::<Vec<_>>();
        let part = observe!(
            calls,
            demlik_code_graph::query::louvain::louvain,
            &input.nodes,
            &edges,
            &collation
        )?;
        #[derive(Serialize)]
        struct Output<'a> {
            membership: Vec<(&'a String, &'a String)>,
            modularity: f64,
        }
        return Ok(to_raw_value(&Output {
            membership: part.membership.iter().collect(),
            modularity: part.modularity,
        })?);
    }
    let root = Path::new(&input.root);
    let loaded = load_cheap_project(root, None)?;
    let mut graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &collation,
    )?;
    let refs = if matches!(input.operation, Operation::Workflow) {
        let binary = TsgoBinary::from_native_preview_manifest(manifest)?;
        let config = root.join("tsconfig.json");
        let found = discover_functions(&loaded.source_files, &collation)?.functions;
        let inputs = analysis_inputs(found.iter().map(NamedSymbol::from));
        let imports = resolve_imports(root, &loaded.source_files, &config, &collation)?;
        let ids = found.iter().map(|f| f.id.clone()).collect::<Vec<_>>();
        let (mut edges, refs) = with_type_context(
            &binary,
            TypeContextInput {
                project: &loaded,
                ts_config_path: &config,
                functions: &found,
            },
            |context| {
                Ok(
                    (|| -> Result<_, demlik_code_graph::extract::ResolveError> {
                        let edges = demlik_code_graph::extract::edges::resolve_edges(
                            context, imports, &ids, &collation,
                        )?;
                        let refs = demlik_code_graph::extract::references::resolve_references(
                            context,
                            &inputs.names,
                            &inputs.exports_by_file,
                            &collation,
                        )?;
                        Ok((edges, refs))
                    })(),
                )
            },
        )??;
        for node in &mut graph.functions {
            node.edges = Some(Edges {
                calls: edges.calls_by_id.shift_remove(&node.id).unwrap_or_default(),
                called_by: edges
                    .called_by_id
                    .shift_remove(&node.id)
                    .unwrap_or_default(),
                call_chain_depth: edges
                    .chain_depth_by_id
                    .shift_remove(&node.id)
                    .unwrap_or_default(),
            });
        }
        for node in &mut graph.modules {
            node.imports = edges
                .imports_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
            node.imported_by = edges
                .imported_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
            node.import_edges = edges
                .import_edges_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
        }
        refs
    } else {
        for node in &mut graph.modules {
            node.import_edges = input
                .module_links
                .iter()
                .filter(|r| r.from == node.file)
                .map(|r| ImportEdge {
                    kind: demlik_code_graph::syntax::imports::ImportKind::Static,
                    specifier: r.to.as_deref().unwrap_or("external").into(),
                    target: r.to.clone(),
                    type_only: r.type_only,
                })
                .collect();
        }
        for node in &mut graph.functions {
            node.edges = Some(Edges {
                calls: input
                    .call_links
                    .iter()
                    .filter(|r| r.caller_id == node.id)
                    .map(|r| CallSite {
                        callee_id: r.callee_id.as_str().into(),
                        declaration: None,
                        line: 1,
                        const_args: vec![],
                    })
                    .collect(),
                called_by: vec![],
                call_chain_depth: 0,
            });
        }
        ReferenceResult {
            references_by_id: IndexMap::new(),
            module_scope_roots: vec![],
            test_module_scope_roots: vec![],
            identifier_files: input.identifier_files.clone(),
        }
    };
    let clusters = observe!(
        calls,
        demlik_code_graph::query::clusters::build_cluster_report,
        &graph.functions,
        &graph.modules,
        &collation
    )?;
    let width = observe!(
        calls,
        demlik_code_graph::query::interface_width::find_interface_width,
        &graph.functions,
        &refs,
        &input.package_dirs,
        &collation
    )?;
    let packages = input
        .lookup_files
        .iter()
        .map(|file| {
            observe!(
                calls,
                demlik_code_graph::query::interface_width::package_of,
                file,
                &input.package_dirs
            )
        })
        .collect::<Vec<_>>();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output<'a> {
        clusters: demlik_code_graph::schema::ClusterReport,
        interface_width: Vec<demlik_code_graph::schema::PackageWidth>,
        package_owners: Vec<&'a str>,
    }
    Ok(to_raw_value(&Output {
        clusters,
        interface_width: width,
        package_owners: packages,
    })?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("explicit native-preview manifest required")?;
    for line in io::stdin().lock().lines() {
        let mut calls = vec![];
        let response = match serde_json::from_str::<Request>(&line?) {
            Ok(input) => match execute(&input, Path::new(&manifest), &mut calls) {
                Ok(output) => Response {
                    id: Some(input.id),
                    ok: true,
                    output: Some(output),
                    error: None,
                    observed_calls: calls,
                },
                Err(e) => Response {
                    id: Some(input.id),
                    ok: false,
                    output: None,
                    error: Some(e.to_string()),
                    observed_calls: calls,
                },
            },
            Err(e) => Response {
                id: None,
                ok: false,
                output: None,
                error: Some(e.to_string()),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
