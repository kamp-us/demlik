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
