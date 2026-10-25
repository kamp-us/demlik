use demlik_code_graph::{
    boundaries::{
        deployables::BindingSite,
        libraries::{Libraries, LibrariesRead},
        rules::BoundaryRules,
        shape::{Shape, ShapeFacts, ShapeRead},
        zones::reads::{DrivenVerdict, ReadImports, ReadModule, ScopeAllowance, ScopeReads},
    },
    extract::wrangler_config::BindingCatalog,
    kinds::glob::GlobError,
    syntax::imports::{ImportEdge, ImportKind},
    text::{JsRegex, JsString, JsValue},
};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    fs,
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
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Source {
    File,
    Text { text: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInput {
    file: JsString,
    source: Source,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    repo_root: String,
    rules: Box<RawValue>,
    scope: JsString,
    files: Vec<FileInput>,
    targets: Vec<JsString>,
    probes: Vec<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteInput {
    binding: JsString,
    line: JsValue,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleInput {
    file: JsString,
    first_write: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpaqueInput {
    repo_root: String,
    rules: Box<RawValue>,
    scope: JsString,
    modules: Vec<ModuleInput>,
    loaded: IndexSet<JsString>,
    import_specifiers: Vec<JsString>,
    runtime_specifiers: IndexSet<JsString>,
    targets: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared<'a> {
    kinds: &'a IndexSet<demlik_code_graph::boundaries::rules::ShapeKind>,
    may_import: &'a IndexSet<JsString>,
    pure: Vec<Vec<bool>>,
    tests: Vec<Vec<bool>>,
    roots: Vec<Vec<bool>>,
    scopes: Vec<(&'a JsString, &'a ScopeAllowance)>,
}
fn matches(globs: &[JsRegex], probes: &[JsString]) -> Vec<Vec<bool>> {
    globs
        .iter()
        .map(|glob| probes.iter().map(|probe| glob.test(probe)).collect())
        .collect()
}
fn prepared<'a>(shape: &'a Shape<'_>, probes: &[JsString]) -> Prepared<'a> {
    Prepared {
        kinds: &shape.kinds,
        may_import: &shape.may_import,
        pure: matches(&shape.pure, probes),
        tests: matches(&shape.tests, probes),
        roots: matches(&shape.roots, probes),
        scopes: shape.allowance.scopes.iter().collect(),
    }
}
#[derive(Serialize)]
struct Scoped<'a> {
    allowance: &'a ScopeAllowance,
    writes: Vec<(
        &'a JsString,
        &'a demlik_code_graph::boundaries::violation::WriteSite,
    )>,
}
fn scoped<'a>(reads: &'a ScopeReads<'_>) -> Scoped<'a> {
    Scoped {
        allowance: reads.allowance,
        writes: reads
            .writes
            .iter()
            .map(|(file, write)| (file, write.as_ref()))
            .collect(),
    }
}
#[derive(Serialize)]
struct Thrown {
    name: &'static str,
    message: JsString,
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn glob_error(error: GlobError) -> Result<Box<RawValue>, String> {
    let (name, message) = match error {
        GlobError::Syntax(message) => ("Error", message),
        GlobError::Pattern(error) => ("SyntaxError", error.to_string().into()),
    };
    json(&Thrown { name, message })
}
fn parse_rules(raw: &RawValue, calls: &mut Vec<&'static str>) -> Result<BoundaryRules, String> {
    let value = JsValue::parse(raw.get()).map_err(|error| error.to_string())?;
    observe!(calls, BoundaryRules::parse, &value).map_err(|error| error.to_string())
}
fn catalog(root: &Path, calls: &mut Vec<&'static str>) -> Result<BindingCatalog, String> {
    observe!(
        calls,
        demlik_code_graph::extract::wrangler_config::load_binding_catalog,
        root,
        None
    )
    .map_err(|error| error.to_string())
}
fn libraries<'a>(
    rules: &'a BoundaryRules,
    root: &Path,
    calls: &mut Vec<&'static str>,
) -> Result<Libraries<'a>, String> {
    match observe!(
        calls,
        demlik_code_graph::boundaries::libraries::read_libraries,
        rules,
        root,
        None
    )
    .map_err(|error| error.to_string())?
    {
        LibrariesRead::Read(libraries) => Ok(libraries),
        LibrariesRead::Refused { message } => Err(message.to_lossy()),
    }
}
fn verdicts<'a>(
    reads: Option<&'a ScopeReads<'a>>,
    imports: ReadImports<'a>,
    libraries: &'a Libraries<'a>,
    targets: &[JsString],
    calls: &mut Vec<&'static str>,
) -> Vec<DrivenVerdict<'a>> {
    let driven = observe!(
        calls,
        demlik_code_graph::boundaries::zones::reads::driven_reads_of,
        reads,
        imports,
        libraries
    );
    targets
        .iter()
        .map(|target| {
            observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::DrivenReads::verdict,
                &driven,
                target
            )
        })
        .collect()
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    match request.operation.as_str() {
        "code_graph.scoped-reads" => {
            let input: OpaqueInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let modules = input
                .modules
                .iter()
                .map(|module| {
                    serde_json::from_str::<Option<SiteInput>>(module.first_write.get())
                        .map_err(|error| error.to_string())?
                        .as_ref()
                        .map(|site| {
                            site.line
                                .as_number()
                                .map(|line| BindingSite {
                                    binding: site.binding.clone(),
                                    line,
                                })
                                .ok_or_else(|| "firstWrite.line must be a number".to_owned())
                        })
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()?;
            let rules = parse_rules(&input.rules, calls)?;
            let catalog = catalog(Path::new(&input.repo_root), calls)?;
            let allowance = observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::read_allowance_of,
                &rules.read_allowance,
                &catalog
            );
            let modules: Vec<_> = input
                .modules
                .iter()
                .zip(&modules)
                .map(|(module, site)| ReadModule {
                    file: &module.file,
                    first_write: site.as_ref(),
                })
                .collect();
            let reads = observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::scope_reads_of,
                &allowance,
                &input.scope,
                &modules
            );
            let unknown = observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::unknown_driven,
                &allowance,
                &input.scope,
                &input.loaded
            );
            let libraries = libraries(&rules, Path::new(&input.repo_root), calls)?;
            let edges: Vec<_> = input
                .import_specifiers
                .iter()
                .map(|specifier| ImportEdge {
                    specifier: specifier.clone(),
                    kind: ImportKind::Static,
                    type_only: false,
                    target: None,
                })
                .collect();
            let verdicts = verdicts(
                reads.as_ref(),
                ReadImports {
                    import_edges: &edges,
                    runtime_specifiers: &input.runtime_specifiers,
                },
                &libraries,
                &input.targets,
                calls,
            );
            #[derive(Serialize)]
            struct Output<'a> {
                scopes: Vec<(&'a JsString, &'a ScopeAllowance)>,
                unknown: Vec<&'a JsString>,
                reads: Option<Scoped<'a>>,
                verdicts: Vec<DrivenVerdict<'a>>,
            }
            json(&Output {
                scopes: allowance.scopes.iter().collect(),
                unknown,
                reads: reads.as_ref().map(scoped),
                verdicts,
            })
        }
        "code_graph.read-sites" | "code_graph.shape-reads" => {
            let input: Input =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let rules = parse_rules(&input.rules, calls)?;
            let root = Path::new(&input.repo_root);
            let catalog = catalog(root, calls)?;
            let read = observe!(
                calls,
                demlik_code_graph::boundaries::shape::read_shape,
                &rules,
                &catalog
            );
            let shape = match read {
                Ok(ShapeRead::Read(shape)) => shape,
                Ok(ShapeRead::Refused { message }) => {
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
            let libraries = libraries(&rules, root, calls)?;
            let mut held = Vec::new();
            for file in &input.files {
                let source = match &file.source {
                    Source::Text { text } => text.clone(),
                    Source::File => {
                        let relative = demlik_code_graph::boundaries::rules::in_scope(
                            &input.scope,
                            &file.file,
                        );
                        let bytes = fs::read(root.join(relative.to_lossy()))
                            .map_err(|error| error.to_string())?;
                        String::from_utf8_lossy(&bytes).into_owned()
                    }
                };
                let syntax = observe!(
                    calls,
                    demlik_code_graph::engine::oxc::parse_type_script,
                    Path::new(&file.file.to_lossy()),
                    &source
                )
                .map_err(|error| error.to_string())?;
                let facts = if request.operation == "code_graph.read-sites" {
                    ShapeFacts {
                        offending_form: None,
                        first_write: observe!(
                            calls,
                            demlik_code_graph::boundaries::zones::reads::first_write,
                            &shape.allowance,
                            &input.scope,
                            &file.file,
                            &syntax
                        ),
                    }
                } else {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::shape::shape_facts_of,
                        &shape,
                        &input.scope,
                        &file.file,
                        &syntax
                    )
                };
                let edges: Vec<_> = demlik_code_graph::syntax::imports::import_literals(&syntax)
                    .into_iter()
                    .map(|edge| ImportEdge {
                        specifier: edge.specifier,
                        kind: edge.kind,
                        type_only: edge.type_only,
                        target: None,
                    })
                    .collect();
                let runtime = demlik_code_graph::syntax::imports::runtime_specifiers(&syntax);
                held.push((facts, edges, runtime));
            }
            let modules: Vec<_> = input
                .files
                .iter()
                .zip(&held)
                .map(|(file, (facts, _, _))| ReadModule {
                    file: &file.file,
                    first_write: facts.first_write.as_ref(),
                })
                .collect();
            let reads = observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::scope_reads_of,
                &shape.allowance,
                &input.scope,
                &modules
            );
            let loaded = input.files.iter().map(|file| file.file.clone()).collect();
            let unknown = observe!(
                calls,
                demlik_code_graph::boundaries::zones::reads::unknown_driven,
                &shape.allowance,
                &input.scope,
                &loaded
            );
            let verdicts = held
                .iter()
                .map(|(_, edges, runtime)| {
                    verdicts(
                        reads.as_ref(),
                        ReadImports {
                            import_edges: edges,
                            runtime_specifiers: runtime,
                        },
                        &libraries,
                        &input.targets,
                        calls,
                    )
                })
                .collect::<Vec<_>>();
            #[derive(Serialize)]
            struct Output<'a> {
                shape: Prepared<'a>,
                unknown: Vec<&'a JsString>,
                facts: Vec<&'a ShapeFacts>,
                reads: Option<Scoped<'a>>,
                verdicts: Vec<Vec<DrivenVerdict<'a>>>,
            }
            json(&Output {
                shape: prepared(&shape, &input.probes),
                unknown,
                facts: held.iter().map(|(facts, _, _)| facts).collect(),
                reads: reads.as_ref().map(scoped),
                verdicts,
            })
        }
        _ => Err("unsupported operation".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let mut calls = Vec::new();
        let mut id = None;
        let line = line?;
        let result = (|| {
            let request: Request =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            id = Some(request.id.clone());
            execute(&request, &mut calls)
        })();
        #[derive(Serialize)]
        struct DriverError<'a> {
            tag: &'static str,
            message: &'a str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply<'a> {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<DriverError<'a>>,
            observed_calls: &'a [&'static str],
        }
        let (result, error) = match result {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        };
        let reply = Reply {
            id,
            ok: error.is_none(),
            output: result,
            error: error.as_deref().map(|message| DriverError {
                tag: "driver-error",
                message,
            }),
            observed_calls: &calls,
        };
        println!("{}", serde_json::to_string(&reply)?);
    }
    Ok(())
}
