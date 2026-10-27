mod collapse_facts;
use collapse_facts::NodeInput;
use demlik_code_graph::{
    collapse::{candidates::CollapseReport, settings::CollapseSettings},
    engine::tsgo::TsgoBinary,
    extract::{analysis::AnalysisOptions, assemble::NodeFields},
    kinds::rules::NodeKindRules,
    project::EdgeScope,
    schema::{FunctionNode, Thresholds},
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    error::Error,
    io::{self, BufRead},
    path::Path,
    sync::Arc,
};
macro_rules! observe{($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let value=$function($($argument),*);$calls.push(stringify!($function));value}};}
enum Input {
    Pure {
        nodes: Vec<NodeInput>,
        package_roots: Vec<String>,
        settings: JsValue,
    },
    Project {
        root: JsString,
        repo_root: JsString,
        native_preview_manifest: String,
        settings: JsValue,
    },
}
impl<'de> Deserialize<'de> for Input {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Tag {
            operation: String,
        }
        let tag: Tag = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        match tag.operation.as_str() {
            "pure" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Fields {
                    operation: String,
                    nodes: Vec<NodeInput>,
                    package_roots: Vec<String>,
                    settings: JsValue,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                debug_assert_eq!(f.operation, "pure");
                Ok(Self::Pure {
                    nodes: f.nodes,
                    package_roots: f.package_roots,
                    settings: f.settings,
                })
            }
            "project" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Fields {
                    operation: String,
                    root: JsString,
                    repo_root: JsString,
                    native_preview_manifest: String,
                    settings: JsValue,
                }
                let f: Fields =
                    serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                debug_assert_eq!(f.operation, "project");
                Ok(Self::Project {
                    root: f.root,
                    repo_root: f.repo_root,
                    native_preview_manifest: f.native_preview_manifest,
                    settings: f.settings,
                })
            }
            _ => Err(serde::de::Error::custom("unknown operation")),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Input,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Owners {
    settings: bool,
    nodes: bool,
    representatives: bool,
    partials: bool,
}
fn owners(
    report: &CollapseReport<'_, '_>,
    functions: &[FunctionNode],
    settings: &CollapseSettings,
) -> Owners {
    Owners {
        settings: std::ptr::eq(report.settings, settings),
        nodes: report.candidates.iter().all(|c| {
            functions.iter().any(|n| std::ptr::eq(c.a, n))
                && functions.iter().any(|n| std::ptr::eq(c.b, n))
        }),
        representatives: report.clusters.iter().all(|cluster| {
            report
                .candidates
                .iter()
                .any(|c| Arc::ptr_eq(c, &cluster.representative))
        }),
        partials: report.partial_twins.iter().all(|p| {
            functions.iter().any(|n| std::ptr::eq(p.a, n))
                && functions.iter().any(|n| std::ptr::eq(p.b, n))
        }),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumericFacts {
    confidence: String,
    cost: String,
    rank: String,
    strengths: Vec<String>,
}
fn numeric_facts(report: &CollapseReport<'_, '_>) -> Vec<NumericFacts> {
    report
        .candidates
        .iter()
        .map(|c| NumericFacts {
            confidence: format!("{:016x}", c.confidence.to_bits()),
            cost: format!("{:016x}", c.cost.to_bits()),
            rank: format!("{:016x}", c.rank.to_bits()),
            strengths: c
                .signals
                .iter()
                .map(|s| format!("{:016x}", s.strength.to_bits()))
                .collect(),
        })
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'g, 's> {
    report: CollapseReport<'g, 's>,
    compact: String,
    pretty: String,
    owners: Owners,
    numeric: Vec<NumericFacts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    facts: Option<&'g [FunctionNode]>,
    observed_calls: Vec<&'static str>,
}
fn encode(
    id: &str,
    functions: &[FunctionNode],
    roots: &[String],
    settings: &CollapseSettings,
    project: bool,
    mut calls: Vec<&'static str>,
) -> Result<String, Box<dyn Error>> {
    let collation = demlik_code_graph::project::Collation::try_node22_en_us()?;
    let report = observe!(
        &mut calls,
        demlik_code_graph::collapse::candidates::find_collapse_candidates,
        functions,
        roots,
        settings,
        &collation
    )?;
    let compact = observe!(
        &mut calls,
        demlik_code_graph::render::json::stable_stringify,
        &report,
        false
    )?;
    let pretty = observe!(
        &mut calls,
        demlik_code_graph::render::json::stable_stringify,
        &report,
        true
    )?;
    let owner = owners(&report, functions, settings);
    let numeric = numeric_facts(&report);
    let output = Output {
        report,
        compact,
        pretty,
        owners: owner,
        numeric,
        facts: project.then_some(functions),
        observed_calls: calls,
    };
    Ok(format!(
        "{{\"id\":{},\"ok\":true,\"output\":{}}}",
        serde_json::to_string(id)?,
        serde_json::to_string(&output)?
    ))
}
fn execute(request: Request) -> Result<String, Box<dyn Error>> {
    let mut calls = Vec::new();
    match request.input {
        Input::Pure {
            nodes,
            package_roots,
            settings,
        } => {
            let settings = CollapseSettings::parse(&settings)?;
            let nodes = nodes
                .into_iter()
                .map(NodeInput::into_function)
                .collect::<Vec<_>>();
            encode(&request.id, &nodes, &package_roots, &settings, false, calls)
        }
        Input::Project {
            root,
            repo_root,
            native_preview_manifest,
            settings,
        } => {
            let settings = CollapseSettings::parse(&settings)?;
            let native_repo = repo_root.to_lossy();
            let repo = Path::new(&native_repo);
            let binary =
                TsgoBinary::from_native_preview_manifest(Path::new(&native_preview_manifest))?;
            let loaded = observe!(
                &mut calls,
                demlik_code_graph::project::load_edge_project_text,
                &root,
                EdgeScope::Package,
                repo,
                None
            )?;
            let rules = NodeKindRules::default();
            let graph = observe!(
                &mut calls,
                demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text,
                &loaded,
                &root,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                &AnalysisOptions {
                    cross_runtime: true,
                    kinds: true,
                    reach: false,
                    clusters: false,
                    interface_width: false,
                    kind_rules: &rules,
                    repo_root: repo
                }
            )?;
            let native_root = root.to_lossy();
            let roots = observe!(
                &mut calls,
                demlik_code_graph::project::discover_package_roots,
                Path::new(&native_root),
                None
            );
            encode(
                &request.id,
                &graph.functions,
                &roots,
                &settings,
                true,
                calls,
            )
        }
    }
}
fn main() -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request: Request = serde_json::from_str(&line)?;
        println!("{}", execute(request)?);
    }
    Ok(())
}
