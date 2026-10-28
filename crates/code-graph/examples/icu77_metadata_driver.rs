use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    config::ConfigResolution,
    declarations::{discover::DiscoveredDeclaration, uses::DeclarationUses},
    engine::tsgo::TsgoBinary,
    extract::functions::discover_functions,
    kinds::rules::{NodeKindRules, PatternGroup, RuleCompileError},
    project::{Collation, load_cheap_project},
    syntax::imports::ImportGraph,
    text::JsString,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
};

macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    root: PathBuf,
    #[serde(default)]
    go: bool,
    #[serde(default)]
    group: PatternGroup,
    #[serde(default)]
    dirs: Vec<String>,
    #[serde(default)]
    names: Vec<JsString>,
    #[serde(default)]
    file_presets: Vec<JsString>,
}
#[derive(Serialize)]
struct Failure {
    stage: &'static str,
    name: &'static str,
    message: JsString,
}
impl Failure {
    fn error(stage: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            stage,
            name: "Error",
            message: error.to_string().into(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    declaration_specifiers: IndexMap<String, Vec<JsString>>,
    imports: ImportGraph,
    declarations: Vec<DiscoveredDeclaration>,
    export_names: IndexMap<String, Vec<JsString>>,
    uses: Option<DeclarationUses>,
}
#[derive(Serialize)]
struct Presets {
    presets: Option<Vec<&'static str>>,
    messages: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
    observed_calls: Vec<&'static str>,
}
fn execute(
    input: &Request,
    manifest: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, Failure> {
    if input.operation == "presets" {
        let rules = NodeKindRules {
            entry_export_presets: input
                .file_presets
                .iter()
                .map(|name| {
                    if name == "nextjs" {
                        Ok(demlik_code_graph::kinds::presets::EntryExportPresetName::Nextjs)
                    } else {
                        Err(Failure::error("presets", "unknown fixture preset"))
                    }
                })
                .collect::<Result<_, _>>()?,
            ..NodeKindRules::default()
        };
        let (presets, messages) = match observe!(
            calls,
            demlik_code_graph::config::with_entry_presets,
            rules,
            &input.names
        ) {
            ConfigResolution::Resolved(rules) => (
                Some(
                    rules
                        .entry_export_presets
                        .iter()
                        .map(|name| name.as_str())
                        .collect(),
                ),
                vec![],
            ),
            ConfigResolution::Refused { message } => (None, vec![message]),
        };
        return to_raw_value(&Presets { presets, messages }).map_err(|e| Failure::error("wire", e));
    }
    let collation = Collation::try_node22_en_us().map_err(|e| Failure::error("collation", e))?;
    let output = match input.operation.as_str() {
        "rules" => {
            let rules = observe!(
                calls,
                demlik_code_graph::kinds::rules::compile_group,
                &input.group,
                &collation
            )
            .map_err(|error| {
                let name = if matches!(error, RuleCompileError::Regex(_)) {
                    "SyntaxError"
                } else {
                    "Error"
                };
                Failure {
                    stage: "rules",
                    name,
                    message: error.to_string().into(),
                }
            })?;
            to_raw_value(&rules.iter().map(|rule| &rule.key).collect::<Vec<_>>())
        }
        "catalog" => {
            let catalog = observe!(
                calls,
                demlik_code_graph::extract::wrangler_config::load_binding_catalog,
                &input.root,
                None,
                &collation
            )
            .map_err(|e| Failure {
                stage: "catalog",
                name: e.name(),
                message: e.message(),
            })?;
            to_raw_value(&catalog)
        }
        "entry" => {
            let entries = input
                .dirs
                .iter()
                .map(|dir| {
                    observe!(
                        calls,
                        demlik_code_graph::extract::package_exports::package_source_entry,
                        &input.root,
                        dir,
                        &collation
                    )
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| Failure::error("entry", e))?;
            to_raw_value(&entries)
        }
        "snapshot" => {
            let loaded =
                load_cheap_project(&input.root, None).map_err(|e| Failure::error("project", e))?;
            let functions = discover_functions(&loaded.source_files, &collation)
                .map_err(|error| Failure::error("snapshot", error))?
                .functions;
            let declarations = observe!(
                calls,
                demlik_code_graph::declarations::discover::discover_declarations,
                &loaded.source_files,
                &collation
            )
            .map_err(|e| Failure::error("snapshot", e))?;
            let imports = observe!(
                calls,
                demlik_code_graph::syntax::imports::resolve_imports,
                &input.root,
                &loaded.source_files,
                &input.root.join("tsconfig.json"),
                &collation
            )
            .map_err(|e| Failure::error("snapshot", e))?;
            let declaration_specifiers = loaded
                .source_files
                .iter()
                .map(|unit| {
                    observe!(
                        calls,
                        demlik_code_graph::syntax::imports::import_declaration_specifiers,
                        &unit.syntax,
                        &collation
                    )
                    .map(|names| (unit.file.clone(), names))
                })
                .collect::<Result<_, _>>()
                .map_err(|e| Failure::error("snapshot", e))?;
            let export_names = observe!(
                calls,
                demlik_code_graph::extract::conventions::export_names_by_id,
                &functions,
                &collation
            )
            .map_err(|e| Failure::error("snapshot", e))?;
            let uses = if input.go {
                let binary = TsgoBinary::from_native_preview_manifest(manifest)
                    .map_err(|e| Failure::error("uses", e))?;
                Some(
                    with_type_context(
                        &binary,
                        TypeContextInput {
                            project: &loaded,
                            ts_config_path: &input.root.join("tsconfig.json"),
                            functions: &functions,
                        },
                        |context| {
                            Ok(observe!(
                                calls,
                                demlik_code_graph::declarations::uses::resolve_declaration_uses,
                                context,
                                &declarations,
                                &collation
                            ))
                        },
                    )
                    .map_err(|e| Failure::error("uses", e))?
                    .map_err(|e| Failure::error("uses", e))?,
                )
            } else {
                None
            };
            to_raw_value(&Snapshot {
                declaration_specifiers,
                imports,
                declarations,
                export_names,
                uses,
            })
        }
        _ => return Err(Failure::error("protocol", "unknown operation")),
    };
    output.map_err(|e| Failure::error("wire", e))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("explicit native compiler manifest required")?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = vec![];
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(input) => match execute(&input, Path::new(&manifest), &mut calls) {
                Ok(output) => Response {
                    id: Some(input.id),
                    ok: true,
                    output: Some(output),
                    error: None,
                    observed_calls: calls,
                },
                Err(error) => Response {
                    id: Some(input.id),
                    ok: false,
                    output: None,
                    error: Some(error),
                    observed_calls: calls,
                },
            },
            Err(error) => Response {
                id: None,
                ok: false,
                output: None,
                error: Some(Failure::error("protocol", error)),
                observed_calls: calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
