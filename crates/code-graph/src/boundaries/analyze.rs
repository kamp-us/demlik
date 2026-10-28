use super::{
    deployables::{
        BindingOwners, BindingSite, DeployableFile, DeployableJudgmentError, Deployables,
        binding_owners_of, census::SiteRow, is_worker_main, judge::judge_deployables,
    },
    impure_uses::{ImpureFacts, ImpureUse},
    libraries::{
        Libraries, LibraryRuleError, owner_of,
        violations::{LibraryFile, judge_libraries, undeclared_libraries},
    },
    rules::{
        BoundaryRules, FeatureFile, ImportedFrom, Place, ScopeZoning, ZoneImport, ZoneName,
        ZoningError, in_scope, place_of, scope_zoning,
    },
    shape::{
        Shape, ShapeFacts,
        judge::{ShapeContext, ShapedFile, judge_shape},
    },
    violation::{BoundaryViolation, False, ScopeBoundaryReport},
    zones::{
        impure_violations::{ImpureContext, ImpureFile, impure_violations},
        reads::{
            DrivenReads, DrivenVerdict, ReadImports, ReadModule, ScopeReads, driven_reads_of,
            scope_reads_of,
        },
        test_reach::{OpeningFile, RootReach, root_reach_of, test_reach_violations},
        test_role::{is_test_file, judges_test_files},
    },
};
use crate::{
    project::{Collation, CollationError, CollationInput},
    syntax::imports::{ImportEdge, ImportedNames},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::sync::Arc;

pub struct BoundaryModule<'a> {
    pub file: &'a JsString,
    pub import_edges: &'a [ImportEdge],
    pub shape: &'a ShapeFacts,
    pub imported_names: &'a IndexMap<JsString, ImportedNames>,
    pub impure_uses: &'a [ImpureUse],
    pub runtime_specifiers: &'a IndexSet<JsString>,
    pub binding_sites: &'a [BindingSite],
}
impl<'a> BoundaryModule<'a> {
    fn impure_facts(&self) -> ImpureFacts<'a> {
        ImpureFacts {
            impure_uses: self.impure_uses,
            import_edges: self.import_edges,
            runtime_specifiers: self.runtime_specifiers,
        }
    }
    fn opening(&self) -> OpeningFile<'a> {
        OpeningFile {
            file: self.file,
            import_edges: self.import_edges,
            runtime_specifiers: self.runtime_specifiers,
        }
    }
}
#[derive(Clone, Copy)]
pub struct ScopeInputs<'a> {
    pub libraries: &'a Libraries<'a>,
    pub deployables: &'a Deployables<'a>,
    pub shape: &'a Shape<'a>,
}
#[derive(Debug, Serialize)]
pub struct ScopeAnalysis {
    pub report: ScopeBoundaryReport,
    pub unjudged: usize,
    pub sites: Vec<SiteRow>,
}
#[derive(Debug)]
pub enum AnalysisError {
    Zoning(ZoningError),
    Library(LibraryRuleError),
    Deployable(DeployableJudgmentError),
    Collation(CollationError),
}
impl std::fmt::Display for AnalysisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Zoning(error) => error.fmt(f),
            Self::Library(error) => error.fmt(f),
            Self::Deployable(error) => error.fmt(f),
            Self::Collation(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for AnalysisError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Zoning(error) => error,
            Self::Library(error) => error,
            Self::Deployable(error) => error,
            Self::Collation(error) => error,
        })
    }
}
impl From<CollationError> for AnalysisError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
impl From<ZoningError> for AnalysisError {
    fn from(error: ZoningError) -> Self {
        Self::Zoning(error)
    }
}
impl From<LibraryRuleError> for AnalysisError {
    fn from(error: LibraryRuleError) -> Self {
        Self::Library(error)
    }
}
impl From<DeployableJudgmentError> for AnalysisError {
    fn from(error: DeployableJudgmentError) -> Self {
        match error {
            DeployableJudgmentError::Collation(error) => Self::Collation(error),
            error => Self::Deployable(error),
        }
    }
}
struct ScopeContext<'a> {
    collation: &'a Collation,
    scope: &'a JsString,
    owners: BindingOwners<'a>,
    inputs: ScopeInputs<'a>,
    zoning: &'a ScopeZoning,
    allowance: Option<&'a ScopeReads<'a>>,
    reach: &'a RootReach,
}
struct EdgeContext<'a> {
    scope: &'a JsString,
    from: &'a JsString,
    from_place: &'a Place,
    edge: &'a ImportEdge,
    zoning: &'a ScopeZoning,
    reads: &'a DrivenReads<'a>,
}
fn within_feature(
    ctx: &EdgeContext<'_>,
    from: &FeatureFile,
    target: &JsString,
    to: &FeatureFile,
) -> Option<BoundaryViolation> {
    match from.zone_rule().imports? {
        ZoneImport::ApplicationImportsAdapter => {
            let adapter = match to {
                FeatureFile::PerFeature { zone, .. } => zone.adapter,
                FeatureFile::Port { zone, .. } => zone.adapter,
            };
            adapter.then(|| BoundaryViolation::ApplicationImportsAdapter {
                from: in_scope(ctx.scope, ctx.from),
                feature: from.feature().clone(),
                to: in_scope(ctx.scope, target),
                specifier: ctx.edge.specifier.clone(),
                type_only: ctx.edge.type_only,
            })
        }
        ZoneImport::DrivingReachesDriven => {
            let write = match to.zone_name() {
                ZoneName::Application => None,
                ZoneName::Driven => match ctx.reads.verdict(target) {
                    DrivenVerdict::Licensed => return None,
                    DrivenVerdict::Unlicensed => None,
                    DrivenVerdict::Write(write) => Some(Arc::clone(write)),
                },
                _ => return None,
            };
            Some(BoundaryViolation::DrivingReachesDriven {
                from: in_scope(ctx.scope, ctx.from),
                feature: from.feature().clone(),
                to: in_scope(ctx.scope, target),
                specifier: ctx.edge.specifier.clone(),
                type_only: ctx.edge.type_only,
                write,
            })
        }
    }
}
fn edge_violation(ctx: EdgeContext<'_>) -> Option<BoundaryViolation> {
    let target = JsString::from(ctx.edge.target.as_deref()?);
    let Place::Feature(to) = place_of(&target, ctx.zoning) else {
        return None;
    };
    match ctx.from_place {
        Place::Feature(from) if from.feature() == to.feature() => {
            within_feature(&ctx, from, &target, &to)
        }
        Place::Feature(_) if to.zone_rule().open_to_features => None,
        Place::Feature(from) => Some(BoundaryViolation::CrossFeature {
            from_feature: from.feature().clone(),
            from: in_scope(ctx.scope, ctx.from),
            to: in_scope(ctx.scope, &target),
            to_feature: to.feature().clone(),
            specifier: ctx.edge.specifier.clone(),
            type_only: ctx.edge.type_only,
        }),
        Place::Lib => Some(BoundaryViolation::LibImportsFeature {
            from: in_scope(ctx.scope, ctx.from),
            to: in_scope(ctx.scope, &target),
            to_feature: to.feature().clone(),
            specifier: ctx.edge.specifier.clone(),
            type_only: ctx.edge.type_only,
        }),
        Place::Elsewhere if to.zone_rule().open_to_outside => None,
        Place::Elsewhere => Some(BoundaryViolation::OutsideImportsFeatureInternal {
            from: in_scope(ctx.scope, ctx.from),
            to: in_scope(ctx.scope, &target),
            to_feature: to.feature().clone(),
            specifier: ctx.edge.specifier.clone(),
            type_only: ctx.edge.type_only,
        }),
    }
}
fn unknown_entry(scope: &JsString, place: &Place) -> Option<BoundaryViolation> {
    let Place::Feature(FeatureFile::PerFeature { feature, zone }) = place else {
        return None;
    };
    if zone.name != ZoneName::Unknown {
        return None;
    }
    let mut from = JsString::from("src/");
    from.extend(feature);
    from.push_str("/");
    from.extend(&zone.entry);
    Some(BoundaryViolation::UnknownZone {
        from: in_scope(scope, &from),
        feature: feature.clone(),
        to: (),
        specifier: zone.entry.clone(),
        type_only: False,
    })
}
fn library_zone(place: &Place) -> Option<ImportedFrom> {
    match place {
        Place::Feature(feature) => feature.zone_rule().library_zone,
        Place::Lib | Place::Elsewhere => Some(ImportedFrom::Configurator),
    }
}
fn across_deployables(
    ctx: &ScopeContext<'_>,
    module: &BoundaryModule<'_>,
    place: &Place,
) -> Result<(Vec<BoundaryViolation>, Vec<SiteRow>), DeployableJudgmentError> {
    let deployables = ctx.inputs.deployables;
    if deployables.kinds.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let from = in_scope(ctx.scope, module.file);
    if owner_of(ctx.inputs.libraries, &from).is_some_and(|owner| ctx.scope != owner) {
        return Ok((Vec::new(), Vec::new()));
    }
    let violations = judge_deployables(
        deployables,
        &DeployableFile {
            scope: ctx.scope,
            file: module.file,
            from: &from,
            import_edges: module.import_edges,
            binding_sites: module.binding_sites,
            driven: matches!(place, Place::Feature(feature) if feature.zone_rule().touches_bindings),
            is_main: is_worker_main(deployables, &from),
            owners: ctx.owners,
        },
        ctx.collation,
    )?;
    let sites = module
        .binding_sites
        .iter()
        .map(|site| SiteRow {
            file: from.clone(),
            binding: site.binding.clone(),
            line: site.line,
        })
        .collect();
    Ok((violations, sites))
}
struct Found {
    violations: Vec<BoundaryViolation>,
    unjudged: usize,
    sites: Vec<SiteRow>,
}
fn analyze_module(
    ctx: &ScopeContext<'_>,
    module: &BoundaryModule<'_>,
    place: &Place,
) -> Result<Found, AnalysisError> {
    let reads = driven_reads_of(
        ctx.allowance,
        ReadImports {
            import_edges: module.import_edges,
            runtime_specifiers: module.runtime_specifiers,
        },
        ctx.inputs.libraries,
    );
    let mut judged = Vec::new();
    let mut violations = Vec::new();
    for edge in module.import_edges {
        if let Some(violation) = edge_violation(EdgeContext {
            scope: ctx.scope,
            from: module.file,
            from_place: place,
            edge,
            zoning: ctx.zoning,
            reads: &reads,
        }) {
            judged.push(edge);
            violations.push(violation);
        }
    }
    violations.extend(impure_violations(ImpureContext {
        scope: ctx.scope,
        module: ImpureFile {
            file: module.file,
            facts: module.impure_facts(),
        },
        place,
    }));
    let from = in_scope(ctx.scope, module.file);
    let libs = judge_libraries(
        ctx.inputs.libraries,
        ctx.scope,
        LibraryFile {
            file: &from,
            imported_names: module.imported_names,
            facts: module.impure_facts(),
        },
        library_zone(place),
    )?;
    violations.extend(libs.violations);
    let (across, sites) = across_deployables(ctx, module, place)?;
    violations.extend(across);
    violations.extend(judge_shape(
        ShapeContext {
            scope: ctx.scope,
            shape: ctx.inputs.shape,
            libraries: ctx.inputs.libraries,
            zoning: ctx.zoning,
        },
        ShapedFile {
            file: module.file,
            import_edges: module.import_edges,
            runtime_specifiers: module.runtime_specifiers,
            offending_form: module.shape.offending_form.as_ref(),
        },
        place,
        &judged,
    ));
    if is_test_file(&ctx.inputs.shape.tests, ctx.scope, module.file) {
        violations.extend(test_reach_violations(
            ctx.reach,
            ctx.scope,
            &module.opening(),
        ));
        violations.retain(|violation| judges_test_files(violation.kind()));
    }
    Ok(Found {
        violations,
        unjudged: libs.unjudged,
        sites,
    })
}
pub fn analyze_boundaries(
    scope: &JsString,
    modules: &[BoundaryModule<'_>],
    rules: &BoundaryRules,
    inputs: ScopeInputs<'_>,
    collation: &Collation,
) -> Result<ScopeAnalysis, AnalysisError> {
    let zoning = scope_zoning(rules, scope)?;
    let read_modules: Vec<_> = modules
        .iter()
        .map(|module| ReadModule {
            file: module.file,
            first_write: module.shape.first_write.as_ref(),
        })
        .collect();
    let allowance = scope_reads_of(&inputs.shape.allowance, scope, &read_modules);
    let openings: Vec<_> = modules.iter().map(BoundaryModule::opening).collect();
    let reach = root_reach_of(&inputs.shape.roots, scope, &openings);
    let context = ScopeContext {
        collation,
        scope,
        owners: binding_owners_of(rules, scope),
        inputs,
        zoning: &zoning,
        allowance: allowance.as_ref(),
        reach: &reach,
    };
    let mut violations = Vec::new();
    let mut sites = Vec::new();
    let mut unjudged = 0;
    let mut unknown_entries = IndexMap::new();
    for module in modules {
        let place = place_of(module.file, &zoning);
        if !is_test_file(&inputs.shape.tests, scope, module.file)
            && let Some(unknown) = unknown_entry(scope, &place)
        {
            unknown_entries.insert(unknown.from_file().clone(), unknown);
        }
        let found = analyze_module(&context, module, &place)?;
        violations.extend(found.violations);
        sites.extend(found.sites);
        unjudged += found.unjudged;
    }
    violations.extend(unknown_entries.into_values());
    violations.extend(undeclared_libraries(inputs.libraries, scope, collation)?);
    let mut violations = violations
        .into_iter()
        .map(|row| {
            let kind = CollationInput::from_text(row.kind().as_str())?;
            let from = CollationInput::from_utf16(row.from_file().units())?;
            let specifier = CollationInput::from_utf16(row.specifier().units())?;
            Ok((row, kind, from, specifier))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    violations.sort_by(|a, b| {
        collation
            .compare(&a.1, &b.1)
            .then_with(|| collation.compare(&a.2, &b.2))
            .then_with(|| collation.compare(&a.3, &b.3))
    });
    let violations = violations.into_iter().map(|(row, _, _, _)| row).collect();
    let mut features = zoning
        .features
        .into_iter()
        .map(|name| CollationInput::from_utf16(name.units()).map(|key| (name, key)))
        .collect::<Result<Vec<_>, _>>()?;
    features.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let features = features.into_iter().map(|(name, _)| name).collect();
    Ok(ScopeAnalysis {
        report: ScopeBoundaryReport {
            scope: scope.clone(),
            features,
            files_scanned: modules.len() as f64,
            violations,
            workers: None,
        },
        unjudged,
        sites,
    })
}
