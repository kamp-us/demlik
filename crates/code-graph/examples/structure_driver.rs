use std::io::{self, BufRead};
use std::path::PathBuf;

use demlik_code_graph::declarations::discover::DiscoveredDeclaration;
use demlik_code_graph::extract::assemble::NodeFields;
use demlik_code_graph::schema::{Graph, Thresholds};
use demlik_code_graph::syntax::imports::{ImportGraph, ImportLiteral, ImportedNames};
use demlik_code_graph::text::JsString;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};

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
    headers: bool,
    #[serde(default)]
    thresholds: Thresholds,
    ts_config: Option<PathBuf>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Imports {
    file: String,
    literals: Vec<ImportLiteral>,
    runtime_specifiers: Vec<JsString>,
    imported_names: Vec<(JsString, ImportedNames)>,
    declaration_specifiers: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    graph: Graph,
    imports: Vec<Imports>,
    resolved_imports: Option<ImportGraph>,
    declarations: Vec<DiscoveredDeclaration>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
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

fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    if case.operation != "code_graph.structure" {
        return Err(format!("unsupported operation: {}", case.operation));
    }
    let loaded = observe!(
        calls,
        demlik_code_graph::project::load_cheap_project,
        &case.input.root,
        None,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let graph = observe!(
        calls,
        demlik_code_graph::extract::assemble::assemble_graph,
        &loaded,
        case.input.thresholds,
        NodeFields {
            headers: case.input.headers
        },
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let declarations = observe!(
        calls,
        demlik_code_graph::declarations::discover::discover_declarations,
        &loaded.source_files,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?;
    let imports = loaded
        .source_files
        .iter()
        .map(|unit| {
            let literals = observe!(
                calls,
                demlik_code_graph::syntax::imports::import_literals,
                &unit.syntax
            );
            let runtime_specifiers = observe!(
                calls,
                demlik_code_graph::syntax::imports::runtime_specifiers,
                &unit.syntax
            )
            .into_iter()
            .collect();
            let imported_names = observe!(
                calls,
                demlik_code_graph::syntax::imports::imported_names_of,
                &unit.syntax
            )
            .into_iter()
            .collect();
            let declaration_specifiers = observe!(
                calls,
                demlik_code_graph::syntax::imports::import_declaration_specifiers,
                &unit.syntax,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            Ok::<_, String>(Imports {
                file: unit.file.clone(),
                literals,
                runtime_specifiers,
                imported_names,
                declaration_specifiers,
            })
        })
        .collect::<Result<_, _>>()?;
    let resolved_imports = case
        .input
        .ts_config
        .map(|ts_config| {
            observe!(
                calls,
                demlik_code_graph::syntax::imports::resolve_imports,
                &case.input.root,
                &loaded.source_files,
                &ts_config,
                &metadata_collation
            )
            .map_err(|error| error.to_string())
        })
        .transpose()?;
    to_raw_value(&Output {
        graph,
        imports,
        resolved_imports,
        declarations,
    })
    .map_err(|error| error.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(case, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(message) => Response {
                id,
                ok: false,
                output: None,
                error: Some(DriverError {
                    kind: "driver_error",
                    message,
                }),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
