use std::io::{self, BufRead};
use std::path::PathBuf;

use demlik_code_graph::engine::oxc::FileResolution;
use demlik_code_graph::project::EdgeScope;
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
    input: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListingInput {
    root: PathBuf,
    scope: Option<PathBuf>,
    #[serde(default)]
    shared_listing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigInput {
    root: PathBuf,
    repo_root: PathBuf,
    scope: Scope,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Package,
    Deep,
}

#[derive(Deserialize)]
struct RelativeInput {
    root: PathBuf,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveInput {
    from_file: PathBuf,
    ts_config_path: Option<PathBuf>,
    specifiers: Vec<String>,
    #[serde(default)]
    locate: Vec<String>,
}

fn execute(case: &Case, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    match case.operation.as_str() {
        "code_graph.project.list" => {
            let input: ListingInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let root = input.scope.as_deref().unwrap_or(&input.root);
            let collation = demlik_code_graph::project::Collation::try_node22_en_us()
                .map_err(|error| error.to_string())?;
            let listing = input
                .shared_listing
                .then(|| observe!(calls, demlik_code_graph::project::list_repo, &input.root));
            let visible = observe!(
                calls,
                demlik_code_graph::project::list_visible_files,
                root,
                |_| true,
                listing.as_ref(),
                &collation
            )
            .map_err(|error| error.to_string())?;
            let sources = observe!(
                calls,
                demlik_code_graph::project::list_source_files,
                root,
                &collation
            )
            .map_err(|error| error.to_string())?;
            let sources: Vec<_> = sources
                .iter()
                .map(|file| observe!(calls, demlik_code_graph::project::to_relative, root, file))
                .collect();
            let packages = observe!(
                calls,
                demlik_code_graph::project::discover_package_roots,
                root,
                listing.as_ref()
            );
            let repo = observe!(calls, demlik_code_graph::project::find_repo_root, root);
            let config = observe!(
                calls,
                demlik_code_graph::project::find_nearest_tsconfig,
                root
            );
            Ok(
                json!({ "visible": visible, "sources": sources, "packageRoots": packages, "repoRoot": repo, "nearestTsConfig": config }),
            )
        }
        "code_graph.project.config" => {
            let input: ConfigInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let scope = match input.scope {
                Scope::Package => EdgeScope::Package,
                Scope::Deep => EdgeScope::Deep,
            };
            let config = observe!(
                calls,
                demlik_code_graph::project::resolve_edge_ts_config,
                &input.root,
                scope,
                &input.repo_root
            )
            .map_err(|error| error.to_string())?;
            Ok(json!(config))
        }
        "code_graph.project.relative" => {
            let input: RelativeInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            Ok(json!(observe!(
                calls,
                demlik_code_graph::project::to_relative,
                &input.root,
                &input.path
            )))
        }
        "code_graph.resolve.module" => {
            let input: ResolveInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let config = input
                .ts_config_path
                .ok_or("tsConfigPath is required for explicit-config resolution")?;
            let resolver = observe!(
                calls,
                demlik_code_graph::engine::oxc::create_module_resolver,
                &config
            );
            let resolutions: Vec<_> = input
                .specifiers
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::engine::oxc::ModuleResolver::resolve,
                        &resolver,
                        &input.from_file,
                        specifier
                    )
                })
                .collect();
            Ok(json!({ "resolutions": resolutions }))
        }
        "code_graph.resolve.nearest" => {
            let input: ResolveInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let resolver = observe!(
                calls,
                demlik_code_graph::engine::oxc::create_nearest_tsconfig_resolver
            );
            let resolutions: Vec<Value> = input
                .specifiers
                .iter()
                .map(|specifier| {
                    match observe!(
                        calls,
                        demlik_code_graph::engine::oxc::NearestTsconfigResolver::resolve,
                        &resolver,
                        &input.from_file,
                        specifier
                    ) {
                        FileResolution::Path(path) => json!({ "kind": "path", "path": path }),
                        FileResolution::Builtin => json!({ "kind": "builtin" }),
                        FileResolution::Missing => json!({ "kind": "missing" }),
                    }
                })
                .collect();
            let directory = input
                .from_file
                .parent()
                .ok_or("fromFile has no parent directory")?;
            let located: Vec<_> = input
                .locate
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::engine::oxc::NearestTsconfigResolver::locate,
                        &resolver,
                        directory,
                        specifier
                    )
                })
                .collect();
            Ok(json!({ "resolutions": resolutions, "located": located }))
        }
        operation => Err(format!("unsupported operation: {operation}")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let mut calls = Vec::new();
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed
            .as_ref()
            .map(|case| Value::String(case.id.clone()))
            .unwrap_or(Value::Null);
        let result = parsed
            .map_err(|error| error.to_string())
            .and_then(|case| execute(&case, &mut calls));
        let response = match result {
            Ok(output) => json!({ "id": id, "ok": true, "output": output, "observedCalls": calls }),
            Err(message) => {
                json!({ "id": id, "ok": false, "error": { "kind": "driver_error", "message": message }, "observedCalls": calls })
            }
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
