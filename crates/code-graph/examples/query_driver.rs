use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

use demlik_code_graph::checker::context::TypeContextInput;
use demlik_code_graph::extract::assemble::NodeFields;
use demlik_code_graph::kinds::rules::CompiledRule;
use demlik_code_graph::project::EdgeScope;
use demlik_code_graph::schema::{EntryReach, NodeKind, Thresholds};
use demlik_code_graph::text::JsString;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};

macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryInput {
    root: PathBuf,
    #[serde(default)]
    extra_entry_files: Vec<String>,
    #[serde(default)]
    export_patterns: Vec<JsString>,
    #[serde(default)]
    test_support: Vec<RuleInput>,
    #[serde(default)]
    node_kinds: IndexMap<String, KindInput>,
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    package_dirs: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleInput {
    key: JsString,
    patterns: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
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
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Reach {
    Public,
    ServiceBinding,
    Platform,
}
impl KindInput {
    fn native(self) -> NodeKind {
        match self {
            Self::Entry { guards, reach } => NodeKind::Entry {
                evidence: vec!["adapter-entry".into()],
                guards: guards.into_iter().map(JsString::from).collect(),
                reach: match reach {
                    Reach::Public => EntryReach::Public,
                    Reach::ServiceBinding => EntryReach::ServiceBinding,
                    Reach::Platform => EntryReach::Platform,
                },
            },
            Self::Auth => NodeKind::Auth {
                evidence: vec!["adapter-auth".into()],
            },
            Self::Effect => NodeKind::Effect {
                evidence: vec!["adapter-effect".into()],
            },
            Self::Plain => NodeKind::Plain,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartitionInput {
    nodes: Vec<String>,
    edges: Vec<EdgeInput>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeInput {
    a: String,
    b: String,
    weight: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatternInput {
    source: JsString,
    values: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RulesInput {
    rules: Vec<RuleInput>,
    values: Vec<JsString>,
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

fn query(
    input: QueryInput,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
    metadata_collation: &demlik_code_graph::project::Collation,
) -> Result<Box<RawValue>, String> {
    let patterns: Vec<_> = input
        .export_patterns
        .iter()
        .map(|source| observe!(calls, demlik_code_graph::kinds::rules::JsRegex::new, source))
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    let support: Vec<_> = input
        .test_support
        .into_iter()
        .map(|rule| {
            Ok(CompiledRule {
                key: rule.key,
                patterns: rule
                    .patterns
                    .iter()
                    .map(|source| {
                        observe!(calls, demlik_code_graph::kinds::rules::JsRegex::new, source)
                    })
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect::<Result<_, regress::Error>>()
        .map_err(|error| error.to_string())?;
    let binary = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        manifest
    )
    .map_err(|error| error.to_string())?;
    let loaded = observe!(
        calls,
        demlik_code_graph::project::load_edge_project,
        &input.root,
        EdgeScope::Package,
        &input.root,
        None
    )
    .map_err(|error| error.to_string())?;
    let discovered = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &loaded.project.source_files,
        metadata_collation
    )
    .map_err(|error| error.to_string())?
    .functions;
    let inputs = observe!(
        calls,
        demlik_code_graph::extract::analysis::analysis_inputs,
        discovered
            .iter()
            .map(demlik_code_graph::extract::analysis::NamedSymbol::from)
    );
    let references = observe!(
        calls,
        demlik_code_graph::checker::context::with_type_context,
        &binary,
        TypeContextInput {
            project: &loaded.project,
            ts_config_path: &loaded.ts_config_path,
            functions: &discovered
        },
        |context| Ok(observe!(
            calls,
            demlik_code_graph::extract::references::resolve_references,
            context,
            &inputs.names,
            &inputs.exports_by_file,
            metadata_collation
        ))
    )
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let mut graph = observe!(
        calls,
        demlik_code_graph::extract::assemble::assemble_graph_with_edges,
        &loaded,
        Thresholds::default(),
        &binary,
        NodeFields::default(),
        metadata_collation
    )
    .map_err(|error| error.to_string())?;
    for (id, kind) in input.node_kinds {
        let node = graph
            .functions
            .iter_mut()
            .find(|node| node.id == id)
            .ok_or_else(|| format!("unknown function: {id}"))?;
        node.node_kind = Some(kind.native());
    }
    let invoked = observe!(
        calls,
        demlik_code_graph::query::reach::invoked_adjacency,
        &graph.functions
    );
    let full = observe!(
        calls,
        demlik_code_graph::query::reach::full_adjacency,
        &graph.functions,
        &references.references_by_id
    );
    let reachable = observe!(
        calls,
        demlik_code_graph::query::reach::reachable_from,
        &full,
        &input.roots
    );
    let surface = observe!(
        calls,
        demlik_code_graph::query::surface::public_surface_files,
        &graph.modules,
        &input.extra_entry_files,
        &patterns
    );
    let unreachable = observe!(
        calls,
        demlik_code_graph::query::unreachable::find_unreachable,
        &graph.functions,
        &graph.modules,
        &references,
        &input.extra_entry_files,
        &support,
        &patterns
    );
    let unguarded = observe!(
        calls,
        demlik_code_graph::query::unguarded::find_unguarded,
        &graph.functions
    );
    let width = observe!(
        calls,
        demlik_code_graph::query::interface_width::find_interface_width,
        &graph.functions,
        &references,
        &input.package_dirs
    );
    let packages: Vec<_> = graph
        .modules
        .iter()
        .map(|node| {
            observe!(
                calls,
                demlik_code_graph::query::interface_width::package_of,
                &node.file,
                &input.package_dirs
            )
        })
        .collect();
    let clusters = observe!(
        calls,
        demlik_code_graph::query::clusters::build_cluster_report,
        &graph.functions,
        &graph.modules
    );
    to_raw_value(&serde_json::json!({ "functionCount": graph.functions.len(), "invoked": invoked, "full": full, "reachable": reachable.into_iter().collect::<Vec<_>>(), "surface": surface.into_iter().collect::<Vec<_>>(), "unreachable": unreachable, "unguarded": unguarded, "width": width, "packages": packages, "clusters": clusters, "references": references })).map_err(|error| error.to_string())
}
fn execute(
    case: Case,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    match case.operation.as_str() {
        "code_graph.query" => query(
            serde_json::from_str(case.input.get()).map_err(|error| error.to_string())?,
            manifest,
            calls,
            &metadata_collation,
        ),
        "code_graph.partition" => {
            let input: PartitionInput =
                serde_json::from_str(case.input.get()).map_err(|error| error.to_string())?;
            let edges: Vec<_> = input
                .edges
                .into_iter()
                .map(|edge| demlik_code_graph::query::louvain::Edge {
                    a: edge.a,
                    b: edge.b,
                    weight: edge.weight,
                })
                .collect();
            let output = observe!(
                calls,
                demlik_code_graph::query::louvain::louvain,
                &input.nodes,
                &edges
            );
            let membership: Vec<_> = output.membership.iter().collect();
            to_raw_value(&serde_json::json!({ "membership": output.membership, "membershipEntries": membership, "modularity": output.modularity })).map_err(|error| error.to_string())
        }
        "code_graph.pattern" => {
            let input: PatternInput =
                serde_json::from_str(case.input.get()).map_err(|error| error.to_string())?;
            let pattern = observe!(
                calls,
                demlik_code_graph::kinds::rules::JsRegex::new,
                &input.source
            )
            .map_err(|error| error.to_string())?;
            let matches: Vec<_> = input
                .values
                .iter()
                .map(|value| {
                    observe!(
                        calls,
                        demlik_code_graph::kinds::rules::JsRegex::test,
                        &pattern,
                        value
                    )
                })
                .collect();
            to_raw_value(&matches).map_err(|error| error.to_string())
        }
        "code_graph.rules" => {
            let input: RulesInput =
                serde_json::from_str(case.input.get()).map_err(|error| error.to_string())?;
            let group = input
                .rules
                .into_iter()
                .map(|rule| (rule.key, rule.patterns))
                .collect();
            let rules = observe!(
                calls,
                demlik_code_graph::kinds::rules::compile_group,
                &group,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            let matches: Vec<_> = input
                .values
                .iter()
                .map(|value| {
                    observe!(
                        calls,
                        demlik_code_graph::kinds::rules::matching_rules,
                        &rules,
                        value
                    )
                })
                .collect();
            to_raw_value(&matches).map_err(|error| error.to_string())
        }
        other => Err(format!("unsupported operation: {other}")),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: query_driver <native-preview-package.json>")?,
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
