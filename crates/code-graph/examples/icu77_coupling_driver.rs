use demlik_code_graph::{
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::AnalysisOptions,
        assemble::{NodeFields, assemble_graph},
    },
    kinds::rules::NodeKindRules,
    project::{
        Collation, EdgeScope, discover_package_roots, load_cheap_project, load_edge_project,
    },
    schema::{Graph, ImportEdge, ModuleNode, Provenance, Thresholds},
    smells::coupling::{CouplingAnalysis, CouplingFacts, CrossBoundaryGroup, Cycle, ModuleRank},
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{$calls.push(stringify!($function));$function($($arg),*)}};}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Guards,
    Render,
    Cheap,
    Workflow,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModuleInput {
    file: String,
    edges: Vec<ImportEdge>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    root: PathBuf,
    mode: Option<Mode>,
    #[serde(default)]
    modules: Vec<ModuleInput>,
    #[serde(default)]
    package_roots: Vec<String>,
}
fn modules(rows: Vec<ModuleInput>) -> Vec<ModuleNode> {
    rows.into_iter()
        .map(|row| ModuleNode {
            file: row.file,
            loc: 0,
            comment_lines: 0,
            function_ids: vec![],
            imports: vec![],
            imported_by: vec![],
            import_edges: row.edges,
            is_test: false,
            smells: vec![],
        })
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisView<'a> {
    cycles: &'a [Cycle],
    cross_boundary: &'a [CrossBoundaryGroup],
    ranked: &'a [ModuleRank],
    coupling: Vec<(&'a String, &'a CouplingFacts)>,
}
fn analysis_view(analysis: &CouplingAnalysis) -> AnalysisView<'_> {
    AnalysisView {
        cycles: &analysis.cycles,
        cross_boundary: &analysis.cross_boundary,
        ranked: &analysis.ranked,
        coupling: analysis.coupling.iter().collect(),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Renders {
    smells_text: JsString,
    smells_json: JsString,
    smells_pretty: JsString,
    cycles_text: JsString,
    cycles_json: JsString,
    cycles_pretty: JsString,
}
fn renders(
    graph: &Graph,
    c: &Collation,
    calls: &mut Vec<&'static str>,
) -> Result<Renders, Box<dyn std::error::Error>> {
    Ok(Renders {
        smells_text: observe!(
            calls,
            demlik_code_graph::render::smells::render_smells,
            graph,
            false,
            false,
            c
        )?,
        smells_json: observe!(
            calls,
            demlik_code_graph::render::smells::render_smells,
            graph,
            true,
            false,
            c
        )?,
        smells_pretty: observe!(
            calls,
            demlik_code_graph::render::smells::render_smells,
            graph,
            true,
            true,
            c
        )?,
        cycles_text: observe!(
            calls,
            demlik_code_graph::render::analysis::render_cycles,
            graph,
            false,
            false,
            c
        )?,
        cycles_json: observe!(
            calls,
            demlik_code_graph::render::analysis::render_cycles,
            graph,
            true,
            false,
            c
        )?,
        cycles_pretty: observe!(
            calls,
            demlik_code_graph::render::analysis::render_cycles,
            graph,
            true,
            true,
            c
        )?,
    })
}
fn views(
    rows: &[ModuleNode],
    roots: &[String],
    graph: Option<&Graph>,
    render: bool,
    c: &Collation,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let before = to_raw_value(rows)?;
    let analysis = observe!(
        calls,
        demlik_code_graph::smells::coupling::analyze_coupling,
        rows,
        roots,
        c
    )?;
    let value_edges = observe!(
        calls,
        demlik_code_graph::smells::coupling::value_edges,
        rows,
        c
    )?;
    let cycles = observe!(
        calls,
        demlik_code_graph::smells::coupling::find_cycles,
        rows,
        c
    )?;
    let cross_boundary = observe!(
        calls,
        demlik_code_graph::smells::coupling::cross_boundary_edges,
        rows,
        roots,
        c
    )?;
    let ranked = observe!(
        calls,
        demlik_code_graph::smells::coupling::rank_modules,
        rows,
        roots,
        c
    )?;
    let coupling = observe!(
        calls,
        demlik_code_graph::smells::coupling::coupling_by_file,
        rows,
        roots,
        c
    )?;
    assert_eq!(before.get(), to_raw_value(rows)?.get());
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        graph: Option<&'a Graph>,
        value_edges: Vec<demlik_code_graph::smells::coupling::ValueEdge>,
        cycles: Vec<Cycle>,
        cross_boundary: Vec<CrossBoundaryGroup>,
        ranked: Vec<ModuleRank>,
        coupling: Vec<(&'a String, &'a CouplingFacts)>,
        analysis: AnalysisView<'a>,
        #[serde(skip_serializing_if = "Option::is_none")]
        renders: Option<Renders>,
    }
    let output = Output {
        graph: if render { None } else { graph },
        value_edges,
        cycles,
        cross_boundary,
        ranked,
        coupling: coupling.iter().collect(),
        analysis: analysis_view(&analysis),
        renders: if let Some(graph) = graph {
            Some(renders(graph, c, calls)?)
        } else {
            None
        },
    };
    Ok(to_raw_value(&output)?)
}
fn execute(
    input: Request,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Box<dyn std::error::Error>> {
    let c = Collation::try_node22_en_us()?;
    let root = input.root.as_path();
    let Some(mode) = input.mode else {
        return views(
            &modules(input.modules),
            &input.package_roots,
            None,
            false,
            &c,
            calls,
        );
    };
    let loaded = load_cheap_project(root, None, &c)?;
    let t = Thresholds {
        dependency_cycle: 1,
        cross_boundary_imports: 0,
        ..Thresholds::default()
    };
    let mut graph = if matches!(mode, Mode::Workflow) {
        let loaded = load_edge_project(root, EdgeScope::Package, root, None, &c)?;
        let binary = TsgoBinary::from_native_preview_manifest(manifest)?;
        observe!(
            calls,
            demlik_code_graph::extract::assemble::assemble_graph_with_reports,
            &loaded,
            t,
            &binary,
            NodeFields::default(),
            Some(&AnalysisOptions {
                cross_runtime: false,
                kinds: false,
                reach: false,
                clusters: true,
                interface_width: false,
                kind_rules: &NodeKindRules::default(),
                repo_root: root
            }),
            None,
            &c
        )?
    } else {
        assemble_graph(&loaded, t, NodeFields::default(), &c)?
    };
    if matches!(mode, Mode::Guards) {
        graph.root = "invalid\0root".into();
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct GuardOutput {
            smells_json: JsString,
            smells_pretty: JsString,
            cycles_text: JsString,
            cycles_json: JsString,
        }
        return Ok(to_raw_value(&GuardOutput {
            smells_json: observe!(
                calls,
                demlik_code_graph::render::smells::render_smells,
                &graph,
                true,
                false,
                &c
            )?,
            smells_pretty: observe!(
                calls,
                demlik_code_graph::render::smells::render_smells,
                &graph,
                true,
                true,
                &c
            )?,
            cycles_text: observe!(
                calls,
                demlik_code_graph::render::analysis::render_cycles,
                &graph,
                false,
                false,
                &c
            )?,
            cycles_json: observe!(
                calls,
                demlik_code_graph::render::analysis::render_cycles,
                &graph,
                true,
                false,
                &c
            )?,
        })?);
    }
    if matches!(mode, Mode::Render) {
        graph.modules = modules(input.modules);
        graph.provenance = Provenance::Edges {
            ts_config: root.join("tsconfig.json").to_string_lossy().into_owned(),
            scope: EdgeScope::Package,
        };
        return views(
            &graph.modules,
            &input.package_roots,
            Some(&graph),
            true,
            &c,
            calls,
        );
    }
    let roots = if matches!(mode, Mode::Workflow) {
        discover_package_roots(root, None)
    } else {
        input.package_roots
    };
    views(&graph.modules, &roots, Some(&graph), false, &c, calls)
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
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("explicit native-preview manifest required")?;
    for line in io::stdin().lock().lines() {
        let mut calls = vec![];
        let response = match serde_json::from_str::<Request>(&line?) {
            Ok(mut input) => {
                let id = std::mem::take(&mut input.id);
                match execute(input, Path::new(&manifest), &mut calls) {
                    Ok(output) => Response {
                        id: Some(id),
                        ok: true,
                        output: Some(output),
                        error: None,
                        observed_calls: calls,
                    },
                    Err(e) => Response {
                        id: Some(id),
                        ok: false,
                        output: None,
                        error: Some(e.to_string()),
                        observed_calls: calls,
                    },
                }
            }
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
