use demlik_code_graph::extract::wrangler_config::{BindingCatalog, CatalogError};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    root: PathBuf,
    #[serde(default)]
    reuse_listing: bool,
    listing_root: Option<PathBuf>,
}
#[derive(Serialize)]
struct Output {
    configs: Vec<PathBuf>,
    catalog: BindingCatalog,
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
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    let metadata_collation =
        demlik_code_graph::project::Collation::try_node22_en_us().map_err(|error| DriverError {
            kind: "backend-error",
            message: error.to_string(),
        })?;

    if case.operation != "code_graph.catalog" {
        return Err(DriverError {
            kind: "driver-error",
            message: format!("unsupported operation: {}", case.operation),
        });
    }
    let listing = case.input.reuse_listing.then(|| {
        observe!(
            calls,
            demlik_code_graph::project::list_repo,
            case.input
                .listing_root
                .as_deref()
                .unwrap_or(&case.input.root)
        )
    });
    let configs = observe!(
        calls,
        demlik_code_graph::extract::wrangler_config::find_wrangler_configs,
        &case.input.root,
        listing.as_ref()
    );
    let catalog = observe!(
        calls,
        demlik_code_graph::extract::wrangler_config::load_binding_catalog,
        &case.input.root,
        listing.as_ref(),
        &metadata_collation
    )
    .map_err(|error| DriverError {
        kind: if matches!(error, CatalogError::Record(_)) {
            "type-error"
        } else {
            "backend-error"
        },
        message: error.to_string(),
    })?;
    to_raw_value(&Output { configs, catalog }).map_err(|error| DriverError {
        kind: "driver-error",
        message: error.to_string(),
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(|error| DriverError {
                kind: "driver-error",
                message: error.to_string(),
            })
            .and_then(|case| execute(case, &mut observed_calls));
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
