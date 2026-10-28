mod collapse_facts;
use collapse_facts::NodeInput;
use demlik_code_graph::{
    project::Collation,
    schema::{
        Graph, Health, ModuleNode, Provenance, Severity, Smell, SmellKind, SmellTarget, Stats,
        Summary, Thresholds,
    },
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    error::Error,
    io::{self, BufRead},
};
macro_rules! observe { ($calls:expr,$function:path $(,$arg:expr)* $(,)?) => {{let value=$function($($arg),*);$calls.push(stringify!($function));value}}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    root: JsString,
    nodes: Vec<FunctionInput>,
    modules: Vec<ModuleInput>,
    #[serde(default)]
    summary: SummaryInput,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FunctionInput {
    fact: NodeInput,
    #[serde(default)]
    smells: Vec<SmellInput>,
    #[serde(default)]
    chain: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModuleInput {
    file: String,
    loc: usize,
    #[serde(default)]
    smells: Vec<SmellInput>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SmellInput {
    kind: SmellKind,
    severity: Severity,
    value: usize,
    threshold: u64,
}
impl SmellInput {
    fn native(self, target: SmellTarget) -> Smell {
        Smell {
            kind: self.kind,
            severity: self.severity,
            value: self.value,
            threshold: self.threshold,
            target,
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HealthInput {
    Healthy,
    #[default]
    Rough,
    Rotten,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SummaryInput {
    #[serde(default)]
    health: HealthInput,
    #[serde(default)]
    file_count: usize,
    #[serde(default)]
    function_count: usize,
    #[serde(default)]
    smell_count: usize,
    #[serde(default)]
    high_severity_count: usize,
    #[serde(default)]
    worst_file: Option<String>,
    #[serde(default)]
    worst_function: Option<String>,
}
impl Input {
    fn graph(self) -> Graph {
        let functions = self
            .nodes
            .into_iter()
            .map(|n| {
                let mut function = n.fact.into_function();
                function.smells = n
                    .smells
                    .into_iter()
                    .map(|s| {
                        s.native(SmellTarget::Function {
                            id: function.id.clone(),
                            file: function.file.clone(),
                            start_line: function.start_line,
                        })
                    })
                    .collect();
                if let Some(edges) = &mut function.edges {
                    edges.call_chain_depth = n.chain;
                }
                function
            })
            .collect();
        let modules = self
            .modules
            .into_iter()
            .map(|m| ModuleNode {
                smells: m
                    .smells
                    .into_iter()
                    .map(|s| {
                        s.native(SmellTarget::Module {
                            file: m.file.clone(),
                        })
                    })
                    .collect(),
                file: m.file,
                loc: m.loc,
                comment_lines: 0,
                function_ids: vec![],
                imports: vec![],
                imported_by: vec![],
                import_edges: vec![],
                is_test: false,
            })
            .collect();
        Graph {
            root: self.root,
            provenance: Provenance::Cheap,
            thresholds: Thresholds::default(),
            summary: Summary {
                health: match self.summary.health {
                    HealthInput::Healthy => Health::Healthy,
                    HealthInput::Rough => Health::Rough,
                    HealthInput::Rotten => Health::Rotten,
                },
                file_count: self.summary.file_count,
                function_count: self.summary.function_count,
                smell_count: self.summary.smell_count,
                high_severity_count: self.summary.high_severity_count,
                worst_file: self.summary.worst_file,
                worst_function: self.summary.worst_function,
                top_targets: vec![],
                parse_failures: vec![],
            },
            cross_runtime: None,
            reachability: None,
            clusters: None,
            interface_width: None,
            data: None,
            functions,
            declarations: vec![],
            modules,
            directories: vec![],
            smells: vec![],
            stats: Stats {
                file_count: 0,
                function_count: 0,
                total_loc: 0,
                total_comment_lines: 0,
                smell_count: 0,
                parse_failures: vec![],
            },
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'g> {
    model: demlik_code_graph::render::html::HtmlModel<'g>,
    html: JsString,
    summary_owner: bool,
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
fn execute(input: Input, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, Box<dyn Error>> {
    let graph = input.graph();
    let model = {
        let collation = Collation::try_node22_en_us()?;
        observe!(
            calls,
            demlik_code_graph::render::html::build_html_model,
            &graph,
            &collation
        )?
    };
    let summary_owner = std::ptr::eq(model.summary, &graph.summary);
    let html = {
        let collation = Collation::try_node22_en_us()?;
        observe!(
            calls,
            demlik_code_graph::render::html::render_html,
            &graph,
            &collation
        )?
    };
    Ok(RawValue::from_string(serde_json::to_string(&Output {
        model,
        html,
        summary_owner,
    })?)?)
}
fn main() -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = vec![];
        let (id, result) = match serde_json::from_str::<Request>(&line) {
            Ok(request) => (Some(request.id), execute(request.input, &mut calls)),
            Err(error) => (None, Err(Box::new(error) as Box<dyn Error>)),
        };
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls: calls,
            },
            Err(error) => Response {
                id,
                ok: false,
                output: None,
                error: Some(error.to_string()),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
