use demlik_code_graph::{
    data::extract::{DataScan, DataScanInput, Site},
    extract::{
        analysis::{AnalysisError, AnalysisOptions},
        assemble::{AssemblyError, DataOptions, NodeFields},
        wrangler_config::CatalogError,
    },
    kinds::rules::NodeKindRules,
    project::EdgeScope,
    schema::{DataAccess, DataBindingKind, DataReport, Thresholds},
    text::JsString,
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessInput {
    kind: DataBindingKind,
    method: Option<JsString>,
    sql: Option<JsString>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    binding: JsString,
    kind: DataBindingKind,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SitesInput {
    file: String,
    source: String,
    bindings: Vec<(JsString, Decl)>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReportInput {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    #[serde(default)]
    omit_functions: bool,
    #[serde(default)]
    foreign_functions: bool,
    #[serde(default)]
    duplicate_units: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum GraphPass {
    Cheap,
    Edges,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum GraphScope {
    Package,
    Deep,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GraphInput {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    pass: GraphPass,
    scope: Option<GraphScope>,
    data: bool,
    #[serde(default)]
    analysis: bool,
    #[serde(default)]
    headers: bool,
    #[serde(default)]
    thresholds: Thresholds,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportOutput {
    functions: usize,
    parse_failures: Vec<String>,
    scan: DataScan,
    report: DataReport,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessOutput {
    sql_access: DataAccess,
    access: DataAccess,
}
#[derive(Serialize)]
struct SitesOutput<'a> {
    sites: Vec<Site<'a, Decl>>,
    accesses: Vec<DataAccess>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
impl DriverError {
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string(),
        }
    }
    fn parse(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "parse-error",
            message: error.to_string(),
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
            message: error.to_string(),
        }
    }
}
impl From<CatalogError> for DriverError {
    fn from(error: CatalogError) -> Self {
        Self {
            kind: if matches!(error, CatalogError::Record(_)) {
                "type-error"
            } else {
                "backend-error"
            },
            message: error.to_string(),
        }
    }
}
impl From<AssemblyError> for DriverError {
    fn from(error: AssemblyError) -> Self {
        match error {
            AssemblyError::Data(error) | AssemblyError::Analysis(AnalysisError::Catalog(error)) => {
                error.into()
            }
            error => Self::backend(error),
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
fn parse<T: for<'a> Deserialize<'a>>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::transport)
}
fn execute(
    case: Case,
    manifest: Option<&Path>,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, DriverError> {
    let metadata_collation =
        demlik_code_graph::project::Collation::try_node22_en_us().map_err(DriverError::backend)?;

    match case.operation.as_str() {
        "code_graph.data_graph" => {
            let input: GraphInput = parse(&case.input)?;
            if matches!(input.pass, GraphPass::Cheap) && input.analysis {
                return Err(DriverError::transport(
                    "cheap pass cannot request semantic analysis",
                ));
            }
            if matches!(input.pass, GraphPass::Cheap) && input.scope.is_some() {
                return Err(DriverError::transport(
                    "cheap pass cannot request an edge scope",
                ));
            }
            let repo = input.repo_root.as_deref().unwrap_or(&input.root);
            let fields = NodeFields {
                headers: input.headers,
            };
            let data = input.data.then_some(DataOptions { repo_root: repo });
            let graph = match input.pass {
                GraphPass::Cheap => {
                    let loaded = observe!(
                        calls,
                        demlik_code_graph::project::load_cheap_project,
                        &input.root,
                        None
                    )
                    .map_err(DriverError::backend)?;
                    match data {
                        Some(data) => observe!(
                            calls,
                            demlik_code_graph::extract::assemble::assemble_graph_with_data,
                            &loaded,
                            input.thresholds,
                            fields,
                            data,
                            &metadata_collation
                        ),
                        None => observe!(
                            calls,
                            demlik_code_graph::extract::assemble::assemble_graph,
                            &loaded,
                            input.thresholds,
                            fields,
                            &metadata_collation
                        ),
                    }
                }
                GraphPass::Edges => {
                    let binary = observe!(
                        calls,
                        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
                        manifest.ok_or_else(|| DriverError::transport(
                            "data_graph edges requires the native-preview manifest argument"
                        ))?
                    )
                    .map_err(DriverError::backend)?;
                    let scope = match input.scope {
                        Some(GraphScope::Deep) => EdgeScope::Deep,
                        _ => EdgeScope::Package,
                    };
                    let loaded = observe!(
                        calls,
                        demlik_code_graph::project::load_edge_project,
                        &input.root,
                        scope,
                        repo,
                        None
                    )
                    .map_err(DriverError::backend)?;
                    let rules = NodeKindRules::default();
                    let analysis = input.analysis.then_some(AnalysisOptions {
                        cross_runtime: true,
                        kinds: true,
                        reach: true,
                        clusters: true,
                        interface_width: true,
                        kind_rules: &rules,
                        repo_root: repo,
                    });
                    observe!(
                        calls,
                        demlik_code_graph::extract::assemble::assemble_graph_with_reports,
                        &loaded,
                        input.thresholds,
                        &binary,
                        fields,
                        analysis.as_ref(),
                        data,
                        &metadata_collation
                    )
                }
            }?;
            to_raw_value(&graph).map_err(DriverError::transport)
        }
        "code_graph.data_report" => {
            let input: ReportInput = parse(&case.input)?;
            let loaded = observe!(
                calls,
                demlik_code_graph::project::load_cheap_project,
                &input.root,
                None
            )
            .map_err(DriverError::backend)?;
            let foreign = input
                .foreign_functions
                .then(|| {
                    observe!(
                        calls,
                        demlik_code_graph::project::load_cheap_project,
                        &input.root,
                        None
                    )
                })
                .transpose()
                .map_err(DriverError::backend)?;
            let mut functions = observe!(
                calls,
                demlik_code_graph::extract::functions::discover_functions,
                &foreign.as_ref().unwrap_or(&loaded).source_files,
                &metadata_collation
            )
            .map_err(DriverError::backend)?
            .functions;
            if input.omit_functions {
                functions.clear();
            }
            let mut units = loaded.source_files;
            if input.duplicate_units {
                units.extend(units.clone());
            }
            let repo = input.repo_root.as_deref().unwrap_or(&input.root);
            let catalog = observe!(
                calls,
                demlik_code_graph::extract::wrangler_config::load_binding_catalog,
                repo,
                None,
                &metadata_collation
            )?;
            let scan = observe!(
                calls,
                demlik_code_graph::data::extract::scan_data_sites,
                DataScanInput {
                    units: &units,
                    functions: &functions,
                    catalog: &catalog,
                    repo_root: repo
                },
                &metadata_collation
            )
            .map_err(DriverError::backend)?;
            let report = observe!(
                calls,
                demlik_code_graph::data::extract::load_data_report,
                &units,
                &functions,
                repo,
                &metadata_collation
            )?;
            to_raw_value(&ReportOutput {
                functions: functions.len(),
                parse_failures: loaded.parse_failures,
                scan,
                report,
            })
            .map_err(DriverError::transport)
        }
        "code_graph.data_access" => {
            let input: AccessInput = parse(&case.input)?;
            let sql_access = observe!(
                calls,
                demlik_code_graph::data::access::sql_access,
                input.sql.as_ref()
            );
            let access = observe!(
                calls,
                demlik_code_graph::data::access::access_of,
                input.kind,
                input.method.as_ref(),
                input.sql.as_ref()
            );
            to_raw_value(&AccessOutput { sql_access, access }).map_err(DriverError::transport)
        }
        "code_graph.binding_sites" => {
            let input: SitesInput = parse(&case.input)?;
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file),
                &input.source
            )
            .map_err(DriverError::parse)?;
            let bindings: IndexMap<_, _> = input.bindings.into_iter().collect();
            let sites = observe!(
                calls,
                demlik_code_graph::data::extract::binding_sites,
                &syntax,
                &bindings
            );
            let accesses = sites
                .iter()
                .map(|site| {
                    observe!(
                        calls,
                        demlik_code_graph::data::access::access_of,
                        site.decl.kind,
                        site.method.as_ref(),
                        site.sql.as_ref()
                    )
                })
                .collect();
            to_raw_value(&SitesOutput { sites, accesses }).map_err(DriverError::transport)
        }
        _ => Err(DriverError::transport(format!(
            "unsupported operation: {}",
            case.operation
        ))),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args_os().nth(1).map(PathBuf::from);
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(DriverError::transport)
            .and_then(|case| execute(case, manifest.as_deref(), &mut observed_calls));
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
