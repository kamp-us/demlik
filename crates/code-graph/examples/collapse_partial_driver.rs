use demlik_code_graph::{
    collapse::{partial::PartialTwin, settings::CollapseSettings},
    extract::{
        analysis::AnalysisOptions,
        assemble::{AssemblyError, NodeFields},
    },
    kinds::rules::NodeKindRules,
    project::EdgeScope,
    schema::{CallSite, Edges, FunctionKind, FunctionNode, Thresholds},
    text::{JsObject, JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let value=$function($($argument),*);$calls.push(stringify!($function));value}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    Pure,
    Project,
}
#[derive(Deserialize)]
struct Tag {
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PureInput {
    operation: Operation,
    nodes: Vec<NodeInput>,
    #[serde(default = "empty")]
    settings: JsValue,
    #[serde(default)]
    filter_candidates: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProjectInput {
    operation: Operation,
    root: JsString,
    repo_root: JsString,
    native_preview_manifest: PathBuf,
    #[serde(default = "empty")]
    settings: JsValue,
}
fn empty() -> JsValue {
    JsValue::Object(JsObject::new())
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Function,
    Method,
    Constructor,
    Getter,
    Setter,
    Arrow,
    FunctionExpression,
}
impl Kind {
    fn native(self) -> FunctionKind {
        match self {
            Self::Function => FunctionKind::Function,
            Self::Method => FunctionKind::Method,
            Self::Constructor => FunctionKind::Constructor,
            Self::Getter => FunctionKind::Getter,
            Self::Setter => FunctionKind::Setter,
            Self::Arrow => FunctionKind::Arrow,
            Self::FunctionExpression => FunctionKind::FunctionExpression,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NodeInput {
    id: String,
    file: String,
    start_line: usize,
    loc: usize,
    complexity: usize,
    is_test: bool,
    kind: Kind,
    calls: Option<Vec<CallInput>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CallInput {
    callee_id: JsString,
    line: usize,
    const_args: Vec<String>,
}
impl NodeInput {
    fn native(self) -> FunctionNode {
        FunctionNode {
            name: self.id.clone(),
            id: self.id,
            file: self.file,
            start_line: self.start_line,
            end_line: self.start_line,
            loc: self.loc,
            complexity: self.complexity,
            is_test: self.is_test,
            kind: self.kind.native(),
            comment_lines: 0,
            nesting_depth: 0,
            is_exported: false,
            edges: self.calls.map(|calls| Edges {
                calls: calls
                    .into_iter()
                    .map(|call| CallSite {
                        callee_id: call.callee_id,
                        line: call.line,
                        const_args: call.const_args,
                        declaration: None,
                    })
                    .collect(),
                called_by: vec![],
                call_chain_depth: 0,
            }),
            node_kind: None,
            smells: vec![],
            header: None,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    eligible: Vec<bool>,
    twins: Vec<PartialTwin<'a>>,
    borrowed_owners: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    functions: Option<&'a [FunctionNode]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_files: Option<Vec<&'a str>>,
}
#[derive(Serialize)]
struct Failure {
    stage: &'static str,
    name: &'static str,
    message: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thrown: Option<Failure>,
    observed_calls: Vec<&'static str>,
}
fn borrow_identity(twins: &[PartialTwin<'_>], nodes: &[FunctionNode]) -> bool {
    twins.iter().all(|twin| {
        let owners = nodes.iter().any(|node| std::ptr::eq(node, twin.a))
            && nodes.iter().any(|node| std::ptr::eq(node, twin.b));
        let calls = twin.a.edges.as_ref().unwrap().calls.as_slice();
        owners
            && calls
                .iter()
                .any(|call| std::ptr::eq(call, &twin.shared_block[0]))
            && calls.iter().any(|call| std::ptr::eq(call, twin.a_diverges))
            && twin
                .b
                .edges
                .as_ref()
                .unwrap()
                .calls
                .iter()
                .any(|call| std::ptr::eq(call, twin.b_diverges))
            && twin.shared_constants.iter().all(|name| {
                twin.shared_block.iter().any(|call| {
                    call.const_args
                        .iter()
                        .any(|owned| owned.as_ptr() == name.as_ptr())
                })
            })
    })
}
fn report<'a>(
    nodes: &'a [FunctionNode],
    settings: &CollapseSettings,
    filter: bool,
    calls: &mut Vec<&'static str>,
) -> Result<Report<'a>, demlik_code_graph::project::CollationError> {
    let eligible = nodes
        .iter()
        .map(|node| {
            observe!(
                calls,
                demlik_code_graph::collapse::candidates::is_candidate_function,
                node,
                settings
            )
        })
        .collect::<Vec<_>>();
    let candidates = nodes
        .iter()
        .zip(&eligible)
        .filter(|(_, eligible)| !filter || **eligible)
        .map(|(node, _)| node)
        .collect::<Vec<_>>();
    let twins = observe!(
        calls,
        demlik_code_graph::collapse::partial::find_partial_twins,
        &candidates,
        settings,
        &demlik_code_graph::project::Collation::try_node22_en_us()?
    )?;
    Ok(Report {
        borrowed_owners: borrow_identity(&twins, nodes),
        eligible,
        twins,
        functions: None,
        module_files: None,
    })
}
fn assembly_failure(error: AssemblyError) -> Failure {
    Failure {
        stage: "assembly",
        name: error.name(),
        message: error.message(),
    }
}
fn execute(request: Request) -> Result<Response, Box<dyn std::error::Error>> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()?;

    let tag: Tag = serde_json::from_str(request.input.get())?;
    let mut calls = vec![];
    let result = match tag.operation {
        Operation::Pure => {
            let input: PureInput = serde_json::from_str(request.input.get())?;
            assert!(matches!(input.operation, Operation::Pure));
            let settings = CollapseSettings::parse(&input.settings)?;
            let nodes = input
                .nodes
                .into_iter()
                .map(NodeInput::native)
                .collect::<Vec<_>>();
            Ok(serde_json::value::to_raw_value(&report(
                &nodes,
                &settings,
                input.filter_candidates,
                &mut calls,
            )?)?)
        }
        Operation::Project => {
            let input: ProjectInput = serde_json::from_str(request.input.get())?;
            assert!(matches!(input.operation, Operation::Project));
            let settings = CollapseSettings::parse(&input.settings)?;
            let repo_root = PathBuf::from(input.repo_root.to_lossy());
            let binary = observe!(
                &mut calls,
                demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
                &input.native_preview_manifest
            )?;
            match observe!(
                &mut calls,
                demlik_code_graph::project::load_edge_project_text,
                &input.root,
                EdgeScope::Package,
                &repo_root,
                None,
                &metadata_collation
            ) {
                Err(error) => Err(Failure {
                    stage: "load",
                    name: "Error",
                    message: error.message(),
                }),
                Ok(loaded) => {
                    let rules = NodeKindRules::default();
                    let options = AnalysisOptions {
                        cross_runtime: true,
                        kinds: true,
                        reach: false,
                        clusters: false,
                        interface_width: false,
                        kind_rules: &rules,
                        repo_root: &repo_root,
                    };
                    match observe!(
                        &mut calls,
                        demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
                        &loaded,
                        &input.root,
                        Thresholds::default(),
                        &binary,
                        NodeFields::default(),
                        &options,
                        &metadata_collation
                    ) {
                        Err(error) => Err(assembly_failure(error)),
                        Ok(graph) => {
                            let mut output = report(&graph.functions, &settings, true, &mut calls)?;
                            output.functions = Some(&graph.functions);
                            output.module_files =
                                Some(graph.modules.iter().map(|m| m.file.as_str()).collect());
                            Ok(serde_json::value::to_raw_value(&output)?)
                        }
                    }
                }
            }
        }
    };
    let (output, thrown) = match result {
        Ok(output) => (Some(output), None),
        Err(error) => (None, Some(error)),
    };
    Ok(Response {
        id: request.id,
        output,
        thrown,
        observed_calls: calls,
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let response = execute(serde_json::from_str(&input)?)?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
