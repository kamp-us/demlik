use super::cross_runtime::{CrossRuntimeResolver, method_ids_of_classes};
use super::functions::DiscoveredFunction;
use super::package_exports::{ExportPatternError, public_export_patterns};
use super::references::{ReferenceResult, resolve_references};
use super::wrangler_config::{BindingCatalog, CatalogError, load_binding_catalog};
use crate::checker::context::TypeContext;
use crate::declarations::uses::DeclarationUseError;
use crate::engine::tsgo::TsgoError;
use crate::kinds::classify::{
    ClassifyContext, CompiledKindRules, classify_function, compile_kind_rules,
};
use crate::kinds::declarations::{
    merge_rule_maps, public_method_rules_by_base_class, sibling_property_rules, type_scope_rules,
};
use crate::kinds::glob::GlobError;
use crate::kinds::rules::NodeKindRules;
use crate::kinds::rules::RuleCompileError;
use crate::project::{Collation, CollationError, CollationInput};
use crate::project::{discover_package_roots, join_path_text, relative_path_text};
use crate::query::{
    clusters::build_cluster_report, interface_width::find_interface_width,
    unguarded::find_unguarded, unreachable::find_unreachable,
};
use crate::schema::FunctionNode;
use crate::schema::{
    BindingCensusRow, BindingKind, CrossRuntimeEdge, CrossRuntimeReport, Graph,
    InterfaceWidthReport, NodeKind, ReachabilityReport,
};
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};
use std::{
    io,
    path::{Path, PathBuf},
};

pub struct AnalysisOptions<'a> {
    pub cross_runtime: bool,
    pub kinds: bool,
    pub reach: bool,
    pub clusters: bool,
    pub interface_width: bool,
    pub kind_rules: &'a NodeKindRules,
    pub repo_root: &'a Path,
}
#[derive(Debug)]
pub enum AnalysisError {
    Collation(CollationError),
    Catalog(CatalogError),
    Compiler(TsgoError),
    Pattern(regress::Error),
    Convention(GlobError),
    WorkingDirectory(io::Error),
    ExportPatterns(ExportPatternError),
}
impl AnalysisError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Collation(_) => "Error",
            Self::Catalog(error) => error.name(),
            Self::Pattern(_)
            | Self::Convention(GlobError::Pattern(_))
            | Self::ExportPatterns(ExportPatternError::Pattern(_)) => "SyntaxError",
            Self::Compiler(_)
            | Self::Convention(GlobError::Syntax(_))
            | Self::WorkingDirectory(_)
            | Self::ExportPatterns(ExportPatternError::WorkingDirectory(_)) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Catalog(error) => error.message(),
            Self::Collation(error) => error.to_string().into(),
            Self::Convention(GlobError::Syntax(message)) => message.clone(),
            Self::Compiler(_)
            | Self::Pattern(_)
            | Self::Convention(GlobError::Pattern(_))
            | Self::WorkingDirectory(_)
            | Self::ExportPatterns(_) => self.to_string().into(),
        }
    }
}
impl std::fmt::Display for AnalysisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(f),
            Self::Catalog(error) => error.fmt(f),
            Self::Compiler(error) => error.fmt(f),
            Self::Pattern(error) => error.fmt(f),
            Self::Convention(error) => error.fmt(f),
            Self::WorkingDirectory(error) => error.fmt(f),
            Self::ExportPatterns(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for AnalysisError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Catalog(error) => error,
            Self::Compiler(error) => error,
            Self::Pattern(error) => error,
            Self::Convention(error) => error,
            Self::WorkingDirectory(error) => error,
            Self::ExportPatterns(error) => error,
        })
    }
}
impl From<TsgoError> for AnalysisError {
    fn from(error: TsgoError) -> Self {
        Self::Compiler(error)
    }
}
impl From<CollationError> for AnalysisError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
impl From<DeclarationUseError> for AnalysisError {
    fn from(error: DeclarationUseError) -> Self {
        match error {
            DeclarationUseError::Compiler(error) => Self::Compiler(error),
            DeclarationUseError::Collation(error) => Self::Collation(error),
        }
    }
}
impl From<super::ResolveError> for AnalysisError {
    fn from(error: super::ResolveError) -> Self {
        match error {
            super::ResolveError::Compiler(e) => Self::Compiler(e),
            super::ResolveError::Collation(e) => Self::Collation(e),
        }
    }
}
impl From<RuleCompileError> for AnalysisError {
    fn from(error: RuleCompileError) -> Self {
        match error {
            RuleCompileError::Regex(error) => Self::Pattern(error),
            RuleCompileError::Collation(error) => Self::Collation(error),
        }
    }
}
impl From<super::conventions::ConventionEntriesError> for AnalysisError {
    fn from(error: super::conventions::ConventionEntriesError) -> Self {
        match error {
            super::conventions::ConventionEntriesError::Pattern(error) => Self::Convention(error),
            super::conventions::ConventionEntriesError::Collation(error) => Self::Collation(error),
        }
    }
}
#[derive(Default)]
pub struct AnalysisPrep {
    pub catalog: Option<BindingCatalog>,
}
pub fn prepare_analysis(
    options: &AnalysisOptions<'_>,
    collation: &Collation,
) -> Result<AnalysisPrep, AnalysisError> {
    Ok(AnalysisPrep {
        catalog: options
            .cross_runtime
            .then(|| load_binding_catalog(options.repo_root, None, collation))
            .transpose()
            .map_err(AnalysisError::Catalog)?,
    })
}

