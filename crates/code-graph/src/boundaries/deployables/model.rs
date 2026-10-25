use super::cycles::{WorkerGraph, worker_graph};
use crate::{
    boundaries::rules::{BoundaryRules, DeployableKind, declares_deployables},
    extract::{
        cross_runtime::owner_of_text,
        wrangler_config::{BindingCatalog, ServiceManifest},
    },
    project::{RepoListing, discover_package_roots, list_repo},
    schema::{BindingKind, DataBindingKind},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{path::Path, sync::LazyLock};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogKind {
    Service,
    DurableObject,
    Workflow,
    D1,
    Kv,
    R2,
    Queue,
}
impl From<BindingKind> for CatalogKind {
    fn from(kind: BindingKind) -> Self {
        match kind {
            BindingKind::Service => Self::Service,
            BindingKind::DurableObject => Self::DurableObject,
            BindingKind::Workflow => Self::Workflow,
        }
    }
}
impl From<DataBindingKind> for CatalogKind {
    fn from(kind: DataBindingKind) -> Self {
        match kind {
            DataBindingKind::D1 => Self::D1,
            DataBindingKind::DurableObject => Self::DurableObject,
            DataBindingKind::Kv => Self::Kv,
            DataBindingKind::R2 => Self::R2,
            DataBindingKind::Queue => Self::Queue,
        }
    }
}
impl CatalogKind {
    fn judged(self) -> bool {
        match self {
            Self::Service | Self::DurableObject | Self::D1 | Self::Kv | Self::R2 | Self::Queue => {
                true
            }
            Self::Workflow => false,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct JudgedBinding {
    pub kind: CatalogKind,
    pub binding: JsString,
}
pub static NO_CATALOG: BindingCatalog = BindingCatalog {
    manifests: Vec::new(),
    unparsed_configs: Vec::new(),
};
pub static NO_DEPLOYABLES: LazyLock<Deployables<'static>> = LazyLock::new(Deployables::empty);

#[derive(Debug)]
pub struct Deployables<'a> {
    pub kinds: IndexSet<DeployableKind>,
    pub catalog: &'a BindingCatalog,
    pub graph: WorkerGraph,
    pub workspaces: IndexSet<JsString>,
    judged: Vec<IndexMap<JsString, JudgedBinding>>,
}
impl Deployables<'_> {
    pub fn empty() -> Deployables<'static> {
        Deployables {
            kinds: IndexSet::new(),
            catalog: &NO_CATALOG,
            graph: WorkerGraph::default(),
            workspaces: IndexSet::new(),
            judged: Vec::new(),
        }
    }
    pub fn judged_for(
        &self,
        worker: &ServiceManifest,
    ) -> Option<&IndexMap<JsString, JudgedBinding>> {
        let index = self
            .catalog
            .manifests
            .iter()
            .position(|manifest| std::ptr::eq(manifest, worker))?;
        self.judged.get(index)
    }
    pub fn judged(
        &self,
    ) -> impl Iterator<Item = (&ServiceManifest, &IndexMap<JsString, JudgedBinding>)> {
        self.catalog.manifests.iter().zip(self.judged.iter())
    }
}
#[derive(Debug)]
pub enum DeployablesRead<'a> {
    Read(Box<Deployables<'a>>),
    Refused { message: JsString },
}
fn reads_configs(kind: DeployableKind) -> bool {
    match kind {
        DeployableKind::BindingOutsideDrivenAdapter | DeployableKind::WorkerCallCycle => true,
        DeployableKind::RelativeImportCrossesWorkspace => false,
    }
}
fn kind_name(kind: DeployableKind) -> &'static str {
    match kind {
        DeployableKind::BindingOutsideDrivenAdapter => "binding-outside-driven-adapter",
        DeployableKind::WorkerCallCycle => "worker-call-cycle",
        DeployableKind::RelativeImportCrossesWorkspace => "relative-import-crosses-workspace",
    }
}
fn judged_bindings(manifest: &ServiceManifest) -> IndexMap<JsString, JudgedBinding> {
    manifest
        .bindings
        .iter()
        .map(|declaration| (CatalogKind::from(declaration.kind), &declaration.binding))
        .chain(
            manifest
                .data_bindings
                .iter()
                .map(|declaration| (CatalogKind::from(declaration.kind), &declaration.binding)),
        )
        .filter(|(kind, _)| kind.judged())
        .map(|(kind, binding)| {
            (
                binding.clone(),
                JudgedBinding {
                    kind,
                    binding: binding.clone(),
                },
            )
        })
        .collect()
}
pub fn read_deployables<'a>(
    rules: &BoundaryRules,
    repo_root: &Path,
    listing: Option<&RepoListing>,
    catalog: &'a BindingCatalog,
) -> DeployablesRead<'a> {
    if !declares_deployables(rules) {
        return DeployablesRead::Read(Box::new(Deployables::empty()));
    }
    let owned;
    let files = match listing {
        Some(listing) => listing,
        None => {
            owned = list_repo(repo_root);
            &owned
        }
    };
    let kinds: IndexSet<_> = rules.across_deployables.iter().copied().collect();
    let reading: Vec<_> = kinds
        .iter()
        .copied()
        .filter(|kind| reads_configs(*kind))
        .collect();
    if !reading.is_empty() && !catalog.unparsed_configs.is_empty() {
        let names = reading
            .iter()
            .map(|kind| format!("\"{}\"", kind_name(*kind)))
            .collect::<Vec<_>>()
            .join(" and ");
        return DeployablesRead::Refused {message:format!("a wrangler config cannot be parsed: {}. With {names} listed, a worker whose config is not read is never judged: fix the file (JSON with comments, or TOML) and run again.",catalog.unparsed_configs.join(", ")).into()};
    }
    let workspaces = if kinds.contains(&DeployableKind::RelativeImportCrossesWorkspace) {
        (repo_root
            .join("package.json")
            .exists()
            .then_some(JsString::from(".")))
        .into_iter()
        .chain(
            discover_package_roots(repo_root, Some(files))
                .into_iter()
                .filter(|dir| !dir.is_empty())
                .map(JsString::from),
        )
        .collect()
    } else {
        IndexSet::new()
    };
    DeployablesRead::Read(Box::new(Deployables {
        kinds,
        catalog,
        graph: worker_graph(catalog),
        workspaces,
        judged: catalog.manifests.iter().map(judged_bindings).collect(),
    }))
}
pub fn worker_of<'a>(
    deployables: &'a Deployables<'_>,
    file: &JsString,
) -> Option<&'a ServiceManifest> {
    owner_of_text(&deployables.catalog.manifests, file)
}
pub fn is_worker_main(deployables: &Deployables<'_>, file: &JsString) -> bool {
    worker_of(deployables, file).and_then(|worker| worker.main.as_ref()) == Some(file)
}

