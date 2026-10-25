use demlik_code_graph::{
    boundaries::{
        config::BoundaryRuleInputError,
        libraries::{ImportTarget, LibrariesRead},
        rules::{ImportedFrom, LibraryType},
    },
    layers::resolve_target::WorkspacePackage,
    project::RepoListing,
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    path::Path,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibrariesInput {
    repo_root: String,
    rules: Box<RawValue>,
    listing: Option<Vec<String>>,
    files: Vec<JsString>,
    specifiers: Vec<JsString>,
    dirs: Vec<JsString>,
    zones: Vec<Option<ImportedFrom>>,
    roots: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackagesInput {
    repo_root: String,
    dirs: Vec<String>,
    specifiers: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobsInput {
    patterns: Vec<JsString>,
    specifiers: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrariesOutput<'a> {
    kind: &'static str,
    declared: bool,
    dirs: &'a [String],
    type_of_dir: Vec<(&'a String, &'a JsString)>,
    packages: Vec<(&'a JsString, &'a WorkspacePackage)>,
    package_dirs: &'a [String],
    scopes: Vec<JsString>,
    owners: Vec<Option<&'a str>>,
    targets: Vec<ImportTarget<'a>>,
    world: Vec<bool>,
    types: Vec<Option<&'a LibraryType>>,
    outside: Vec<Vec<bool>>,
    undeclared: Vec<Vec<String>>,
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
#[derive(Serialize)]
struct Thrown {
    name: &'static str,
    message: JsString,
}
#[derive(Serialize)]
struct ErrorOutput {
    thrown: Thrown,
}
fn glob_error(error: demlik_code_graph::kinds::glob::GlobError) -> Result<Box<RawValue>, String> {
    use demlik_code_graph::kinds::glob::GlobError;
    let (name, message) = match error {
        GlobError::Syntax(message) => ("Error", message),
        GlobError::Pattern(error) => ("SyntaxError", error.to_string().into()),
    };
    json(&ErrorOutput {
        thrown: Thrown { name, message },
    })
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    match request.operation.as_str() {
        "code_graph.libraries" => {
            let input: LibrariesInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let value = JsValue::parse(input.rules.get()).map_err(|error| error.to_string())?;
            let rules = match observe!(
                calls,
                demlik_code_graph::boundaries::rules::BoundaryRules::parse,
                &value
            ) {
                Ok(rules) => rules,
                Err(BoundaryRuleInputError::Issue(input_issue)) => {
                    #[derive(Serialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Refusal {
                        input_issue: demlik_code_graph::validation::InputIssue,
                    }
                    return json(&Refusal { input_issue });
                }
                Err(BoundaryRuleInputError::TypeError(error)) => {
                    return json(&ErrorOutput {
                        thrown: Thrown {
                            name: "TypeError",
                            message: error.to_string().into(),
                        },
                    });
                }
            };
            let root = Path::new(&input.repo_root);
            let listing = input.listing.map(|files| RepoListing {
                root: root.to_path_buf(),
                files,
            });
            let read = observe!(
                calls,
                demlik_code_graph::boundaries::libraries::read_libraries,
                &rules,
                root,
                listing.as_ref()
            );
            let libraries = match read {
                Ok(LibrariesRead::Read(libraries)) => libraries,
                Ok(LibrariesRead::Refused { message }) => {
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
                Err(error) => return glob_error(error),
            };
            let scopes = observe!(
                calls,
                demlik_code_graph::boundaries::libraries::library_scopes,
                &libraries
            );
            let owners = input
                .files
                .iter()
                .map(|file| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::owner_of,
                        &libraries,
                        file
                    )
                })
                .collect();
            let targets = input
                .specifiers
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::import_target_of,
                        &libraries,
                        specifier
                    )
                })
                .collect();
            let world = input
                .specifiers
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::is_world_library,
                        &libraries,
                        specifier
                    )
                })
                .collect();
            let types = input
                .dirs
                .iter()
                .map(|dir| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::library_type_of,
                        &libraries,
                        dir
                    )
                })
                .collect();
            let outside = input
                .dirs
                .iter()
                .map(|dir| {
                    input
                        .zones
                        .iter()
                        .map(|zone| {
                            observe!(
                                calls,
                                demlik_code_graph::boundaries::libraries::imported_from_outside,
                                &libraries,
                                dir,
                                *zone
                            )
                        })
                        .collect()
                })
                .collect();
            let undeclared = input
                .roots
                .iter()
                .map(|root| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::undeclared_under,
                        &libraries,
                        root
                    )
                })
                .collect();
            json(&LibrariesOutput {
                kind: "read",
                declared: libraries.declared(),
                dirs: &libraries.dirs,
                type_of_dir: libraries
                    .type_of_dir
                    .iter()
                    .map(|(dir, name)| (dir, *name))
                    .collect(),
                packages: libraries.packages.iter().collect(),
                package_dirs: &libraries.package_dirs,
                scopes,
                owners,
                targets,
                world,
                types,
                outside,
                undeclared,
            })
        }
        "code_graph.workspace-packages" => {
            let input: PackagesInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let packages = observe!(
                calls,
                demlik_code_graph::layers::resolve_target::workspace_packages,
                Path::new(&input.repo_root),
                &input.dirs
            );
            let matches: Vec<_> = input
                .specifiers
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::layers::resolve_target::match_package,
                        specifier,
                        &packages
                    )
                })
                .collect();
            #[derive(Serialize)]
            struct Output<'a> {
                packages: Vec<(&'a JsString, &'a WorkspacePackage)>,
                matches: Vec<Option<&'a WorkspacePackage>>,
            }
            json(&Output {
                packages: packages.iter().collect(),
                matches,
            })
        }
        "code_graph.package-globs" => {
            let input: GlobsInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let globs = input
                .patterns
                .iter()
                .map(|pattern| {
                    observe!(
                        calls,
                        demlik_code_graph::kinds::glob::glob_to_regexp,
                        pattern
                    )
                })
                .collect::<Result<Vec<_>, _>>();
            let globs = match globs {
                Ok(globs) => globs,
                Err(error) => return glob_error(error),
            };
            let matches: Vec<_> = input
                .specifiers
                .iter()
                .map(|specifier| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::in_package_globs,
                        &globs,
                        specifier
                    )
                })
                .collect();
            json(&matches)
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
