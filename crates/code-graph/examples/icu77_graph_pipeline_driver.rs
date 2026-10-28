use demlik_code_graph::{
    data::extract::DataScanInput,
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::{AnalysisOptions, NamedSymbol},
        assemble::{AssemblyError, DataOptions, NodeFields},
        wrangler_config::CatalogError,
    },
    kinds::rules::NodeKindRules,
    project::{Collation, EdgeScope},
    schema::Thresholds,
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{$calls.push(stringify!($function));$function($($arg),*)}};}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Graph,
    Directories,
    Inputs,
    Data,
    Workflow,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Analysis {
    #[serde(default)]
    cross_runtime: bool,
    #[serde(default)]
    kinds: bool,
    #[serde(default)]
    reach: bool,
    #[serde(default)]
    clusters: bool,
    #[serde(default)]
    interface_width: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    mode: Mode,
    root: PathBuf,
    module_order: Option<Vec<String>>,
    symbol_order: Option<Vec<String>>,
    #[serde(default)]
    reverse_symbols: bool,
    #[serde(default)]
    repeat_first: bool,
    #[serde(default)]
    duplicate_units: bool,
    #[serde(default)]
    analysis: Analysis,
    #[serde(default)]
    data: bool,
}
#[derive(Serialize)]
struct Failure {
    name: &'static str,
    message: JsString,
}
impl Failure {
    fn error(e: impl std::fmt::Display) -> Self {
        Self {
            name: "Error",
            message: e.to_string().into(),
        }
    }
    fn assembly(e: AssemblyError) -> Self {
        Self {
            name: e.name(),
            message: e.message(),
        }
    }
    fn catalog(e: CatalogError) -> Self {
        Self {
            name: e.name(),
            message: e.message(),
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
fn execute(
    input: &Request,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Failure> {
    let collation = Collation::try_node22_en_us().map_err(Failure::error)?;
    let root = input.root.as_path();
    let loaded = demlik_code_graph::project::load_cheap_project(root, None, &collation)
        .map_err(Failure::error)?;
    let thresholds = Thresholds::default();
    if matches!(input.mode, Mode::Workflow) {
        let edge = demlik_code_graph::project::load_edge_project(
            root,
            EdgeScope::Package,
            root,
            None,
            &collation,
        )
        .map_err(Failure::error)?;
        let binary = TsgoBinary::from_native_preview_manifest(manifest).map_err(Failure::error)?;
        let a = &input.analysis;
        let options = AnalysisOptions {
            cross_runtime: a.cross_runtime,
            kinds: a.kinds,
            reach: a.reach,
            clusters: a.clusters,
            interface_width: a.interface_width,
            kind_rules: &NodeKindRules::default(),
            repo_root: root,
        };
        let graph = observe!(
            calls,
            demlik_code_graph::extract::assemble::assemble_graph_with_reports,
            &edge,
            thresholds,
            &binary,
            NodeFields::default(),
            Some(&options),
            input.data.then_some(DataOptions { repo_root: root }),
            &collation
        )
        .map_err(Failure::assembly)?;
        return to_raw_value(&graph).map_err(Failure::error);
    }
    if matches!(input.mode, Mode::Inputs | Mode::Data) {
        let found = demlik_code_graph::extract::functions::discover_functions(
            &loaded.source_files,
            &collation,
        )
        .map_err(Failure::error)?
        .functions;
        if matches!(input.mode, Mode::Inputs) {
            let mut selected = found.iter().collect::<Vec<_>>();
            if let Some(order) = &input.symbol_order {
                selected = order
                    .iter()
                    .map(|id| {
                        found
                            .iter()
                            .find(|node| node.id == *id)
                            .expect("frozen symbol input must exist")
                    })
                    .collect();
            }
            if input.reverse_symbols {
                selected.reverse();
            }
            if input.repeat_first {
                selected.push(selected[0]);
            }
            let before = selected
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>();
            let result = observe!(
                calls,
                demlik_code_graph::extract::analysis::analysis_inputs,
                selected.iter().map(|node| NamedSymbol::from(*node)),
                &collation
            )
            .map_err(Failure::error)?;
            assert_eq!(
                before,
                selected
                    .iter()
                    .map(|node| node.id.as_str())
                    .collect::<Vec<_>>()
            );
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Output<'a> {
                names: Vec<&'a String>,
                exports_by_file: Vec<(&'a String, &'a Vec<String>)>,
            }
            return to_raw_value(&Output {
                names: result.names.iter().collect(),
                exports_by_file: result.exports_by_file.iter().collect(),
            })
            .map_err(Failure::error);
        }
        let catalog = observe!(
            calls,
            demlik_code_graph::extract::wrangler_config::load_binding_catalog,
            root,
            None,
            &collation
        )
        .map_err(Failure::catalog)?;
        let mut units = loaded.source_files;
        if input.duplicate_units {
            units.extend(units.clone());
        }
        let scan = observe!(
            calls,
            demlik_code_graph::data::extract::scan_data_sites,
            DataScanInput {
                units: &units,
                functions: &found,
                catalog: &catalog,
                repo_root: root
            },
            &collation
        )
        .map_err(Failure::error)?;
        let report = observe!(
            calls,
            demlik_code_graph::data::extract::load_data_report,
            &units,
            &found,
            root,
            &collation
        )
        .map_err(Failure::catalog)?;
        #[derive(Serialize)]
        struct Output {
            scan: demlik_code_graph::data::extract::DataScan,
            report: demlik_code_graph::schema::DataReport,
        }
        return to_raw_value(&Output { scan, report }).map_err(Failure::error);
    }
    let mut graph = observe!(
        calls,
        demlik_code_graph::extract::assemble::assemble_graph,
        &loaded,
        thresholds,
        NodeFields::default(),
        &collation
    )
    .map_err(Failure::assembly)?;
    if matches!(input.mode, Mode::Directories) {
        if let Some(order) = &input.module_order {
            graph.modules.sort_by_key(|node| {
                order
                    .iter()
                    .position(|file| file == &node.file)
                    .expect("frozen module input must exist")
            });
        }
        let before = to_raw_value(&graph.modules).map_err(Failure::error)?;
        let dirs = observe!(
            calls,
            demlik_code_graph::extract::directories::build_directories,
            &graph.modules,
            &graph.thresholds,
            &collation
        )
        .map_err(Failure::error)?;
        assert_eq!(
            before.get(),
            to_raw_value(&graph.modules).map_err(Failure::error)?.get()
        );
        return to_raw_value(&dirs).map_err(Failure::error);
    }
    to_raw_value(&graph).map_err(Failure::error)
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
