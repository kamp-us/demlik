use demlik_code_graph::{
    extract::{analysis::AnalysisOptions, assemble::NodeFields},
    kinds::rules::NodeKindRules,
    project::EdgeScope,
    schema::{Graph, Thresholds},
    text::JsString,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    Text,
    Path,
    Cheap,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    mode: Mode,
    root: JsString,
    repo_root: JsString,
    native_preview_manifest: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    graph: Graph,
    loaded_files: usize,
    direct: String,
    pretty: String,
    stable: String,
    stable_pretty: String,
    value_error: Option<String>,
    observed_calls: Vec<&'static str>,
}
macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
fn run(input: Request) -> Result<Output, Box<dyn std::error::Error>> {
    let mut calls = Vec::new();
    let root = PathBuf::from(input.root.to_lossy());
    let repo = PathBuf::from(input.repo_root.to_lossy());
    let (graph, loaded_files) = if matches!(input.mode, Mode::Cheap) {
        let loaded = observe!(
            calls,
            demlik_code_graph::project::load_cheap_project,
            &root,
            None
        )?;
        let count = loaded.source_files.len();
        let graph = observe!(
            calls,
            demlik_code_graph::extract::assemble::assemble_graph,
            &loaded,
            Thresholds::default(),
            NodeFields::default()
        )?;
        (graph, count)
    } else {
        let binary = observe!(
            calls,
            demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
            Path::new(&input.native_preview_manifest)
        )?;
        let loaded = match input.mode {
            Mode::Text => observe!(
                calls,
                demlik_code_graph::project::load_edge_project_text,
                &input.root,
                EdgeScope::Package,
                &repo,
                None
            ),
            Mode::Path => observe!(
                calls,
                demlik_code_graph::project::load_edge_project,
                &root,
                EdgeScope::Package,
                &repo,
                None
            ),
            Mode::Cheap => unreachable!(),
        }?;
        let count = loaded.project.source_files.len();
        let rules = NodeKindRules::default();
        let options = AnalysisOptions {
            cross_runtime: false,
            kinds: false,
            reach: false,
            clusters: false,
            interface_width: false,
            kind_rules: &rules,
            repo_root: &repo,
        };
        let graph = match input.mode {
            Mode::Text => observe!(
                calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
                &loaded,
                &input.root,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                &options
            ),
            Mode::Path => observe!(
                calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_analysis,
                &loaded,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                &options
            ),
            Mode::Cheap => unreachable!(),
        }?;
        (graph, count)
    };
    Ok(Output {
        loaded_files,
        direct: serde_json::to_string(&graph)?,
        pretty: serde_json::to_string_pretty(&graph)?,
        stable: observe!(
            calls,
            demlik_code_graph::render::json::stable_stringify,
            &graph,
            false
        )?,
        stable_pretty: observe!(
            calls,
            demlik_code_graph::render::json::stable_stringify,
            &graph,
            true
        )?,
        value_error: serde_json::to_value(&graph)
            .err()
            .map(|error| error.to_string()),
        graph,
        observed_calls: calls,
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A malformed protocol is an observable process failure, not a graph refusal.
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    serde_json::to_writer(io::stdout().lock(), &run(request)?)?;
    Ok(())
}
