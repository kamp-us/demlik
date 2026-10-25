use demlik_code_graph::{
    boundaries::{deployables::cycles::WorkerGraph, violation::BoundaryViolation},
    project::RepoListing,
    syntax::imports::ImportEdge,
    text::JsString,
};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    path::Path,
};

macro_rules! observe {
    ($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let result=$function($($argument),*);$calls.push(stringify!($function));result}};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspacesInput {
    roots: IndexSet<JsString>,
    targets: Vec<JsString>,
    scope: JsString,
    from: JsString,
    edges: Vec<ImportEdge>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogInput {
    repo_root: String,
    listing: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JudgmentFileInput {
    scope: JsString,
    file: JsString,
    from: JsString,
    source: String,
    driven: bool,
    is_main: Option<bool>,
    owners: Vec<(JsString, Vec<JsString>)>,
    owner_files: IndexSet<JsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JudgmentInput {
    repo_root: String,
    rules: Box<RawValue>,
    listing: Option<Vec<String>>,
    catalog_files: Option<Vec<String>>,
    files: Vec<JudgmentFileInput>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Checked<T> {
    Value(T),
    Thrown { thrown: Thrown },
}
#[derive(Serialize)]
struct Thrown {
    name: &'static str,
    message: JsString,
}
fn checked<T>(
    result: Result<T, demlik_code_graph::boundaries::deployables::DeployableJudgmentError>,
) -> Checked<T> {
    match result {
        Ok(value) => Checked::Value(value),
        Err(error) => Checked::Thrown {
            thrown: Thrown {
                name: "TypeError",
                message: error.message().into(),
            },
        },
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOutput<'a> {
    worker: Option<&'a demlik_code_graph::extract::wrangler_config::ServiceManifest>,
    is_main: bool,
    sites: Vec<demlik_code_graph::boundaries::deployables::BindingSite>,
    direct: Checked<Vec<BoundaryViolation>>,
    judged: Checked<Vec<BoundaryViolation>>,
    owner_issue: Option<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JudgmentOutput<'a> {
    kind: &'static str,
    kinds: &'a IndexSet<demlik_code_graph::boundaries::rules::DeployableKind>,
    catalog: &'a demlik_code_graph::extract::wrangler_config::BindingCatalog,
    graph: &'a WorkerGraph,
    workspaces: &'a IndexSet<JsString>,
    judged: Vec<(
        &'a demlik_code_graph::extract::wrangler_config::ServiceManifest,
        Vec<(
            &'a JsString,
            &'a demlik_code_graph::boundaries::deployables::JudgedBinding,
        )>,
    )>,
    files: Vec<FileOutput<'a>>,
    census: Option<demlik_code_graph::boundaries::deployables::census::DeployableCensus>,
    lines: Option<Vec<JsString>>,
}
#[derive(Serialize)]
struct WorkspaceOutput<'a> {
    at: Vec<Option<&'a JsString>>,
    crossing: Vec<BoundaryViolation>,
}
#[derive(Serialize)]
struct GraphOutput<'a> {
    graph: &'a WorkerGraph,
    cycles: Vec<BoundaryViolation>,
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    match request.operation.as_str() {
        "code_graph.deployable-judgment" => {
            use demlik_code_graph::boundaries::deployables::{self as domain, census};
            let input: JudgmentInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let value = demlik_code_graph::text::JsValue::parse(input.rules.get())
                .map_err(|error| error.to_string())?;
            let rules = observe!(
                calls,
                demlik_code_graph::boundaries::rules::BoundaryRules::parse,
                &value
            )
            .map_err(|error| error.to_string())?;
            let root = Path::new(&input.repo_root);
            let listing = input.listing.map(|files| RepoListing {
                root: root.to_path_buf(),
                files,
            });
            let catalog_listing = input.catalog_files.map(|files| RepoListing {
                root: root.to_path_buf(),
                files,
            });
            let catalog = observe!(
                calls,
                demlik_code_graph::extract::wrangler_config::load_binding_catalog,
                root,
                catalog_listing.as_ref()
            )
            .map_err(|error| error.to_string())?;
            let deployables = match observe!(
                calls,
                demlik_code_graph::boundaries::deployables::read_deployables,
                &rules,
                root,
                listing.as_ref(),
                &catalog
            ) {
                domain::DeployablesRead::Read(deployables) => deployables,
                domain::DeployablesRead::Refused { message } => {
                    #[derive(Serialize)]
                    struct Refused {
                        kind: &'static str,
                        message: JsString,
                    }
                    return json(&Refused {
                        kind: "refused",
                        message,
                    });
                }
            };
            let mut files = Vec::new();
            let mut rows = Vec::new();
            for file in &input.files {
                let syntax = demlik_code_graph::engine::oxc::parse_type_script(
                    Path::new(&file.from.to_lossy()),
                    &file.source,
                )
                .map_err(|error| error.to_string())?;
                let sites = observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::bindings::binding_sites_of,
                    &deployables,
                    &file.from,
                    &syntax
                );
                let edges: Vec<_> = demlik_code_graph::syntax::imports::import_literals(&syntax)
                    .into_iter()
                    .map(|edge| ImportEdge {
                        specifier: edge.specifier,
                        kind: edge.kind,
                        type_only: edge.type_only,
                        target: None,
                    })
                    .collect();
                let actual_main = observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::is_worker_main,
                    &deployables,
                    &file.from
                );
                let owners: indexmap::IndexMap<_, _> = file.owners.iter().cloned().collect();
                let facts = domain::DeployableFile {
                    scope: &file.scope,
                    file: &file.file,
                    from: &file.from,
                    import_edges: &edges,
                    binding_sites: &sites,
                    driven: file.driven,
                    is_main: file.is_main.unwrap_or(actual_main),
                    owners: &owners,
                };
                let direct = checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::bindings::binding_violations,
                    &facts
                ));
                let judged = checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::judge::judge_deployables,
                    &deployables,
                    &facts
                ));
                let owner_issue = observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::bindings::binding_owner_issue,
                    &file.scope,
                    &owners,
                    &file.owner_files,
                    &deployables
                );
                rows.extend(sites.iter().map(|site| census::SiteRow {
                    file: file.from.clone(),
                    line: site.line,
                    binding: site.binding.clone(),
                }));
                let worker = observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::worker_of,
                    &deployables,
                    &file.from
                );
                files.push(FileOutput {
                    worker,
                    is_main: actual_main,
                    sites,
                    direct,
                    judged,
                    owner_issue,
                });
            }
            let census = observe!(
                calls,
                demlik_code_graph::boundaries::deployables::census::deployable_census,
                &deployables,
                &rows
            );
            let lines = census.as_ref().map(|census| {
                observe!(
                    calls,
                    demlik_code_graph::boundaries::deployables::census::deployable_census_lines,
                    census
                )
            });
            json(&JudgmentOutput {
                kind: "read",
                kinds: &deployables.kinds,
                catalog: deployables.catalog,
                graph: &deployables.graph,
                workspaces: &deployables.workspaces,
                judged: deployables
                    .judged()
                    .map(|(manifest, bindings)| (manifest, bindings.iter().collect()))
                    .collect(),
                files,
                census,
                lines,
            })
        }
        "code_graph.workspaces" => {
            let input: WorkspacesInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let at = input
                .targets
                .iter()
                .map(|target| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::deployables::workspaces::workspace_at,
                        &input.roots,
                        target
                    )
                })
                .collect();
            let crossing = observe!(
                calls,
                demlik_code_graph::boundaries::deployables::workspaces::cross_workspace_imports,
                &input.roots,
                &input.scope,
                &input.from,
                &input.edges
            );
            json(&WorkspaceOutput { at, crossing })
        }
        "code_graph.worker-cycles" => {
            let graph: WorkerGraph =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            json(&observe!(
                calls,
                demlik_code_graph::boundaries::deployables::cycles::worker_cycles,
                &graph
            ))
        }
        "code_graph.worker-graph" => {
            let input: CatalogInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let root = Path::new(&input.repo_root);
            let listing = input.listing.map(|files| RepoListing {
                root: root.to_path_buf(),
                files,
            });
            let catalog = observe!(
                calls,
                demlik_code_graph::extract::wrangler_config::load_binding_catalog,
                root,
                listing.as_ref()
            )
            .map_err(|error| error.to_string())?;
            let graph = observe!(
                calls,
                demlik_code_graph::boundaries::deployables::cycles::worker_graph,
                &catalog
            );
            let cycles = observe!(
                calls,
                demlik_code_graph::boundaries::deployables::cycles::worker_cycles,
                &graph
            );
            json(&GraphOutput {
                graph: &graph,
                cycles,
            })
        }
        _ => Err("unsupported operation".into()),
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
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    observed_calls: Vec<&'static str>,
}
fn main() -> io::Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request = serde_json::from_str::<Request>(&line);
        let mut observed_calls = Vec::new();
        let result = request
            .as_ref()
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut observed_calls));
        let response = Response {
            id: request.as_ref().ok().map(|request| request.id.clone()),
            ok: result.is_ok(),
            error: result.as_ref().err().map(|_| "driver_error"),
            diagnostic: result.as_ref().err().cloned(),
            output: result.ok(),
            observed_calls,
        };
        println!(
            "{}",
            serde_json::to_string(&response).expect("response is JSON data")
        );
    }
    Ok(())
}
