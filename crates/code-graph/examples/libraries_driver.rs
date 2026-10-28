use demlik_code_graph::{
    boundaries::{
        config::BoundaryRuleInputError,
        libraries::{ImportTarget, LibrariesRead},
        rules::{BoundaryRules, ImportedFrom, LibraryType},
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    file: JsString,
    source: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JudgmentInput {
    repo_root: String,
    rules: Box<RawValue>,
    scope: JsString,
    file: JsString,
    source: String,
    named_files: Vec<SourceFile>,
    license_dir: JsString,
    license_specifiers: indexmap::IndexSet<JsString>,
    measured_scopes: Vec<JsString>,
    measured_undeclared: Vec<JsString>,
    unjudged: f64,
    roots: Vec<JsString>,
    zone: Option<ImportedFrom>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Checked<T> {
    Value(T),
    Thrown { thrown: Thrown },
}
fn checked<T>(
    result: Result<T, demlik_code_graph::boundaries::libraries::LibraryRuleError>,
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
struct JudgmentOutput<'a> {
    names: Vec<(
        &'a JsString,
        &'a demlik_code_graph::syntax::imports::ImportedNames,
    )>,
    licensed: Checked<bool>,
    allowance_issue: Option<JsString>,
    judgment: Checked<demlik_code_graph::boundaries::libraries::violations::LibraryJudgment>,
    undeclared: Vec<Vec<demlik_code_graph::boundaries::violation::BoundaryViolation>>,
    census: Option<demlik_code_graph::boundaries::libraries::census::LibraryCensus>,
    lines: Option<Vec<JsString>>,
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
fn library_error(
    error: demlik_code_graph::boundaries::libraries::LibraryReadError,
) -> Result<Box<RawValue>, String> {
    match error {
        demlik_code_graph::boundaries::libraries::LibraryReadError::Pattern(error) => {
            glob_error(error)
        }
        demlik_code_graph::boundaries::libraries::LibraryReadError::Collation(error) => {
            Err(error.to_string())
        }
    }
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    match request.operation.as_str() {
        "code_graph.library-judgment" => {
            let input: JudgmentInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let value = JsValue::parse(input.rules.get()).map_err(|error| error.to_string())?;
            let rules =
                observe!(calls, BoundaryRules::parse, &value).map_err(|error| error.to_string())?;
            let libraries = match observe!(
                calls,
                demlik_code_graph::boundaries::libraries::read_libraries,
                &rules,
                Path::new(&input.repo_root),
                None,
                &metadata_collation
            ) {
                Ok(LibrariesRead::Read(libraries)) => libraries,
                Ok(LibrariesRead::Refused { message }) => return Err(message.to_lossy()),
                Err(error) => return library_error(error),
            };
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file.to_lossy()),
                &input.source
            )
            .map_err(|error| error.to_string())?;
            let names = observe!(
                calls,
                demlik_code_graph::boundaries::libraries::allowance::imported_names_for,
                &libraries,
                &input.scope,
                &syntax
            );
            let edges: Vec<_> = demlik_code_graph::syntax::imports::import_literals(&syntax)
                .into_iter()
                .map(|edge| demlik_code_graph::syntax::imports::ImportEdge {
                    specifier: edge.specifier,
                    kind: edge.kind,
                    type_only: edge.type_only,
                    target: None,
                })
                .collect();
            let runtime = demlik_code_graph::syntax::imports::runtime_specifiers(&syntax);
            let impure = demlik_code_graph::boundaries::impure_uses::detect_impure_uses(&syntax);
            let licensed = checked(observe!(
                calls,
                demlik_code_graph::boundaries::libraries::allowance::is_licensed,
                &libraries,
                &input.scope,
                &input.license_dir,
                &input.license_specifiers,
                demlik_code_graph::boundaries::libraries::allowance::NamedFile {
                    file: &input.file,
                    imported_names: &names
                }
            ));
            let judgment = checked(observe!(
                calls,
                demlik_code_graph::boundaries::libraries::violations::judge_libraries,
                &libraries,
                &input.scope,
                demlik_code_graph::boundaries::libraries::violations::LibraryFile {
                    file: &input.file,
                    imported_names: &names,
                    facts: demlik_code_graph::boundaries::impure_uses::ImpureFacts {
                        impure_uses: &impure,
                        import_edges: &edges,
                        runtime_specifiers: &runtime
                    }
                },
                input.zone
            ));
            let mut held = Vec::new();
            for file in &input.named_files {
                let syntax = demlik_code_graph::engine::oxc::parse_type_script(
                    Path::new(&file.file.to_lossy()),
                    &file.source,
                )
                .map_err(|error| error.to_string())?;
                let names = observe!(
                    calls,
                    demlik_code_graph::boundaries::libraries::allowance::imported_names_for,
                    &libraries,
                    &input.scope,
                    &syntax
                );
                held.push((&file.file, names));
            }
            let named: Vec<_> = held
                .iter()
                .map(|(file, names)| {
                    demlik_code_graph::boundaries::libraries::allowance::NamedFile {
                        file,
                        imported_names: names,
                    }
                })
                .collect();
            let allowance_issue = observe!(
                calls,
                demlik_code_graph::boundaries::libraries::allowance::allowance_issue,
                &libraries,
                &input.scope,
                &named
            );
            let undeclared = input
                .roots
                .iter()
                .map(|root| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::libraries::violations::undeclared_libraries,
                        &libraries,
                        root
                    )
                })
                .collect();
            let census = observe!(
                calls,
                demlik_code_graph::boundaries::libraries::census::library_census,
                &libraries,
                demlik_code_graph::boundaries::libraries::census::MeasuredLibraries {
                    scopes: &input.measured_scopes,
                    undeclared: &input.measured_undeclared,
                    unjudged: input.unjudged
                }
            );
            let lines = census.as_ref().map(|census| {
                observe!(
                    calls,
                    demlik_code_graph::boundaries::libraries::census::census_lines,
                    census
                )
            });
            json(&JudgmentOutput {
                names: names.iter().collect(),
                licensed,
                allowance_issue,
                judgment,
                undeclared,
                census,
                lines,
            })
        }
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
                listing.as_ref(),
                &metadata_collation
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
                Err(error) => return library_error(error),
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
                &input.dirs,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
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
