use demlik_code_graph::{
    boundaries::{
        analyze::{BoundaryModule, ScopeInputs, analyze_boundaries},
        deployables::{BindingSite, DeployablesRead, read_deployables},
        impure_uses::ImpureUse,
        libraries::{LibrariesRead, read_libraries},
        rules::BoundaryRules,
        shape::{ShapeFacts, ShapeRead, read_shape},
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    syntax::imports::{ImportEdge, ImportedNames},
    text::{JsString, JsValue},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    path::Path,
    sync::Arc,
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
struct Input {
    repo_root: String,
    scope: JsString,
    rules: Box<RawValue>,
    modules: Vec<ModuleInput>,
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
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
#[derive(Serialize)]
struct Refused {
    kind: &'static str,
    phase: &'static str,
    message: JsString,
}
fn refused(phase: &'static str, message: JsString) -> Result<Box<RawValue>, String> {
    json(&Refused {
        kind: "refused",
        phase,
        message,
    })
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    if request.operation != "code_graph.boundary-analysis" {
        return Err("unsupported operation".into());
    }
    let input: Input =
        serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
    let rules = observe!(
        calls,
        BoundaryRules::parse,
        &JsValue::parse(input.rules.get()).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    let root = Path::new(&input.repo_root);
    let catalog = observe!(calls, load_binding_catalog, root, None, &metadata_collation)
        .map_err(|error| error.to_string())?;
    let libraries = match observe!(
        calls,
        read_libraries,
        &rules,
        root,
        None,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?
    {
        LibrariesRead::Read(value) => value,
        LibrariesRead::Refused { message } => return refused("libraries", message),
    };
    let deployables = match observe!(
        calls,
        read_deployables,
        &rules,
        root,
        None,
        &catalog,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?
    {
        DeployablesRead::Read(value) => value,
        DeployablesRead::Refused { message } => return refused("deployables", message),
    };
    let shape =
        match observe!(calls, read_shape, &rules, &catalog).map_err(|error| error.to_string())? {
            ShapeRead::Read(value) => value,
            ShapeRead::Refused { message } => return refused("shape", message),
        };
    let facts = input
        .modules
        .into_iter()
        .map(ModuleFacts::from_input)
        .collect::<Result<Vec<_>, _>>()?;
    let modules: Vec<_> = facts.iter().map(ModuleFacts::borrowed).collect();
    let analysis = match observe!(
        calls,
        analyze_boundaries,
        &input.scope,
        &modules,
        &rules,
        ScopeInputs {
            libraries: &libraries,
            deployables: &deployables,
            shape: &shape
        },
        &metadata_collation
    ) {
        Ok(analysis) => analysis,
        Err(error) => {
            #[derive(Serialize)]
            struct Thrown {
                kind: &'static str,
                name: &'static str,
                message: JsString,
            }
            return json(&Thrown {
                kind: "thrown",
                name: "TypeError",
                message: error.to_string().into(),
            });
        }
    };
    let mut held = Vec::new();
    let mut write_sharing = Vec::new();
    for violation in &analysis.report.violations {
        if let BoundaryViolation::DrivingReachesDriven { write, .. } = violation {
            let id = write.as_ref().map(|write| {
                if let Some(index) = held.iter().position(|other| Arc::ptr_eq(other, write)) {
                    index
                } else {
                    held.push(Arc::clone(write));
                    held.len() - 1
                }
            });
            write_sharing.push(id);
        }
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Analyzed {
        kind: &'static str,
        analysis: demlik_code_graph::boundaries::analyze::ScopeAnalysis,
        write_sharing: Vec<Option<usize>>,
    }
    json(&Analyzed {
        kind: "analyzed",
        analysis,
        write_sharing,
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = Vec::new();
        let mut id = None;
        let result = (|| {
            let request: Request =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            id = Some(request.id.clone());
            execute(&request, &mut calls)
        })();
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply<'a> {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<String>,
            observed_calls: &'a [&'static str],
        }
        let (output, error) = match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok: error.is_none(),
                output,
                error,
                observed_calls: &calls,
            })?
        );
    }
    Ok(())
}