fn binding_key(service: &JsString, binding: &JsString) -> JsString {
    let mut key = service.clone();
    key.push_str("|");
    key.extend(binding);
    key
}
fn binding_census(
    catalog: &BindingCatalog,
    edges: &[CrossRuntimeEdge],
    collation: &Collation,
) -> Result<Vec<BindingCensusRow>, CollationError> {
    let mut counts: IndexMap<JsString, usize> = IndexMap::new();
    for edge in edges {
        *counts
            .entry(binding_key(&edge.owner_service, &edge.binding))
            .or_default() += 1;
    }
    let mut rows = Vec::new();
    for manifest in &catalog.manifests {
        for binding in &manifest.bindings {
            rows.push(BindingCensusRow {
                binding: binding.binding.clone(),
                binding_kind: binding.kind,
                call_sites: counts
                    .get(&binding_key(&manifest.service, &binding.binding))
                    .copied()
                    .unwrap_or(0),
                owner_service: manifest.service.clone(),
                target_class: binding.target_class.clone(),
                target_service: binding.target_service.clone(),
            });
        }
    }
    let mut rows = rows
        .into_iter()
        .map(|row| {
            let service = CollationInput::from_utf16(row.owner_service.units())?;
            let binding = CollationInput::from_utf16(row.binding.units())?;
            let target = CollationInput::from_utf16(row.target_class.units())?;
            Ok((row, service, binding, target))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    rows.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
            .then_with(|| collation.compare(&left.3, &right.3))
    });
    Ok(rows.into_iter().map(|(row, _, _, _)| row).collect())
}
pub struct CompleteInput<'a, 'program, 'channel> {
    pub options: &'a AnalysisOptions<'a>,
    pub prep: &'a AnalysisPrep,
    pub root_absolute: &'a Path,
    pub context: &'a mut TypeContext<'program, 'channel>,
    pub functions: &'a [DiscoveredFunction],
    pub inputs: &'a AnalysisInputs,
    pub resolver: Option<&'a CrossRuntimeResolver<'a>>,
}
pub struct AnalysisBundle {
    cross_runtime: Option<CrossRuntimeReport>,
    compiled: CompiledKindRules,
    classify_context: ClassifyContext,
    references: Option<ReferenceResult>,
    kinds: bool,
    reach: bool,
    clusters: bool,
    interface_width: bool,
    root_absolute: PathBuf,
    repo_root: PathBuf,
    worker_mains: Vec<JsString>,
}
pub fn complete_analysis(
    input: CompleteInput<'_, '_, '_>,
    collation: &Collation,
) -> Result<AnalysisBundle, AnalysisError> {
    let CompleteInput {
        options,
        prep,
        root_absolute,
        context,
        functions,
        inputs,
        resolver,
    } = input;
    let cross_runtime = match (resolver, prep.catalog.as_ref()) {
        (Some(resolver), Some(catalog)) => {
            let edges = resolver.edges(collation)?;
            let census = binding_census(catalog, &edges, collation)?;
            let mut config_files = catalog
                .manifests
                .iter()
                .map(|manifest| {
                    Ok((
                        manifest.config_file.clone(),
                        CollationInput::from_text(&manifest.config_file)?,
                    ))
                })
                .collect::<Result<Vec<_>, CollationError>>()?;
            config_files.sort_by(|left, right| collation.compare(&left.1, &right.1));
            Some(CrossRuntimeReport {
                census,
                config_files: config_files.into_iter().map(|(file, _)| file).collect(),
                edges,
                unparsed_configs: catalog.unparsed_configs.clone(),
            })
        }
        _ => None,
    };
    let compiled = compile_kind_rules(options.kind_rules, collation)?;
    let cross_runtime_targets = cross_runtime
        .iter()
        .flat_map(|report| &report.edges)
        .filter(|edge| edge.binding_kind != BindingKind::Workflow)
        .filter_map(|edge| edge.callee_id.clone())
        .collect();
    let classes = prep
        .catalog
        .iter()
        .flat_map(|catalog| &catalog.manifests)
        .flat_map(|manifest| &manifest.bindings)
        .filter(|binding| binding.kind == BindingKind::DurableObject)
        .map(|binding| binding.target_class.clone())
        .collect();
    let classify_context = ClassifyContext {
        cross_runtime_targets,
        durable_object_methods: method_ids_of_classes(context, &classes)?,
        base_class_entries: public_method_rules_by_base_class(
            context,
            &compiled.entry_base_classes,
        )?,
        declared_guards: merge_rule_maps(
            [
                &sibling_property_rules(context, &compiled.entry_guard_properties, collation)?,
                &type_scope_rules(context, &compiled.entry_guard_properties, collation)?,
            ],
            collation,
        )?,
        convention_entries: if options.kinds {
            super::conventions::convention_entries(
                functions,
                options.kind_rules,
                root_absolute,
                options.repo_root,
                collation,
            )?
        } else {
            IndexMap::new()
        },
    };
    let references = if options.reach || options.interface_width {
        Some(resolve_references(
            context,
            &inputs.names,
            &inputs.exports_by_file,
            collation,
        )?)
    } else {
        None
    };
    let worker_mains = prep
        .catalog
        .iter()
        .flat_map(|catalog| &catalog.manifests)
        .filter_map(|manifest| manifest.main.clone())
        .collect();
    Ok(AnalysisBundle {
        cross_runtime,
        compiled,
        classify_context,
        references,
        kinds: options.kinds,
        reach: options.reach,
        clusters: options.clusters,
        interface_width: options.interface_width,
        root_absolute: root_absolute.into(),
        repo_root: options.repo_root.into(),
        worker_mains,
    })
}
impl AnalysisBundle {
    pub fn apply(self, graph: &mut Graph, collation: &Collation) -> Result<(), AnalysisError> {
        for function in &mut graph.functions {
            function.node_kind = self
                .kinds
                .then(|| {
                    classify_function(function, &self.compiled, &self.classify_context, collation)
                })
                .transpose()?;
        }
        graph.clusters = self
            .clusters
            .then(|| build_cluster_report(&graph.functions, &graph.modules, collation))
            .transpose()?;
        graph.reachability = None;
        graph.interface_width = None;
        if let Some(refs) = &self.references {
            if self.reach {
                let mut mains = IndexSet::new();
                for main in &self.worker_mains {
                    let absolute =
                        join_path_text(&self.repo_root.to_string_lossy().as_ref().into(), main);
                    let relative = relative_path_text(&self.root_absolute, &absolute)
                        .map_err(AnalysisError::WorkingDirectory)?;
                    if let Ok(relative) = relative.to_utf8() {
                        mains.insert(relative);
                    }
                }
                let mut mains = mains
                    .into_iter()
                    .map(|main| {
                        let key = CollationInput::from_text(&main)?;
                        Ok((main, key))
                    })
                    .collect::<Result<Vec<_>, CollationError>>()?;
                mains.sort_by(|left, right| collation.compare(&left.1, &right.1));
                let mains = mains.into_iter().map(|(main, _)| main).collect::<Vec<_>>();
                let patterns = public_export_patterns(
                    &self.repo_root,
                    &self.root_absolute,
                    &discover_package_roots(&self.repo_root, None),
                )
                .map_err(AnalysisError::ExportPatterns)?;
                let found = find_unreachable(
                    &graph.functions,
                    &graph.modules,
                    refs,
                    &mains,
                    &self.compiled.test_support,
                    &patterns,
                    collation,
                )?;
                graph.reachability = Some(ReachabilityReport {
                    entry_count: graph
                        .functions
                        .iter()
                        .filter(|node| matches!(node.node_kind, Some(NodeKind::Entry { .. })))
                        .count(),
                    exported_count: found.exported_count,
                    reachable_count: found.reachable_count,
                    unguarded: find_unguarded(&graph.functions, collation)?,
                    unreachable: found.unreachable,
                    withheld: found.withheld,
                });
            }
            if self.interface_width {
                let packages = find_interface_width(
                    &graph.functions,
                    refs,
                    &discover_package_roots(&self.root_absolute, None),
                    collation,
                )?;
                graph.interface_width = Some(InterfaceWidthReport {
                    total_exports: packages.iter().map(|row| row.export_count).sum(),
                    total_zero_consumer: packages.iter().map(|row| row.zero_consumer_count).sum(),
                    packages,
                });
            }
        }
        graph.cross_runtime = self.cross_runtime;
        Ok(())
    }
}

