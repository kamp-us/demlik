use demlik_code_graph::{
    boundaries::{
        analyze::{BoundaryModule, ScopeInputs},
        deployables::{BindingOwners, BindingSite, DeployableFile, DeployablesRead},
        impure_uses::ImpureUse,
        libraries::LibrariesRead,
        shape::{ShapeFacts, ShapeRead},
        violation::BoundaryViolation,
    },
    project::Collation,
    syntax::imports::{ImportEdge, ImportedNames},
    text::{JsString, JsValue},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
    sync::Arc,
};
macro_rules! observe{($calls:expr,$f:path $(,$arg:expr)* $(,)?)=>{{let value=$f($($arg),*);$calls.push(stringify!($f));value}};}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    mode: String,
    root: PathBuf,
    #[serde(default)]
    source: String,
    #[serde(default)]
    rules: Option<Box<RawValue>>,
    #[serde(default)]
    scope: JsString,
    #[serde(default)]
    modules: Vec<ModuleInput>,
    #[serde(default)]
    binding_names: Vec<JsString>,
    #[serde(default)]
    owners: IndexMap<JsString, Vec<JsString>>,
    #[serde(default)]
    driven: bool,
    #[serde(default)]
    is_main: bool,
    #[serde(default)]
    roots: Vec<JsString>,
    #[serde(default)]
    flags: Flags,
    #[serde(default)]
    under: String,
    #[serde(default)]
    pretty: bool,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Flags {
    #[serde(default)]
    ci: bool,
    #[serde(default)]
    write_ceilings: bool,
    #[serde(default)]
    accept_crossings: bool,
    #[serde(default)]
    reason: Option<JsString>,
    #[serde(default)]
    migrate_ceilings: bool,
}
#[derive(Serialize)]
struct Failure {
    name: &'static str,
    message: JsString,
}
impl Failure {
    fn error(error: impl std::fmt::Display) -> Self {
        Self {
            name: "Error",
            message: error.to_string().into(),
        }
    }
}
fn json(v: &impl Serialize) -> Result<Box<RawValue>, Failure> {
    serde_json::value::to_raw_value(v).map_err(Failure::error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteInput {
    binding: JsString,
    line: JsValue,
}
impl SiteInput {
    fn into_site(self) -> Result<BindingSite, String> {
        Ok(BindingSite {
            binding: self.binding,
            line: self.line.as_number().ok_or("site line must be a number")?,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NamesInput {
    names: IndexSet<JsString>,
    unreadable: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleInput {
    file: JsString,
    import_edges: Vec<ImportEdge>,
    offending_form: Box<RawValue>,
    first_write: Box<RawValue>,
    imported_names: IndexMap<JsString, NamesInput>,
    impure_uses: Vec<ImpureUse>,
    runtime_specifiers: IndexSet<JsString>,
    binding_sites: Vec<SiteInput>,
}
struct ModuleFacts {
    file: JsString,
    import_edges: Vec<ImportEdge>,
    shape: ShapeFacts,
    imported_names: IndexMap<JsString, ImportedNames>,
    impure_uses: Vec<ImpureUse>,
    runtime_specifiers: IndexSet<JsString>,
    binding_sites: Vec<BindingSite>,
}
impl ModuleFacts {
    fn from_input(input: ModuleInput) -> Result<Self, String> {
        let offending_form =
            serde_json::from_str(input.offending_form.get()).map_err(|error| error.to_string())?;
        let first_write: Option<SiteInput> =
            serde_json::from_str(input.first_write.get()).map_err(|error| error.to_string())?;
        Ok(Self {
            file: input.file,
            import_edges: input.import_edges,
            shape: ShapeFacts {
                offending_form,
                first_write: first_write.map(SiteInput::into_site).transpose()?,
            },
            imported_names: input
                .imported_names
                .into_iter()
                .map(|(key, value)| {
                    (
                        key,
                        ImportedNames {
                            names: value.names,
                            unreadable: value.unreadable,
                        },
                    )
                })
                .collect(),
            impure_uses: input.impure_uses,
            runtime_specifiers: input.runtime_specifiers,
            binding_sites: input
                .binding_sites
                .into_iter()
                .map(SiteInput::into_site)
                .collect::<Result<_, _>>()?,
        })
    }
    fn borrowed(&self) -> BoundaryModule<'_> {
        BoundaryModule {
            file: &self.file,
            import_edges: &self.import_edges,
            shape: &self.shape,
            imported_names: &self.imported_names,
            impure_uses: &self.impure_uses,
            runtime_specifiers: &self.runtime_specifiers,
            binding_sites: &self.binding_sites,
        }
    }
}

fn execute(input: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, Failure> {
    let c = Collation::try_node22_en_us().map_err(Failure::error)?;
    if input.mode == "gate" {
        use demlik_code_graph::boundaries::gate::{BoundaryFlags, BoundaryGateArgs};
        return json(
            &observe!(
                calls,
                demlik_code_graph::boundaries::gate::run_boundary_gate,
                BoundaryGateArgs {
                    root_absolute: &input.root.join(&input.under),
                    repo_root: &input.root,
                    boundary_rules_file: Some(&JsString::from(
                        input.root.join("rules.json").to_string_lossy().as_ref()
                    )),
                    flags: BoundaryFlags {
                        ci: input.flags.ci,
                        write_ceilings: input.flags.write_ceilings,
                        accept_crossings: input.flags.accept_crossings,
                        reason: input.flags.reason.as_ref(),
                        migrate_ceilings: input.flags.migrate_ceilings
                    },
                    json: true,
                    pretty: input.pretty
                },
                &c
            )
            .map_err(|e| Failure {
                name: e.name(),
                message: e.message(),
            })?,
        );
    }
    if input.mode == "impure" {
        let syntax = demlik_code_graph::engine::oxc::parse_type_script(
            Path::new("fixture.ts"),
            &input.source,
        )
        .map_err(Failure::error)?;
        return json(
            &observe!(
                calls,
                demlik_code_graph::boundaries::impure_uses::detect_impure_uses,
                &syntax,
                &c
            )
            .map_err(Failure::error)?,
        );
    }
    if input.mode == "bindings" {
        let sites: Vec<_> = input
            .binding_names
            .into_iter()
            .enumerate()
            .map(|(i, binding)| BindingSite {
                binding,
                line: (i + 1) as f64,
            })
            .collect();
        let scope = "services/api".into();
        let file = "src/ok.ts".into();
        let from = "services/api/src/ok.ts".into();
        return json(
            &observe!(
                calls,
                demlik_code_graph::boundaries::deployables::bindings::binding_violations,
                &DeployableFile {
                    scope: &scope,
                    file: &file,
                    from: &from,
                    import_edges: &[],
                    binding_sites: &sites,
                    driven: input.driven,
                    is_main: input.is_main,
                    owners: BindingOwners::Record(&input.owners)
                },
                &c
            )
            .map_err(|e| Failure {
                name: e.name(),
                message: e.message(),
            })?,
        );
    }
    let catalog = observe!(
        calls,
        demlik_code_graph::extract::wrangler_config::load_binding_catalog,
        &input.root,
        None,
        &c
    )
    .map_err(Failure::error)?;
    if input.mode == "worker" {
        let graph = observe!(
            calls,
            demlik_code_graph::boundaries::deployables::cycles::worker_graph,
            &catalog,
            &c
        )
        .map_err(Failure::error)?;
        let cycles = observe!(
            calls,
            demlik_code_graph::boundaries::deployables::cycles::worker_cycles,
            &graph,
            &c
        )
        .map_err(Failure::error)?;
        #[derive(Serialize)]
        struct Out<'a> {
            graph: &'a demlik_code_graph::boundaries::deployables::cycles::WorkerGraph,
            cycles: Vec<BoundaryViolation>,
        }
        return json(&Out {
            graph: &graph,
            cycles,
        });
    }
    let raw = input
        .rules
        .ok_or_else(|| Failure::error("rules required"))?;
    let value = JsValue::parse(raw.get()).map_err(Failure::error)?;
    let rules = observe!(
        calls,
        demlik_code_graph::boundaries::rules::BoundaryRules::parse,
        &value
    )
    .map_err(Failure::error)?;
    if input.mode == "read" {
        let read = observe!(
            calls,
            demlik_code_graph::boundaries::deployables::read_deployables,
            &rules,
            &input.root,
            None,
            &catalog,
            &c
        )
        .map_err(Failure::error)?;
        return read_view(&read);
    }
    let libraries = match observe!(
        calls,
        demlik_code_graph::boundaries::libraries::read_libraries,
        &rules,
        &input.root,
        None,
        &c
    )
    .map_err(Failure::error)?
    {
        LibrariesRead::Read(x) => x,
        LibrariesRead::Refused { message } => return refused("libraries", message),
    };
    if input.mode == "libraries" {
        #[derive(Serialize)]
        struct Root {
            root: JsString,
            undeclared: Vec<String>,
            violations: Vec<BoundaryViolation>,
        }
        let roots = input
            .roots
            .into_iter()
            .map(|root| {
                let undeclared = observe!(
                    calls,
                    demlik_code_graph::boundaries::libraries::undeclared_under,
                    &libraries,
                    &root,
                    &c
                )
                .map_err(Failure::error)?;
                let violations = observe!(
                    calls,
                    demlik_code_graph::boundaries::libraries::violations::undeclared_libraries,
                    &libraries,
                    &root,
                    &c
                )
                .map_err(Failure::error)?;
                Ok(Root {
                    root,
                    undeclared,
                    violations,
                })
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a> {
            kind: &'static str,
            dirs: &'a [String],
            package_dirs: &'a [String],
            roots: Vec<Root>,
        }
        return json(&Out {
            kind: "read",
            dirs: &libraries.dirs,
            package_dirs: &libraries.package_dirs,
            roots,
        });
    }
    if input.mode != "analyze" {
        return Err(Failure::error("unknown mode"));
    }
    let deployables = match observe!(
        calls,
        demlik_code_graph::boundaries::deployables::read_deployables,
        &rules,
        &input.root,
        None,
        &catalog,
        &c
    )
    .map_err(Failure::error)?
    {
        DeployablesRead::Read(x) => x,
        DeployablesRead::Refused { message } => return refused("deployables", message),
    };
    let shape = match observe!(
        calls,
        demlik_code_graph::boundaries::shape::read_shape,
        &rules,
        &catalog
    )
    .map_err(Failure::error)?
    {
        ShapeRead::Read(x) => x,
        ShapeRead::Refused { message } => return refused("shape", message),
    };
    let facts = input
        .modules
        .into_iter()
        .map(ModuleFacts::from_input)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Failure::error)?;
    let modules: Vec<_> = facts.iter().map(ModuleFacts::borrowed).collect();
    let analysis = observe!(
        calls,
        demlik_code_graph::boundaries::analyze::analyze_boundaries,
        &input.scope,
        &modules,
        &rules,
        ScopeInputs {
            libraries: &libraries,
            deployables: &deployables,
            shape: &shape
        },
        &c
    )
    .map_err(Failure::error)?;
    let writes: Vec<_> = analysis
        .report
        .violations
        .iter()
        .filter_map(|v| match v {
            BoundaryViolation::DrivingReachesDriven { write: Some(w), .. } => Some(w),
            _ => None,
        })
        .collect();
    let shared_write_identity =
        (writes.len() >= 2).then(|| writes.iter().all(|w| Arc::ptr_eq(w, writes[0])));
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out<'a> {
        report: &'a demlik_code_graph::boundaries::violation::ScopeBoundaryReport,
        unjudged: usize,
        sites: &'a [demlik_code_graph::boundaries::deployables::census::SiteRow],
        shared_write_identity: Option<bool>,
    }
    json(&Out {
        report: &analysis.report,
        unjudged: analysis.unjudged,
        sites: &analysis.sites,
        shared_write_identity,
    })
}
fn refused(phase: &'static str, message: JsString) -> Result<Box<RawValue>, Failure> {
    #[derive(Serialize)]
    struct Out {
        kind: &'static str,
        phase: &'static str,
        message: JsString,
    }
    json(&Out {
        kind: "refused",
        phase,
        message,
    })
}
fn read_view(read: &DeployablesRead<'_>) -> Result<Box<RawValue>, Failure> {
    match read {
        DeployablesRead::Refused { message } => {
            #[derive(Serialize)]
            struct Out<'a> {
                kind: &'static str,
                message: &'a JsString,
            }
            json(&Out {
                kind: "refused",
                message,
            })
        }
        DeployablesRead::Read(d) => {
            #[derive(Serialize)]
            struct Out<'a> {
                kind: &'static str,
                kinds: &'a IndexSet<demlik_code_graph::boundaries::rules::DeployableKind>,
                catalog: &'a demlik_code_graph::extract::wrangler_config::BindingCatalog,
                graph: &'a demlik_code_graph::boundaries::deployables::cycles::WorkerGraph,
                workspaces: &'a IndexSet<JsString>,
                judged: Vec<(
                    &'a demlik_code_graph::extract::wrangler_config::ServiceManifest,
                    Vec<(
                        &'a JsString,
                        &'a demlik_code_graph::boundaries::deployables::JudgedBinding,
                    )>,
                )>,
            }
            json(&Out {
                kind: "read",
                kinds: &d.kinds,
                catalog: d.catalog,
                graph: &d.graph,
                workspaces: &d.workspaces,
                judged: d.judged().map(|(m, b)| (m, b.iter().collect())).collect(),
            })
        }
    }
}
fn main() -> io::Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = Vec::new();
        let mut id = None;
        let result = match serde_json::from_str::<Request>(&line) {
            Ok(input) => {
                id = Some(input.id.clone());
                execute(input, &mut calls)
            }
            Err(e) => Err(Failure {
                name: "ProtocolError",
                message: e.to_string().into(),
            }),
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<Failure>,
            observed_calls: Vec<&'static str>,
        }
        let (output, error) = match result {
            Ok(x) => (Some(x), None),
            Err(e) => (None, Some(e)),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok: error.is_none(),
                output,
                error,
                observed_calls: calls
            })
            .expect("response JSON")
        );
    }
    Ok(())
}
