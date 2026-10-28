use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::{NamedSymbol, analysis_inputs},
        assemble::{NodeFields, assemble_graph},
        functions::{DiscoveredFunction, FunctionKind},
    },
    kinds::{
        classify::ClassifyContext,
        declarations::{RuleMap, public_method_rules_by_base_class},
        rules::NodeKindRules,
    },
    project::{Collation, load_cheap_project},
    schema::{CallSite, Edges, Thresholds},
    syntax::imports::resolve_imports,
    text::{JsString, JsValue},
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputCall {
    callee_id: JsString,
    declaration: Option<JsString>,
    line: usize,
    const_args: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    root: String,
    rules: Option<JsValue>,
    conventions: Option<JsValue>,
    #[serde(default)]
    maps: Vec<RuleMap>,
    #[serde(default)]
    extra_evidence: Vec<JsString>,
    #[serde(default)]
    guards: Vec<JsString>,
    #[serde(default)]
    calls: Vec<InputCall>,
    package_path: Option<JsString>,
    #[serde(default)]
    export_names: Vec<JsString>,
}
#[derive(Serialize)]
struct Failure {
    name: &'static str,
    message: JsString,
}
impl Failure {
    fn error(error: impl std::fmt::Display) -> Self {
        Self {
            name: "Error",
            message: error.to_string().into(),
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
    error: Option<Failure>,
    observed_calls: Vec<&'static str>,
}
macro_rules! observe {
    ($calls:expr,$function:path $(,$arg:expr)* $(,)?) => {{ $calls.push(stringify!($function)); $function($($arg),*) }};
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Found<'a> {
    id: &'a str,
    name: &'a str,
    kind: FunctionKind,
    file: &'a str,
    start_line: usize,
    end_line: usize,
    is_exported: bool,
    is_test: bool,
}
fn found_rows(rows: &[DiscoveredFunction]) -> Vec<Found<'_>> {
    rows.iter()
        .map(|r| Found {
            id: &r.id,
            name: &r.name,
            kind: r.kind,
            file: &r.file,
            start_line: r.start_line,
            end_line: r.end_line,
            is_exported: r.is_exported,
            is_test: r.is_test,
        })
        .collect()
}
fn execute(
    input: &Request,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Failure> {
    let collation = Collation::try_node22_en_us().map_err(Failure::error)?;
    if ["merge", "merge-entries"].contains(&input.operation.as_str()) {
        let merged = observe!(
            calls,
            demlik_code_graph::kinds::declarations::merge_rule_maps,
            input.maps.iter(),
            &collation
        )
        .map_err(Failure::error)?;
        return if input.operation == "merge-entries" {
            to_raw_value(&merged.iter().collect::<Vec<_>>()).map_err(Failure::error)
        } else {
            to_raw_value(&merged).map_err(Failure::error)
        };
    }
    let rule_value = input
        .rules
        .as_ref()
        .cloned()
        .unwrap_or_else(|| JsValue::Object(IndexMap::new()));
    if input.operation == "conventions" {
        let rules = NodeKindRules::parse(&JsValue::Object(IndexMap::from([(
            "entryExportConventions".into(),
            input
                .conventions
                .as_ref()
                .cloned()
                .unwrap_or_else(|| JsValue::Object(IndexMap::new())),
        )])))
        .map_err(Failure::error)?;
        let compiled = observe!(
            calls,
            demlik_code_graph::kinds::conventions::compile_conventions,
            &rules.entry_export_conventions,
            &collation
        )
        .map_err(Failure::error)?;
        let matched = observe!(
            calls,
            demlik_code_graph::kinds::conventions::matching_conventions,
            &compiled,
            input
                .package_path
                .as_ref()
                .ok_or_else(|| Failure::error("packagePath required"))?,
            &input.export_names,
            &collation
        )
        .map_err(Failure::error)?;
        #[derive(Serialize)]
        struct Output<'a> {
            compiled: Vec<&'a JsString>,
            matched: Vec<JsString>,
        }
        return to_raw_value(&Output {
            compiled: compiled.iter().map(|c| &c.name).collect(),
            matched,
        })
        .map_err(Failure::error);
    }
    if !["syntax", "graph", "classify"].contains(&input.operation.as_str()) {
        return Err(Failure::error("unknown operation"));
    }
    let root = Path::new(&input.root);
    let loaded = load_cheap_project(root, None).map_err(Failure::error)?;
    let found = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &loaded.source_files,
        &collation
    )
    .map_err(Failure::error)?
    .functions;
    if input.operation == "syntax" {
        #[derive(Serialize)]
        struct Output<'a> {
            functions: Vec<Found<'a>>,
        }
        return to_raw_value(&Output {
            functions: found_rows(&found),
        })
        .map_err(Failure::error);
    }
    let rules = NodeKindRules::parse(&rule_value).map_err(Failure::error)?;
    let compiled = observe!(
        calls,
        demlik_code_graph::kinds::classify::compile_kind_rules,
        &rules,
        &collation
    )
    .map_err(Failure::error)?;
    let mut graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &collation,
    )
    .map_err(Failure::error)?;
    if input.operation == "classify" {
        let node = graph
            .functions
            .iter_mut()
            .find(|f| f.name == "subject")
            .ok_or_else(|| Failure::error("subject missing"))?;
        if !input.calls.is_empty() {
            node.edges = Some(Edges {
                calls: input
                    .calls
                    .iter()
                    .map(|r| CallSite {
                        callee_id: r.callee_id.clone(),
                        declaration: r.declaration.clone(),
                        line: r.line,
                        const_args: r.const_args.clone(),
                    })
                    .collect(),
                called_by: vec![],
                call_chain_depth: 0,
            });
        }
        let context = ClassifyContext {
            convention_entries: IndexMap::from([(node.id.clone(), input.extra_evidence.clone())]),
            declared_guards: IndexMap::from([(node.id.clone(), input.guards.clone())]),
            ..ClassifyContext::default()
        };
        return to_raw_value(
            &observe!(
                calls,
                demlik_code_graph::kinds::classify::classify_function,
                node,
                &compiled,
                &context,
                &collation
            )
            .map_err(Failure::error)?,
        )
        .map_err(Failure::error);
    }
    let binary = TsgoBinary::from_native_preview_manifest(manifest).map_err(Failure::error)?;
    let config = root.join("tsconfig.json");
    let imports =
        resolve_imports(root, &loaded.source_files, &config, &collation).map_err(Failure::error)?;
    let ids: Vec<_> = found.iter().map(|f| f.id.clone()).collect();
    let inputs = analysis_inputs(found.iter().map(NamedSymbol::from));
    let (mut edges, references, base, siblings, types, guards, conventions) = with_type_context(
        &binary,
        TypeContextInput {
            project: &loaded,
            ts_config_path: &config,
            functions: &found,
        },
        |context| {
            Ok((|| -> Result<_, Failure> {
                let edges = observe!(
                    calls,
                    demlik_code_graph::extract::edges::resolve_edges,
                    context,
                    imports,
                    &ids,
                    &collation
                )
                .map_err(Failure::error)?;
                let refs = observe!(
                    calls,
                    demlik_code_graph::extract::references::resolve_references,
                    context,
                    &inputs.names,
                    &inputs.exports_by_file,
                    &collation
                )
                .map_err(Failure::error)?;
                let base = public_method_rules_by_base_class(context, &compiled.entry_base_classes)
                    .map_err(Failure::error)?;
                let siblings = observe!(
                    calls,
                    demlik_code_graph::kinds::declarations::sibling_property_rules,
                    context,
                    &compiled.entry_guard_properties,
                    &collation
                )
                .map_err(Failure::error)?;
                let types = observe!(
                    calls,
                    demlik_code_graph::kinds::declarations::type_scope_rules,
                    context,
                    &compiled.entry_guard_properties,
                    &collation
                )
                .map_err(Failure::error)?;
                let guards = observe!(
                    calls,
                    demlik_code_graph::kinds::declarations::merge_rule_maps,
                    [&siblings, &types],
                    &collation
                )
                .map_err(Failure::error)?;
                let conventions = observe!(
                    calls,
                    demlik_code_graph::extract::conventions::convention_entries,
                    &found,
                    &rules,
                    root,
                    root,
                    &collation
                )
                .map_err(Failure::error)?;
                Ok((edges, refs, base, siblings, types, guards, conventions))
            })())
        },
    )
    .map_err(Failure::error)??;
    let context = ClassifyContext {
        base_class_entries: base,
        declared_guards: guards,
        convention_entries: conventions,
        ..ClassifyContext::default()
    };
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
        node.node_kind = Some(
            observe!(
                calls,
                demlik_code_graph::kinds::classify::classify_function,
                node,
                &compiled,
                &context,
                &collation
            )
            .map_err(Failure::error)?,
        );
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Classified<'a> {
        id: &'a str,
        node_kind: &'a Option<demlik_code_graph::schema::NodeKind>,
    }
    #[derive(Serialize)]
    struct Output<'a> {
        functions: Vec<Found<'a>>,
        calls: IndexMap<&'a str, &'a Vec<CallSite>>,
        callers: IndexMap<&'a str, &'a Vec<demlik_code_graph::schema::CallerSite>>,
        depths: IndexMap<&'a str, usize>,
        references: demlik_code_graph::extract::references::ReferenceResult,
        classifications: Vec<Classified<'a>>,
        base: &'a RuleMap,
        siblings: RuleMap,
        types: RuleMap,
        guards: &'a RuleMap,
        conventions: &'a IndexMap<String, Vec<JsString>>,
    }
    to_raw_value(&Output {
        functions: found_rows(&found),
        calls: graph
            .functions
            .iter()
            .map(|f| (f.id.as_str(), &f.edges.as_ref().unwrap().calls))
            .collect(),
        callers: graph
            .functions
            .iter()
            .map(|f| (f.id.as_str(), &f.edges.as_ref().unwrap().called_by))
            .collect(),
        depths: graph
            .functions
            .iter()
            .map(|f| (f.id.as_str(), f.edges.as_ref().unwrap().call_chain_depth))
            .collect(),
        references,
        classifications: graph
            .functions
            .iter()
            .map(|f| Classified {
                id: &f.id,
                node_kind: &f.node_kind,
            })
            .collect(),
        base: &context.base_class_entries,
        siblings,
        types,
        guards: &context.declared_guards,
        conventions: &context.convention_entries,
    })
    .map_err(Failure::error)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("explicit native compiler manifest required")?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = vec![];
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(input) => match execute(&input, Path::new(&manifest), &mut calls) {
                Ok(output) => Response {
                    id: Some(input.id),
                    ok: true,
                    output: Some(output),
                    error: None,
                    observed_calls: calls,
                },
                Err(error) => Response {
                    id: Some(input.id),
                    ok: false,
                    output: None,
                    error: Some(error),
                    observed_calls: calls,
                },
            },
            Err(error) => Response {
                id: None,
                ok: false,
                output: None,
                error: Some(Failure::error(error)),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