pub struct NamedSymbol<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub file: &'a str,
    pub is_exported: bool,
}
impl<'a> From<&'a DiscoveredFunction> for NamedSymbol<'a> {
    fn from(node: &'a DiscoveredFunction) -> Self {
        Self {
            id: &node.id,
            name: &node.name,
            file: &node.file,
            is_exported: node.is_exported,
        }
    }
}
impl<'a> From<&'a FunctionNode> for NamedSymbol<'a> {
    fn from(node: &'a FunctionNode) -> Self {
        Self {
            id: &node.id,
            name: &node.name,
            file: &node.file,
            is_exported: node.is_exported,
        }
    }
}
pub struct AnalysisInputs {
    pub names: IndexSet<String>,
    pub exports_by_file: IndexMap<String, Vec<String>>,
}
pub fn analysis_inputs<'a>(
    functions: impl IntoIterator<Item = NamedSymbol<'a>>,
    collation: &Collation,
) -> Result<AnalysisInputs, CollationError> {
    let mut names = IndexSet::new();
    let mut exports_by_file: IndexMap<String, Vec<String>> = IndexMap::new();
    for node in functions {
        names.insert(node.name.into());
        if node.is_exported {
            exports_by_file
                .entry(node.file.into())
                .or_default()
                .push(node.id.into());
        }
    }
    for exports in exports_by_file.values_mut() {
        let mut keyed = std::mem::take(exports)
            .into_iter()
            .map(|id| {
                let key = CollationInput::from_text(&id)?;
                Ok((id, key))
            })
            .collect::<Result<Vec<_>, CollationError>>()?;
        keyed.sort_by(|left, right| collation.compare(&left.1, &right.1));
        *exports = keyed.into_iter().map(|(id, _)| id).collect();
    }
    Ok(AnalysisInputs {
        names,
        exports_by_file,
    })
}
