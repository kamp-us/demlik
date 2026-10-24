use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

use demlik_code_graph::project::EdgeScope;
use demlik_code_graph::resolve::{InProcessGraph, SubpathEntries};
use serde::Deserialize;
use serde_json::{Value, json};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let returned = $function($($argument),*);
        $calls.push(stringify!($function));
        returned
    }};
}

#[derive(Deserialize)]
struct Case {
    id: String,
    operation: String,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    root: PathBuf,
    repo_root: Option<PathBuf>,
    scope: Option<Scope>,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Package,
    Deep,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Step {
    Origin {
        #[serde(rename = "fromFile")]
        from_file: PathBuf,
        specifier: String,
        name: String,
    },
    Module {
        file: PathBuf,
        name: String,
    },
    Publishing {
        entries: SubpathEntries,
        name: String,
    },
    Dispose,
}

fn query(
    graph: &mut InProcessGraph,
    step: Step,
    calls: &mut Vec<&'static str>,
) -> Result<Value, String> {
    match step {
        Step::Origin {
            from_file,
            specifier,
            name,
        } => serde_json::to_value(
            observe!(
                calls,
                demlik_code_graph::resolve::InProcessGraph::resolve_export_origin,
                graph,
                &from_file,
                &specifier,
                &name
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        Step::Module { file, name } => serde_json::to_value(
            observe!(
                calls,
                demlik_code_graph::resolve::InProcessGraph::resolve_module_export,
                graph,
                &file,
                &name
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        Step::Publishing { entries, name } => serde_json::to_value(
            observe!(
                calls,
                demlik_code_graph::resolve::InProcessGraph::resolve_publishing_subpaths,
                graph,
                &entries,
                &name
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        Step::Dispose => {
            observe!(
                calls,
                demlik_code_graph::resolve::InProcessGraph::dispose,
                graph
            );
            Ok(Value::Null)
        }
    }
}

fn execute(case: Case, manifest: &Path, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    if case.operation != "code_graph.semantic" {
        return Err(format!("unsupported operation: {}", case.operation));
    }
    let compiler = observe!(
        calls,
        demlik_code_graph::engine::tsgo::TsgoBinary::from_native_preview_manifest,
        manifest
    )
    .map_err(|error| error.to_string())?;
    let mut options = observe!(
        calls,
        demlik_code_graph::resolve::InProcessGraphOptions::new,
        compiler
    );
    options.scope = match case.input.scope {
        None | Some(Scope::Package) => EdgeScope::Package,
        Some(Scope::Deep) => EdgeScope::Deep,
    };
    options.repo_root = case.input.repo_root;
    let graph = observe!(
        calls,
        demlik_code_graph::resolve::load_in_process_graph,
        &case.input.root,
        options
    )
    .map_err(|error| error.to_string())?;
    let Some(mut graph) = graph else {
        return Ok(json!({ "loaded": false, "answers": [] }));
    };
    let answers: Vec<_> = case
        .input
        .steps
        .into_iter()
        .map(|step| match query(&mut graph, step, calls) {
            Ok(answer) => json!({ "ok": true, "answer": answer }),
            Err(message) => {
                json!({ "ok": false, "error": { "kind": "query_error", "message": message } })
            }
        })
        .collect();
    Ok(json!({ "loaded": true, "answers": answers }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args_os()
        .nth(1)
        .ok_or("usage: semantic_driver <native-preview-package.json>")?;
    let manifest = PathBuf::from(manifest);
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed
            .as_ref()
            .map(|case| Value::String(case.id.clone()))
            .unwrap_or(Value::Null);
        let mut calls = Vec::new();
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(case, &manifest, &mut calls));
        let answer = match result {
            Ok(output) => json!({ "id": id, "ok": true, "output": output, "observedCalls": calls }),
            Err(message) => {
                json!({ "id": id, "ok": false, "error": { "kind": "driver_error", "message": message }, "observedCalls": calls })
            }
        };
        println!("{}", serde_json::to_string(&answer)?);
    }
    Ok(())
}
