mod collapse_facts;
use collapse_facts::NodeInput;
use demlik_code_graph::{
    collapse::{candidates::find_collapse_candidates, settings::CollapseSettings},
    project::EdgeScope,
    schema::{Graph, Health, Provenance, Stats, Summary, Thresholds},
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    error::Error,
    io::{self, BufRead},
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.push(stringify!($function));value}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
struct Tag {
    operation: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenderInput {
    operation: String,
    root: JsString,
    nodes: Vec<NodeInput>,
    settings: JsValue,
    edges: bool,
    json: bool,
    pretty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShortInput {
    operation: String,
    value: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rendered {
    text: JsString,
    partial_lines: Vec<JsString>,
    b_block_lines: Vec<usize>,
    observed_calls: Vec<&'static str>,
}
fn graph(input: &RenderInput, nodes: Vec<demlik_code_graph::schema::FunctionNode>) -> Graph {
    let count = nodes.len();
    let loc = nodes.iter().map(|n| n.loc).sum();
    Graph {
        root: input.root.clone(),
        provenance: if input.edges {
            Provenance::Edges {
                ts_config: "tsconfig.json".into(),
                scope: EdgeScope::Package,
            }
        } else {
            Provenance::Cheap
        },
        thresholds: Thresholds::default(),
        summary: Summary {
            health: Health::Healthy,
            file_count: 0,
            function_count: count,
            smell_count: 0,
            high_severity_count: 0,
            worst_file: None,
            worst_function: None,
            top_targets: vec![],
            parse_failures: vec![],
        },
        cross_runtime: None,
        reachability: None,
        clusters: None,
        interface_width: None,
        data: None,
        functions: nodes,
        declarations: vec![],
        modules: vec![],
        directories: vec![],
        smells: vec![],
        stats: Stats {
            file_count: 0,
            function_count: count,
            total_loc: loc,
            total_comment_lines: 0,
            smell_count: 0,
            parse_failures: vec![],
        },
    }
}
fn execute(request: Request) -> Result<String, Box<dyn Error>> {
    let tag: Tag = serde_json::from_str(request.input.get())?;
    let mut calls = Vec::new();
    let output = match tag.operation.as_str() {
        "render" => {
            let mut input: RenderInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.operation, "render");
            let settings = CollapseSettings::parse(&input.settings)?;
            let nodes = std::mem::take(&mut input.nodes)
                .into_iter()
                .map(NodeInput::into_function)
                .collect();
            let graph = graph(&input, nodes);
            let text = observe!(
                &mut calls,
                demlik_code_graph::collapse::render::render_collapse,
                &graph,
                &input.root,
                &settings,
                input.json,
                input.pretty
            )?;
            let report = find_collapse_candidates(&graph.functions, &[], &settings);
            let partial_lines = observe!(
                &mut calls,
                demlik_code_graph::collapse::render::partial_twin_lines,
                &report
            );
            let b_block_lines = report
                .partial_twins
                .iter()
                .map(|p| p.b_block_line())
                .collect();
            serde_json::to_string(&Rendered {
                text,
                partial_lines,
                b_block_lines,
                observed_calls: calls,
            })?
        }
        "short" => {
            let input: ShortInput = serde_json::from_str(request.input.get())?;
            assert_eq!(input.operation, "short");
            let value = observe!(
                &mut calls,
                demlik_code_graph::collapse::render::short_callee_name,
                &input.value
            );
            format!(
                "{{\"value\":{},\"observedCalls\":{}}}",
                serde_json::to_string(&value)?,
                serde_json::to_string(&calls)?
            )
        }
        _ => return Err("unknown operation".into()),
    };
    Ok(format!(
        "{{\"id\":{},\"output\":{output}}}",
        serde_json::to_string(&request.id)?
    ))
}
fn main() -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request: Request = serde_json::from_str(&line)?;
        println!("{}", execute(request)?);
    }
    Ok(())
}
