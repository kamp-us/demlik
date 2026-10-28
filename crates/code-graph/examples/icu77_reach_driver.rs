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
    Reach,
    Workflow,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleLink {
    from: String,
    to: Option<String>,
    #[serde(default)]
    type_only: bool,
    #[serde(default)]
    kind: ModuleKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallLink {
    caller_id: String,
    callee_id: String,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
enum ModuleKind {
    #[default]
    Static,
    ExportFrom,
    Dynamic,
}
impl ModuleKind {
    fn native(&self) -> demlik_code_graph::schema::ImportEdgeKind {
        use demlik_code_graph::schema::ImportEdgeKind;
        match self {
            Self::Static => ImportEdgeKind::Static,
            Self::ExportFrom => ImportEdgeKind::ExportFrom,
            Self::Dynamic => ImportEdgeKind::Dynamic,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Reach {
    Public,
    ServiceBinding,
    Platform,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum KindInput {
    Entry {
        #[serde(default)]
        guards: Vec<String>,
        reach: Reach,
    },
    Auth,
    Effect,
    Plain,
}
impl KindInput {
    fn native(&self) -> demlik_code_graph::schema::NodeKind {
        use demlik_code_graph::schema::{EntryReach, NodeKind};
        match self {
            Self::Entry { guards, reach } => NodeKind::Entry {
                evidence: vec!["fixture".into()],
                guards: guards.iter().map(|guard| guard.as_str().into()).collect(),
                reach: match reach {
                    Reach::Public => EntryReach::Public,
                    Reach::ServiceBinding => EntryReach::ServiceBinding,
                    Reach::Platform => EntryReach::Platform,
                },
            },
            Self::Auth => NodeKind::Auth {
                evidence: vec!["fixture".into()],
            },
            Self::Effect => NodeKind::Effect {
                evidence: vec!["fixture".into()],
            },
            Self::Plain => NodeKind::Plain,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleInput {
    key: demlik_code_graph::text::JsString,
    patterns: Vec<demlik_code_graph::text::JsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation: Operation,
    root: String,
    #[serde(default)]
    module_links: Vec<ModuleLink>,
    #[serde(default)]
    calls: Vec<CallLink>,
    #[serde(default)]
    function_order: Option<Vec<String>>,
    #[serde(default)]
    kinds: IndexMap<String, KindInput>,
    #[serde(default)]
    references_by_id: IndexMap<String, Vec<String>>,
    #[serde(default)]
    identifier_files: IndexMap<String, Vec<String>>,
    #[serde(default)]
    module_scope_roots: Vec<String>,
    #[serde(default)]
    test_module_scope_roots: Vec<String>,
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    extra_entry_files: Vec<String>,
    #[serde(default)]
    test_support: Vec<RuleInput>,
    #[serde(default)]
    export_patterns: Vec<demlik_code_graph::text::JsString>,
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
        let inputs = analysis_inputs(found.iter().map(NamedSymbol::from), &collation)?;
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
                    kind: r.kind.native(),
                    specifier: r.to.as_deref().unwrap_or("external").into(),
                    target: r.to.clone(),
                    type_only: r.type_only,
                })
                .collect();
        }
        for node in &mut graph.functions {
            node.edges = Some(Edges {
                calls: input
                    .calls
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
            references_by_id: input.references_by_id.clone(),
            module_scope_roots: input.module_scope_roots.clone(),
            test_module_scope_roots: input.test_module_scope_roots.clone(),
            identifier_files: input.identifier_files.clone(),
        }
    };
    for node in &mut graph.functions {
        if let Some(kind) = input.kinds.get(&node.id) {
            node.node_kind = Some(kind.native());
        }
    }
    if let Some(order) = &input.function_order {
        graph.functions.sort_by_key(|f| {
            order
                .iter()
                .position(|id| id == &f.id)
                .unwrap_or(order.len())
        });
    }
    let support = input
        .test_support
        .iter()
        .map(|rule| {
            Ok(demlik_code_graph::kinds::rules::CompiledRule {
                key: rule.key.clone(),
                patterns: rule
                    .patterns
                    .iter()
                    .map(demlik_code_graph::text::JsRegex::new)
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, regress::Error>>()?;
    let patterns = input
        .export_patterns
        .iter()
        .map(demlik_code_graph::text::JsRegex::new)
        .collect::<Result<Vec<_>, _>>()?;
    let invoked = observe!(
        calls,
        demlik_code_graph::query::reach::invoked_adjacency,
        &graph.functions,
        &collation
    )?;
    let full = observe!(
        calls,
        demlik_code_graph::query::reach::full_adjacency,
        &graph.functions,
        &refs.references_by_id,
        &collation
    )?;
    let reachable = observe!(
        calls,
        demlik_code_graph::query::reach::reachable_from,
        &full,
        &input.roots
    )
    .into_iter()
    .collect();
    let surface = observe!(
        calls,
        demlik_code_graph::query::surface::public_surface_files,
        &graph.modules,
        &input.extra_entry_files,
        &patterns
    )
    .into_iter()
    .collect();
    let unreachable = observe!(
        calls,
        demlik_code_graph::query::unreachable::find_unreachable,
        &graph.functions,
        &graph.modules,
        &refs,
        &input.extra_entry_files,
        &support,
        &patterns,
        &collation
    )?;
    let unguarded = observe!(
        calls,
        demlik_code_graph::query::unguarded::find_unguarded,
        &graph.functions,
        &collation
    )?;
    #[derive(Serialize)]
    struct Output<'a> {
        invoked: Vec<(&'a String, &'a Vec<String>)>,
        full: Vec<(&'a String, &'a Vec<String>)>,
        reachable: Vec<String>,
        surface: Vec<String>,
        unreachable: demlik_code_graph::query::unreachable::UnreachableResult,
        unguarded: Vec<demlik_code_graph::schema::UnguardedEffect>,
    }
    Ok(to_raw_value(&Output {
        invoked: invoked.iter().collect(),
        full: full.iter().collect(),
        reachable,
        surface,
        unreachable,
        unguarded,
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
