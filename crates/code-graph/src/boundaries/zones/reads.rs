use crate::{
    boundaries::{
        deployables::BindingSite,
        libraries::{ImportTarget, Libraries, import_target_of},
        rules::{ReadAllowance as DeclaredAllowance, in_scope},
        violation::WriteSite,
    },
    data::{access::access_of, extract::binding_sites},
    extract::{cross_runtime::owner_of_text, wrangler_config::BindingCatalog},
    schema::DataAccess,
    syntax::{file::SyntaxFile, imports::ImportEdge},
    text::{JsString, object_keys},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Serialize, Serializer, ser::SerializeStruct};
use std::cell::OnceCell;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeAllowance {
    pub driven: IndexSet<JsString>,
    pub decided_by: Option<IndexSet<JsString>>,
}
#[derive(Debug)]
pub struct ReadAllowance<'a> {
    pub scopes: IndexMap<JsString, ScopeAllowance>,
    pub catalog: &'a BindingCatalog,
}
pub fn read_allowance_of<'a>(
    declared: &IndexMap<JsString, DeclaredAllowance>,
    catalog: &'a BindingCatalog,
) -> ReadAllowance<'a> {
    ReadAllowance {
        scopes: object_keys(declared)
            .into_iter()
            .map(|scope| {
                let entry = &declared[scope];
                (
                    scope.clone(),
                    ScopeAllowance {
                        driven: entry.driven.iter().cloned().collect(),
                        decided_by: entry
                            .decided_by
                            .as_ref()
                            .map(|types| types.iter().cloned().collect()),
                    },
                )
            })
            .collect(),
        catalog,
    }
}
pub fn first_write(
    allowance: &ReadAllowance<'_>,
    scope: &JsString,
    file: &JsString,
    syntax: &SyntaxFile,
) -> Option<BindingSite> {
    if !allowance.scopes.get(scope)?.driven.contains(file) {
        return None;
    }
    let worker = owner_of_text(&allowance.catalog.manifests, &in_scope(scope, file))?;
    if worker.data_bindings.is_empty() {
        return None;
    }
    let bindings = worker
        .data_bindings
        .iter()
        .map(|declaration| (declaration.binding.clone(), declaration))
        .collect();
    binding_sites(syntax, &bindings)
        .into_iter()
        .filter(|site| {
            access_of(site.decl.kind, site.method.as_ref(), site.sql.as_ref()) == DataAccess::Write
        })
        .min_by_key(|site| (site.line, site.column))
        .map(|site| BindingSite {
            binding: site.decl.binding.clone(),
            line: site.line as f64,
        })
}

pub fn unknown_driven<'a>(
    allowance: &'a ReadAllowance<'_>,
    scope: &JsString,
    files: &IndexSet<JsString>,
) -> Vec<&'a JsString> {
    allowance
        .scopes
        .get(scope)
        .into_iter()
        .flat_map(|own| &own.driven)
        .filter(|file| !files.contains(*file))
        .collect()
}

#[derive(Debug)]
pub struct ScopeReads<'a> {
    pub allowance: &'a ScopeAllowance,
    pub writes: IndexMap<JsString, WriteSite>,
}
#[derive(Clone, Copy)]
pub struct ReadModule<'a> {
    pub file: &'a JsString,
    pub first_write: Option<&'a BindingSite>,
}
pub fn scope_reads_of<'a>(
    allowance: &'a ReadAllowance<'_>,
    scope: &JsString,
    modules: &[ReadModule<'_>],
) -> Option<ScopeReads<'a>> {
    let own = allowance.scopes.get(scope)?;
    Some(ScopeReads {
        allowance: own,
        writes: modules
            .iter()
            .filter_map(|module| {
                module.first_write.map(|write| {
                    (
                        module.file.clone(),
                        WriteSite {
                            file: in_scope(scope, module.file),
                            binding: write.binding.clone(),
                            line: write.line,
                        },
                    )
                })
            })
            .collect(),
    })
}

#[derive(Debug, Clone, Copy)]
pub enum DrivenVerdict<'a> {
    Licensed,
    Unlicensed,
    Write(&'a WriteSite),
}
impl Serialize for DrivenVerdict<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = serializer.serialize_struct(
            "DrivenVerdict",
            if matches!(self, Self::Write(_)) { 2 } else { 1 },
        )?;
        object.serialize_field("licensed", &matches!(self, Self::Licensed))?;
        if let Self::Write(write) = self {
            object.serialize_field("write", write)?;
        }
        object.end()
    }
}
#[derive(Clone, Copy)]
pub struct ReadImports<'a> {
    pub import_edges: &'a [ImportEdge],
    pub runtime_specifiers: &'a IndexSet<JsString>,
}
fn decides(module: ReadImports<'_>, libraries: &Libraries<'_>, types: &IndexSet<JsString>) -> bool {
    module.import_edges.iter().any(|edge| {
        module.runtime_specifiers.contains(&edge.specifier)
            && matches!(
                import_target_of(libraries, &edge.specifier),
                ImportTarget::Library { type_name, .. } if types.contains(type_name)
            )
    })
}
pub struct DrivenReads<'a> {
    reads: Option<&'a ScopeReads<'a>>,
    module: ReadImports<'a>,
    libraries: &'a Libraries<'a>,
    decided: OnceCell<bool>,
}
pub fn driven_reads_of<'a>(
    reads: Option<&'a ScopeReads<'a>>,
    module: ReadImports<'a>,
    libraries: &'a Libraries<'a>,
) -> DrivenReads<'a> {
    DrivenReads {
        reads,
        module,
        libraries,
        decided: OnceCell::new(),
    }
}
impl<'a> DrivenReads<'a> {
    pub fn verdict(&self, target: &JsString) -> DrivenVerdict<'a> {
        let Some(reads) = self.reads else {
            return DrivenVerdict::Unlicensed;
        };
        if !reads.allowance.driven.contains(target) {
            return DrivenVerdict::Unlicensed;
        }
        if let Some(write) = reads.writes.get(target) {
            return DrivenVerdict::Write(write);
        }
        let Some(types) = &reads.allowance.decided_by else {
            return DrivenVerdict::Licensed;
        };
        if *self
            .decided
            .get_or_init(|| decides(self.module, self.libraries, types))
        {
            DrivenVerdict::Licensed
        } else {
            DrivenVerdict::Unlicensed
        }
    }
}
