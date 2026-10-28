use std::io::{self, BufRead};
use std::path::PathBuf;

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
    #[serde(default)]
    include_nodes: bool,
    #[serde(default)]
    shared_listing: bool,
}

fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    if case.operation != "code_graph.syntax" {
        return Err(format!("unsupported operation: {}", case.operation));
    }
    let listing = case.input.shared_listing.then(|| {
        observe!(
            calls,
            demlik_code_graph::project::list_repo,
            &case.input.root
        )
    });
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;
    let project = observe!(
        calls,
        demlik_code_graph::project::load_cheap_project,
        &case.input.root,
        listing.as_ref(),
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let discovered = observe!(
        calls,
        demlik_code_graph::extract::functions::discover_functions,
        &project.source_files,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let functions: Vec<_> = discovered
        .functions
        .iter()
        .map(|function| {
            let metrics = observe!(
                calls,
                demlik_code_graph::extract::metrics::compute_function_metrics,
                function
            );
            let header = observe!(
                calls,
                demlik_code_graph::syntax::headers::function_header,
                function.node()
            );
            json!({ "function": function, "metrics": metrics, "header": header })
        })
        .collect();
    let files: Vec<_> = project.source_files.iter().map(|unit| {
        let syntax = &unit.syntax;
        let comments = observe!(calls, demlik_code_graph::extract::metrics::collect_module_comment_ranges, syntax);
        let comment_lines = observe!(calls, demlik_code_graph::extract::metrics::module_comment_lines, syntax);
        let loc = observe!(calls, demlik_code_graph::extract::metrics::module_loc, syntax);
        let root = observe!(calls, demlik_code_graph::syntax::file::SyntaxFile::root, syntax);
        let descendants = observe!(calls, demlik_code_graph::syntax::file::NodeRef::ts_descendants, root);
        let mut nodes = Vec::new();
        let mut bindings = Vec::new();
        let mut literal_units = Vec::new();
        for node in std::iter::once(root).chain(descendants) {
            if matches!(node.kind(), "TSParameterProperty" | "ObjectPattern" | "ArrayPattern") {
                let names = observe!(calls, demlik_code_graph::syntax::bindings::pattern_names, Some(node));
                bindings.push(json!({ "start": node.start(), "names": names }));
            }
            if node.kind() == "Literal" && let Some(units) = node.string_units("value") { literal_units.push(json!({ "start": node.start(), "value": units })); }
            if node.kind() == "TemplateElement" { literal_units.push(json!({ "start": node.start(), "value": node.string_units_path(&["value", "cooked"]) })); }
            if case.input.include_nodes { nodes.push(json!({ "kind": node.kind(), "start": node.start(), "end": node.end(), "tsStart": node.ts_start(), "line": node.start_line(), "column": node.start_column(), "endLine": node.end_line(), "children": node.ts_children().iter().map(|child| json!([child.kind(), child.start(), child.end()])).collect::<Vec<_>>() })); }
        }
        json!({ "file": unit.file, "loc": loc, "commentLines": comment_lines, "comments": comments, "bindings": bindings, "literalUnits": literal_units, "nodes": nodes })
    }).collect();
    Ok(json!({ "parseFailures": project.parse_failures, "files": files, "functions": functions }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed
            .as_ref()
            .map(|case| Value::String(case.id.clone()))
            .unwrap_or(Value::Null);
        let mut calls = Vec::new();
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(case, &mut calls));
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
