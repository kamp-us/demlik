use demlik_code_graph::{
    checker::context::TypeContextInput,
    extract::assemble::NodeFields,
    kinds::{
        classify::{ClassifyContext, KindCensus},
        declarations::RuleMap,
        rules::{NodeKindRules, RuleInputError},
    },
    project::EdgeScope,
    schema::{NodeKind, Thresholds},
    text::{JsObject, JsString, JsValue},
    validation::InputIssue,
};
use indexmap::IndexMap;
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
    input: Box<RawValue>,
}
fn empty() -> JsValue {
    JsValue::Object(JsObject::new())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KindsInput {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    #[serde(default = "empty")]
    rules: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RulesInput {
    rules: JsValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobInput {
    glob: JsString,
    values: Vec<JsString>,
}
#[derive(Serialize)]
struct RulesOutput {
    rules: NodeKindRules,
    #[serde(rename = "regexSources")]
    regex_sources: Vec<JsString>,
    stringified: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Classified {
    id: String,
    node_kind: Option<NodeKind>,
}
#[derive(Serialize)]
struct Callee {
    id: String,
    callee: JsString,
    simple: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KindsOutput {
    rules: NodeKindRules,
    function_count: usize,
    classifications: Vec<Classified>,
    census: KindCensus,
    export_names: IndexMap<String, Vec<JsString>>,
    convention_entries: RuleMap,
    base_class_entries: RuleMap,
    sibling_guards: RuleMap,
    type_guards: RuleMap,
    merged_guards: RuleMap,
    simple_callees: Vec<Callee>,
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
impl From<demlik_code_graph::kinds::glob::GlobError> for DriverError {
    fn from(error: demlik_code_graph::kinds::glob::GlobError) -> Self {
        match error {
            demlik_code_graph::kinds::glob::GlobError::Syntax(message) => {
                Self::new("glob-error", message)
            }
            demlik_code_graph::kinds::glob::GlobError::Pattern(error) => {
                Self::new("regex-error", error.to_string())
            }
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
fn raw<T: Serialize>(value: &T) -> Result<Box<RawValue>, DriverError> {
    to_raw_value(value).map_err(|error| DriverError::new("driver-error", error.to_string()))
}
fn parse<T: for<'a> Deserialize<'a>>(value: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(value.get())
        .map_err(|error| DriverError::new("driver-error", error.to_string()))
}
fn execute(
    case: Case,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, DriverError> {
    match case.operation.as_str() {
        "code_graph.kind_rules" => {
            let input: RulesInput = parse(&case.input)?;
            let rules = observe!(
                calls,
                demlik_code_graph::kinds::rules::NodeKindRules::parse,
                &input.rules
            )?;
            let regex_sources = observe!(
                calls,
                demlik_code_graph::kinds::rules::NodeKindRules::regex_sources,
                &rules
            );
            let stringified = serde_json::to_string(&rules)
                .map_err(|error| DriverError::new("driver-error", error.to_string()))?;
            raw(&RulesOutput {
                rules,
                regex_sources,
                stringified,
            })
        }
        "code_graph.glob" => {
            let input: GlobInput = parse(&case.input)?;
            let pattern = observe!(
                calls,
                demlik_code_graph::kinds::glob::glob_to_regexp,
                &input.glob
            )?;
            raw(&input
                .values
                .iter()
                .map(|value| pattern.test(value))
                .collect::<Vec<_>>())
        }
        "code_graph.kinds" => {
            let input: KindsInput = parse(&case.input)?;
            let rules = observe!(
                calls,
                demlik_code_graph::kinds::rules::NodeKindRules::parse,
                &input.rules
            )?;
            let compiled = observe!(
                calls,
                demlik_code_graph::kinds::classify::compile_kind_rules,
                &rules
            )
            .map_err(|error| DriverError::new("regex-error", error.to_string()))?;
            let binary = observe!(
                calls,
                demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
                manifest
            )
            .map_err(|error| DriverError::new("backend-error", error.to_string()))?;
            let loaded = observe!(
                calls,
                demlik_code_graph::project::load_edge_project,
                &input.root,
                EdgeScope::Package,
                input.repo_root.as_deref().unwrap_or(&input.root),
                None
            )
            .map_err(|error| DriverError::new("backend-error", error.to_string()))?;
            let discovered = observe!(
                calls,
                demlik_code_graph::extract::functions::discover_functions,
                &loaded.project.source_files
            )
            .functions;
            let export_names = observe!(
                calls,
                demlik_code_graph::extract::conventions::export_names_by_id,
                &discovered
            );
            let convention_entries = observe!(
                calls,
                demlik_code_graph::extract::conventions::convention_entries,
                &discovered,
                &rules,
                &loaded.project.root_absolute,
                input.repo_root.as_deref().unwrap_or(&input.root)
            )?;
            let (base_class_entries, sibling_guards, type_guards) = observe!(
                calls,
                demlik_code_graph::checker::context::with_type_context,
                &binary,
                TypeContextInput {
                    project: &loaded.project,
                    ts_config_path: &loaded.ts_config_path,
                    functions: &discovered
                },
                |context| {
                    let base = observe!(
                        calls,
                        demlik_code_graph::kinds::declarations::public_method_rules_by_base_class,
                        context,
                        &compiled.entry_base_classes
                    )?;
                    let sibling = observe!(
                        calls,
                        demlik_code_graph::kinds::declarations::sibling_property_rules,
                        context,
                        &compiled.entry_guard_properties
                    )?;
                    let scopes = observe!(
                        calls,
                        demlik_code_graph::kinds::declarations::type_scope_rules,
                        context,
                        &compiled.entry_guard_properties
                    )?;
                    Ok((base, sibling, scopes))
                }
            )
            .map_err(|error| DriverError::new("backend-error", error.to_string()))?;
            let merged_guards = observe!(
                calls,
                demlik_code_graph::kinds::declarations::merge_rule_maps,
                [&sibling_guards, &type_guards]
            );
            let context = ClassifyContext {
                base_class_entries: base_class_entries.clone(),
                declared_guards: merged_guards.clone(),
                convention_entries: convention_entries.clone(),
                ..ClassifyContext::default()
            };
            let mut graph = observe!(
                calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_edges,
                &loaded,
                Thresholds::default(),
                &binary,
                NodeFields::default()
            )
            .map_err(|error| DriverError::new("backend-error", error.to_string()))?;
            let mut simple_callees = Vec::new();
            for node in &mut graph.functions {
                node.node_kind = Some(observe!(
                    calls,
                    demlik_code_graph::kinds::classify::classify_function,
                    node,
                    &compiled,
                    &context
                ));
                for call in node.edges.iter().flat_map(|edges| &edges.calls) {
                    simple_callees.push(Callee {
                        id: node.id.clone(),
                        callee: call.callee_id.clone(),
                        simple: observe!(
                            calls,
                            demlik_code_graph::kinds::classify::callee_simple_name,
                            &call.callee_id
                        ),
                    });
                }
            }
            let census = observe!(
                calls,
                demlik_code_graph::kinds::classify::kind_census,
                &graph.functions
            );
            raw(&KindsOutput {
                rules,
                function_count: graph.functions.len(),
                census,
                classifications: graph
                    .functions
                    .into_iter()
                    .map(|node| Classified {
                        id: node.id,
                        node_kind: node.node_kind,
                    })
                    .collect(),
                export_names,
                convention_entries,
                base_class_entries,
                sibling_guards,
                type_guards,
                merged_guards,
                simple_callees,
            })
        }
        other => Err(DriverError::new(
            "driver-error",
            format!("unsupported operation: {other}"),
        )),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: kinds_driver <native-preview-package.json>")?,
    );
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(|error| DriverError::new("driver-error", error.to_string()))
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