#[derive(Debug, Clone, Serialize)]
pub struct BindingSite {
    pub binding: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub line: f64,
}
#[derive(Clone, Copy)]
pub enum BindingOwners<'a> {
    Record(&'a IndexMap<JsString, Vec<JsString>>),
    InheritedFunction(&'a JsString),
    ObjectPrototype,
}
static NO_BINDING_OWNERS: LazyLock<IndexMap<JsString, Vec<JsString>>> =
    LazyLock::new(IndexMap::new);
pub fn binding_owners_of<'a>(rules: &'a BoundaryRules, scope: &'a JsString) -> BindingOwners<'a> {
    if let Some(owners) = rules.binding_owners.get(scope) {
        BindingOwners::Record(owners)
    } else if scope == "__proto__" {
        BindingOwners::ObjectPrototype
    } else if crate::text::object_prototype_function_name(scope).is_some() {
        BindingOwners::InheritedFunction(scope)
    } else {
        BindingOwners::Record(&NO_BINDING_OWNERS)
    }
}
impl BindingOwners<'_> {
    pub fn permits(
        self,
        binding: &JsString,
        file: &JsString,
    ) -> Result<bool, DeployableJudgmentError> {
        use crate::text::{has_object_prototype_property, object_prototype_function_name};
        match self {
            Self::Record(owners) => {
                if let Some(files) = owners.get(binding) {
                    Ok(files.contains(file))
                } else if has_object_prototype_property(binding) {
                    Err(DeployableJudgmentError::InheritedOwners)
                } else {
                    Ok(true)
                }
            }
            Self::ObjectPrototype => {
                if binding == "__proto__" {
                    Err(DeployableJudgmentError::NullOwners)
                } else if has_object_prototype_property(binding) {
                    Err(DeployableJudgmentError::InheritedOwners)
                } else {
                    Ok(true)
                }
            }
            Self::InheritedFunction(scope) => {
                if binding == "name" {
                    object_prototype_function_name(scope)
                        .map(|name| name.contains(file))
                        .ok_or(DeployableJudgmentError::InheritedOwners)
                } else if binding == "caller" || binding == "arguments" {
                    Err(DeployableJudgmentError::RestrictedFunctionProperty)
                } else if binding == "length"
                    || binding == "apply"
                    || binding == "bind"
                    || binding == "call"
                    || (binding == "prototype" && scope == "constructor")
                    || has_object_prototype_property(binding)
                {
                    Err(DeployableJudgmentError::InheritedOwners)
                } else {
                    Ok(true)
                }
            }
        }
    }
}
pub struct DeployableFile<'a> {
    pub scope: &'a JsString,
    pub file: &'a JsString,
    pub from: &'a JsString,
    pub import_edges: &'a [crate::syntax::imports::ImportEdge],
    pub binding_sites: &'a [BindingSite],
    pub driven: bool,
    pub is_main: bool,
    pub owners: BindingOwners<'a>,
}
#[derive(Debug, Clone, Copy)]
pub enum DeployableJudgmentError {
    InheritedOwners,
    NullOwners,
    RestrictedFunctionProperty,
}
impl DeployableJudgmentError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InheritedOwners => "owners.includes is not a function",
            Self::NullOwners => "Cannot read properties of null (reading 'includes')",
            Self::RestrictedFunctionProperty => crate::text::RESTRICTED_FUNCTION_PROPERTY_MESSAGE,
        }
    }
}
impl std::fmt::Display for DeployableJudgmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for DeployableJudgmentError {}
