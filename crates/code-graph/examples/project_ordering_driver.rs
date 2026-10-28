use demlik_code_graph::{
    hexagon::cli::HexagonOutput,
    project::{Collation, EdgeScope, LoadedEdgeProject, LoadedProject, RepoListing, to_relative},
    text::JsString,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{error::Error, fs, io, path::PathBuf};

macro_rules! observe {
    ($calls:expr, $trace:expr, $source:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        $calls.push($source);
        let returned = $function($($argument),*);
        $trace.push(stringify!($function));
        returned
    }};
}
#[derive(Deserialize)]
struct Input {
    id: String,
    mode: String,
    root: Option<PathBuf>,
    listing: Option<Vec<String>>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    reject: Vec<String>,
    scope: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    input: Input,
    directory: PathBuf,
}
fn loaded(value: &LoadedProject) -> Value {
    let files: Vec<_> = value.source_files.iter().map(|unit| {
        let syntax = &unit.syntax;
        let starts: Vec<_> = (0..=syntax.text_units().len())
            .filter(|position| *position == 0 || syntax.line_of(*position) != syntax.line_of(position - 1))
            .collect();
        json!({"file":unit.file,"absolutePath":unit.absolute_path,"text":syntax.text(),
            "lineStarts":starts,"comments":syntax.comments(),"rootType":syntax.root().kind(),
            "bodyTypes":syntax.root().nodes("body").iter().map(|node|node.kind()).collect::<Vec<_>>()})
    }).collect();
    json!({"rootAbsolute":value.root_absolute,"sourceFiles":files,"parseFailures":value.parse_failures})
}
fn edge(value: &LoadedEdgeProject) -> Value {
    let mut result = loaded(&value.project);
    result["tsConfigPath"] = json!(value.ts_config_path);
    result["scope"] = json!(match value.scope {
        EdgeScope::Package => "package",
        EdgeScope::Deep => "deep",
    });
    result
}
fn failure(
    name: &str,
    message: impl serde::Serialize,
    error: &dyn Error,
    causes: &mut Vec<Value>,
) -> Value {
    let mut sources = Vec::new();
    let mut source = error.source();
    while let Some(value) = source {
        sources.push(value.to_string());
        source = value.source();
    }
    causes.push(json!({"name":name,"display":error.to_string(),"sources":sources}));
    json!({"ok":false,"error":{"name":name,"message":message}})
}
fn execute(request: &Request) -> Result<Value, Box<dyn Error>> {
    let input = &request.input;
    let root = &request.directory;
    let selected = input
        .root
        .as_ref()
        .map_or_else(|| root.clone(), |scope| root.join(scope));
    let listing = input.listing.as_ref().map(|files| RepoListing {
        root: root.clone(),
        files: files.clone(),
    });
    let listing_before = listing
        .as_ref()
        .map(|value| serde_json::to_vec(&value.files))
        .transpose()?;
    let listing_owner = listing.as_ref().map(|value| value.files.as_ptr());
    let collation = Collation::try_node22_en_us()?;
    let mut calls = Vec::new();
    let mut trace = Vec::new();
    let mut causes = Vec::new();
    let output = match input.mode.as_str() {
        "list" => {
            let visible = observe!(
                calls,
                trace,
                "listVisibleFiles",
                demlik_code_graph::project::list_visible_files,
                &selected,
                |_| true,
                None,
                &collation
            )?;
            let sources = observe!(
                calls,
                trace,
                "listSourceFiles",
                demlik_code_graph::project::list_source_files,
                &selected,
                &collation
            )?;
            json!({"visible":visible,"sources":sources.iter().map(|file|to_relative(&selected,file)).collect::<Vec<_>>()})
        }
        "scope" => {
            let mut scopes = Vec::new();
            for scope in &input.scopes {
                let files = observe!(
                    calls,
                    trace,
                    "listVisibleFiles",
                    demlik_code_graph::project::list_visible_files,
                    &root.join(scope),
                    |_| true,
                    listing.as_ref(),
                    &collation
                )?;
                scopes.push(json!({"scope":scope,"files":files}));
            }
            json!(scopes)
        }
        "predicate" => {
            let mut seen = Vec::new();
            let files = observe!(
                calls,
                trace,
                "listVisibleFiles",
                demlik_code_graph::project::list_visible_files,
                &selected,
                |file| {
                    let keep = !input.reject.iter().any(|rejected| rejected == file);
                    seen.push(json!({"file":file,"keep":keep}));
                    keep
                },
                listing.as_ref(),
                &collation
            )?;
            json!({"files":files,"seen":seen})
        }
        "visible" => json!(observe!(
            calls,
            trace,
            "listVisibleFiles",
            demlik_code_graph::project::list_visible_files,
            &selected,
            |_| true,
            listing.as_ref(),
            &collation
        )?),
        "cheap" => match observe!(
            calls,
            trace,
            "loadCheapProject",
            demlik_code_graph::project::load_cheap_project,
            &selected,
            listing.as_ref(),
            &collation
        ) {
            Ok(value) => json!({"ok":true,"value":loaded(&value)}),
            Err(error) => failure("Error", error.message(), &error, &mut causes),
        },
        "edge" | "edge-scope" => {
            let scopes: Vec<_> = if input.mode == "edge-scope" {
                vec!["deep", "package"]
            } else {
                vec![input.scope.as_deref().unwrap_or("package")]
            };
            let mut values = Vec::new();
            for scope in scopes {
                let selected_scope = match scope {
                    "package" => EdgeScope::Package,
                    "deep" => EdgeScope::Deep,
                    _ => return Err("unknown scope".into()),
                };
                let result = match observe!(
                    calls,
                    trace,
                    "loadEdgeProject",
                    demlik_code_graph::project::load_edge_project,
                    &selected,
                    selected_scope,
                    root,
                    listing.as_ref(),
                    &collation
                ) {
                    Ok(value) => json!({"ok":true,"value":edge(&value)}),
                    Err(error) => failure("Error", error.message(), &error, &mut causes),
                };
                values.push(json!({"scope":scope,"result":result}));
            }
            if input.mode == "edge-scope" {
                json!(values)
            } else {
                values.remove(0)["result"].take()
            }
        }
        "roots" => json!(observe!(
            calls,
            trace,
            "discoverPackageRoots",
            demlik_code_graph::project::discover_package_roots,
            &selected,
            listing.as_ref()
        )),
        "workspaces" => {
            let roots = observe!(
                calls,
                trace,
                "discoverPackageRoots",
                demlik_code_graph::project::discover_package_roots,
                &selected,
                listing.as_ref()
            );
            let packages = observe!(
                calls,
                trace,
                "workspacePackages",
                demlik_code_graph::layers::resolve_target::workspace_packages,
                &selected,
                &roots,
                &collation
            )?;
            json!({"roots":roots,"packages":packages.iter().collect::<Vec<_>>()})
        }
        "catalog" => {
            let files = observe!(
                calls,
                trace,
                "findWranglerConfigs",
                demlik_code_graph::extract::wrangler_config::find_wrangler_configs,
                &selected,
                listing.as_ref(),
                &collation
            )?;
            let catalog = match observe!(
                calls,
                trace,
                "loadBindingCatalog",
                demlik_code_graph::extract::wrangler_config::load_binding_catalog,
                &selected,
                listing.as_ref(),
                &collation
            ) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => failure(error.name(), error.message(), &error, &mut causes),
            };
            json!({"files":files,"catalog":catalog})
        }
        "hexagon" => {
            let selected: JsString = selected.to_string_lossy().as_ref().into();
            let report = match observe!(
                calls,
                trace,
                "readHexagon",
                demlik_code_graph::hexagon::read::read_hexagon,
                &selected
            ) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => failure("Error", error.message(), &error, &mut causes),
            };
            let mut emitted = Vec::new();
            let mut reported = Vec::new();
            let mut emit = |text: &JsString| {
                emitted.push(text.clone());
                Ok(())
            };
            let mut report_error = |error: &JsString| {
                reported.push(error.clone());
                Ok(())
            };
            let _outcome = observe!(
                calls,
                trace,
                "runHexagon",
                demlik_code_graph::hexagon::cli::run_hexagon,
                &selected,
                HexagonOutput {
                    json: true,
                    pretty: false,
                    emit: &mut emit,
                    report: &mut report_error
                }
            )?;
            json!({"report":report,"emitted":emitted,"reported":reported})
        }
        _ => return Err("unsupported native mode".into()),
    };
    assert_eq!(
        listing_before,
        listing
            .as_ref()
            .map(|value| serde_json::to_vec(&value.files))
            .transpose()?
    );
    assert_eq!(
        listing_owner,
        listing.as_ref().map(|value| value.files.as_ptr())
    );
    Ok(
        json!({"id":input.id,"view":{"output":output,"calls":calls,"listingUnchanged":true},"observedCalls":trace,"nativeCauses":causes}),
    )
}
fn main() -> Result<(), Box<dyn Error>> {
    let file = std::env::args().nth(1).ok_or("request file required")?;
    let request: Request = serde_json::from_slice(&fs::read(file)?)?;
    let returned = execute(&request)?;
    serde_json::to_writer(io::stdout().lock(), &returned)?;
    println!();
    Ok(())
}
