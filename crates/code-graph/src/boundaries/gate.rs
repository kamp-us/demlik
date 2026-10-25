use super::{
    analyze::{BoundaryModule, ScopeAnalysis, ScopeInputs, analyze_boundaries},
    config::{BoundaryConfigError, BoundaryConfigResolution, resolve_boundary_rules},
    deployables::{
        BindingOwners, BindingSite, Deployables, DeployablesRead, NO_CATALOG, binding_owners_of,
        bindings::{binding_owner_issue, binding_sites_of},
        census::{SiteRow, deployable_census},
        cycles::worker_cycles,
        read_deployables,
    },
    impure_uses::{ImpureUse, detect_impure_uses},
    ledger::{
        BoundaryLedger, LEDGER_FILENAME, LedgerRead, read_boundary_ledger, write_boundary_ledger,
    },
    libraries::{
        Libraries, LibrariesRead,
        allowance::{NamedFile, allowance_issue, imported_names_for},
        census::{MeasuredLibraries, library_census},
        library_scopes, read_libraries,
    },
    migrate::{LEGACY_CEILINGS_FILENAME, Migration, migrated_ledger},
    reconcile::{reconcile, with_accepted},
    render::{
        Censuses, render_accepted, render_boundaries, render_ledger_gate, render_migrated,
        render_migration_refused,
    },
    rules::{
        BoundaryRules, DeployableKind, declares_deployables, declares_libraries,
        declares_read_allowance, feature_folders_of, in_scope, interpolate,
    },
    shape::{Shape, ShapeFacts, ShapeRead, read_shape, shape_facts_of},
    violation::{BoundaryViolation, ScopeBoundaryReport},
    zones::reads::unknown_driven,
};
use crate::{
    extract::wrangler_config::{BindingCatalog, CatalogError, load_binding_catalog},
    kinds::glob::GlobError,
    project::{EdgeScope, RepoListing, join_path_text, list_repo, load_edge_project_text},
    ratchet::scope_count::{ScopeCeilingsResolution, read_scope_ceilings, scope_of, scopes_under},
    syntax::imports::{ImportedNames, resolve_imports, runtime_specifiers},
    text::{JsString, object_keys},
    validation::RecordTypeError,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, Default)]
pub struct BoundaryFlags<'a> {
    pub ci: bool,
    pub write_ceilings: bool,
    pub accept_crossings: bool,
    pub reason: Option<&'a JsString>,
    pub migrate_ceilings: bool,
}
#[derive(Debug, Clone, Copy)]
pub struct BoundaryGateArgs<'a> {
    pub root_absolute: &'a Path,
    pub repo_root: &'a Path,
    pub boundary_rules_file: Option<&'a JsString>,
    pub flags: BoundaryFlags<'a>,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryGateResult {
    pub exit_code: u8,
    pub emitted: Vec<JsString>,
    pub reports: Vec<JsString>,
}
#[derive(Debug)]
pub enum BoundaryGateError {
    Config(BoundaryConfigError),
    Pattern(GlobError),
    Catalog(CatalogError),
    Io(io::Error),
    Ceiling(RecordTypeError),
    Render(serde_json::Error),
}
impl std::fmt::Display for BoundaryGateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(error) => error.fmt(f),
            Self::Pattern(error) => error.fmt(f),
            Self::Catalog(error) => error.fmt(f),
            Self::Io(error) => error.fmt(f),
            Self::Ceiling(error) => error.fmt(f),
            Self::Render(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for BoundaryGateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Config(error) => error,
            Self::Pattern(error) => error,
            Self::Catalog(error) => error,
            Self::Io(error) => error,
            Self::Ceiling(error) => error,
            Self::Render(error) => error,
        })
    }
}
type Result<T> = std::result::Result<T, BoundaryGateError>;
enum Mode {
    Report,
    Gate,
    Accept { reason: JsString },
    Migrate,
}
fn trimmed_reason(reason: &JsString) -> JsString {
    let whitespace = |unit: &u16| matches!(*unit, 9..=13 | 32 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let units = reason.units();
    let start = units
        .iter()
        .position(|unit| !whitespace(unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !whitespace(unit))
        .map_or(start, |index| index + 1);
    JsString::from_units(units[start..end].to_vec())
}
fn mode_of(flags: BoundaryFlags<'_>) -> std::result::Result<Mode, JsString> {
    if flags.write_ceilings {
        return Err(format!("`--boundaries --write-ceilings` is retired: crossings live one per entry in {LEDGER_FILENAME}. Add the current ones with `--boundaries --accept-crossings --reason \"<why>\"`.").into());
    }
    if [flags.ci, flags.accept_crossings, flags.migrate_ceilings]
        .into_iter()
        .filter(|picked| *picked)
        .count()
        > 1
    {
        return Err(
            "pass one of --ci, --accept-crossings, --migrate-ceilings with --boundaries.".into(),
        );
    }
    if flags.reason.is_some() && !flags.accept_crossings {
        return Err("--reason only rides `--boundaries --accept-crossings`.".into());
    }
    if flags.accept_crossings {
        let reason = flags.reason.map(trimmed_reason).unwrap_or_default();
        if reason.is_empty() {
            return Err(
                "`--accept-crossings` needs a non-empty `--reason \"<why>\"`; nothing was written."
                    .into(),
            );
        }
        return Ok(Mode::Accept { reason });
    }
    Ok(if flags.migrate_ceilings {
        Mode::Migrate
    } else if flags.ci {
        Mode::Gate
    } else {
        Mode::Report
    })
}
fn refused(message: JsString) -> BoundaryGateResult {
    BoundaryGateResult {
        exit_code: 2,
        reports: vec![message],
        ..Default::default()
    }
}
fn emitted(mut payload: JsString, exit_code: u8) -> BoundaryGateResult {
    payload.push_str("\n");
    BoundaryGateResult {
        exit_code,
        emitted: vec![payload],
        reports: Vec::new(),
    }
}
struct Reads<'a> {
    libraries: Libraries<'a>,
    deployables: Box<Deployables<'a>>,
    shape: Box<Shape<'a>>,
}
impl Reads<'_> {
    fn inputs(&self) -> ScopeInputs<'_> {
        ScopeInputs {
            libraries: &self.libraries,
            deployables: &self.deployables,
            shape: &self.shape,
        }
    }
}
fn read_run<'a>(
    rules: &'a BoundaryRules,
    args: BoundaryGateArgs<'_>,
    listing: Option<&RepoListing>,
    catalog: &'a BindingCatalog,
) -> Result<std::result::Result<Reads<'a>, JsString>> {
    let libraries =
        match read_libraries(rules, args.repo_root, listing).map_err(BoundaryGateError::Pattern)? {
            LibrariesRead::Read(libraries) => libraries,
            LibrariesRead::Refused { message } => return Ok(Err(message)),
        };
    let deployables = match read_deployables(rules, args.repo_root, listing, catalog) {
        DeployablesRead::Read(deployables) => deployables,
        DeployablesRead::Refused { message } => return Ok(Err(message)),
    };
    let shape = match read_shape(rules, catalog).map_err(BoundaryGateError::Pattern)? {
        ShapeRead::Read(shape) => shape,
        ShapeRead::Refused { message } => return Ok(Err(message)),
    };
    Ok(Ok(Reads {
        libraries,
        deployables,
        shape,
    }))
}
fn scope_root(repo_root: &Path, scope: &JsString) -> JsString {
    join_path_text(&repo_root.to_string_lossy().as_ref().into(), scope)
}
fn src_entries(scope: &JsString, repo_root: &Path) -> Vec<JsString> {
    let native = PathBuf::from(scope_root(repo_root, scope).to_lossy());
    let Ok(entries) = fs::read_dir(native.join("src")) else {
        return Vec::new();
    };
    let mut names: Vec<_> = entries
        .map(|entry| {
            entry.map(|entry| JsString::from(entry.file_name().to_string_lossy().as_ref()))
        })
        .collect::<io::Result<_>>()
        .unwrap_or_default();
    names.sort();
    names
}
struct ModuleFacts {
    file: JsString,
    shape: ShapeFacts,
    imported_names: IndexMap<JsString, ImportedNames>,
    impure_uses: Vec<ImpureUse>,
    runtime_specifiers: IndexSet<JsString>,
    binding_sites: Vec<BindingSite>,
}
fn analyze_scope(
    scope: &JsString,
    rules: &BoundaryRules,
    reads: &Reads<'_>,
    listing: Option<&RepoListing>,
    args: BoundaryGateArgs<'_>,
) -> std::result::Result<ScopeAnalysis, JsString> {
    let folders = feature_folders_of(rules, scope);
    if folders.is_defined()
        && let Some(message) = folders
            .unlisted_port_folder_issue(scope, &src_entries(scope, args.repo_root))
            .map_err(|error| JsString::from(error.to_string()))?
    {
        return Err(message);
    }
    let reads_files = folders.is_defined()
        || scope
            .to_utf8()
            .ok()
            .is_some_and(|scope| reads.libraries.type_of_dir.contains_key(&scope));
    let loaded = if reads_files {
        Some(
            load_edge_project_text(
                &scope_root(args.repo_root, scope),
                EdgeScope::Package,
                args.repo_root,
                listing,
            )
            .map_err(|error| error.message())?,
        )
    } else {
        None
    };
    let graph = loaded.as_ref().map(|loaded| {
        resolve_imports(
            &loaded.project.root_absolute,
            &loaded.project.source_files,
            &loaded.ts_config_path,
        )
    });
    let facts: Vec<_> = loaded
        .as_ref()
        .into_iter()
        .flat_map(|loaded| &loaded.project.source_files)
        .map(|unit| {
            let file = JsString::from(unit.file.as_str());
            ModuleFacts {
                shape: shape_facts_of(&reads.shape, scope, &file, &unit.syntax),
                imported_names: imported_names_for(&reads.libraries, scope, &unit.syntax),
                impure_uses: detect_impure_uses(&unit.syntax),
                runtime_specifiers: runtime_specifiers(&unit.syntax),
                binding_sites: binding_sites_of(
                    &reads.deployables,
                    &in_scope(scope, &file),
                    &unit.syntax,
                ),
                file,
            }
        })
        .collect();
    let modules: Vec<_> = facts
        .iter()
        .zip(
            loaded
                .as_ref()
                .into_iter()
                .flat_map(|loaded| &loaded.project.source_files),
        )
        .map(|(facts, unit)| BoundaryModule {
            file: &facts.file,
            import_edges: graph
                .as_ref()
                .and_then(|graph| graph.import_edges_by_file.get(&unit.file))
                .map_or(&[], Vec::as_slice),
            shape: &facts.shape,
            imported_names: &facts.imported_names,
            impure_uses: &facts.impure_uses,
            runtime_specifiers: &facts.runtime_specifiers,
            binding_sites: &facts.binding_sites,
        })
        .collect();
    let files = modules.iter().map(|module| module.file.clone()).collect();
    if let BindingOwners::Record(owners) = binding_owners_of(rules, scope)
        && let Some(message) = binding_owner_issue(scope, owners, &files, &reads.deployables)
    {
        return Err(message);
    }
    let named: Vec<_> = modules
        .iter()
        .map(|module| NamedFile {
            file: module.file,
            imported_names: module.imported_names,
        })
        .collect();
    if let Some(message) = allowance_issue(&reads.libraries, scope, &named) {
        return Err(message);
    }
    let unread = unknown_driven(&reads.shape.allowance, scope, &files);
    if !unread.is_empty() {
        return Err(interpolate(&[
            "driven file(s) of \"readAllowance\" in \"".into(),
            scope.clone(),
            "\" name no file the scope loads: ".into(),
            super::rules::join(&unread, "; "),
            ". A listed file is an exact scope-relative .ts/.tsx path.".into(),
        ]));
    }
    analyze_boundaries(scope, &modules, rules, reads.inputs())
        .map_err(|error| error.to_string().into())
}
struct Analysis {
    reports: Vec<ScopeBoundaryReport>,
    unjudged: usize,
    sites: Vec<SiteRow>,
}
fn analyze_all(
    scopes: &[JsString],
    rules: &BoundaryRules,
    reads: &Reads<'_>,
    listing: Option<&RepoListing>,
    under: &JsString,
    args: BoundaryGateArgs<'_>,
) -> std::result::Result<Analysis, JsString> {
    let mut analysis = Analysis {
        reports: Vec::new(),
        unjudged: 0,
        sites: Vec::new(),
    };
    for scope in scopes {
        let scope = analyze_scope(scope, rules, reads, listing, args)?;
        analysis.unjudged += scope.unjudged;
        analysis.sites.extend(scope.sites);
        analysis.reports.push(scope.report);
    }
    if reads
        .deployables
        .kinds
        .contains(&DeployableKind::WorkerCallCycle)
        && under == "."
    {
        analysis.reports.push(ScopeBoundaryReport {
            scope: ".".into(),
            features: Vec::new(),
            files_scanned: 0.0,
            violations: worker_cycles(&reads.deployables.graph),
            workers: Some(reads.deployables.graph.workers.clone()),
        });
    }
    Ok(analysis)
}
fn current_ledger(
    ledger: &Path,
    legacy: &Path,
) -> Result<std::result::Result<BoundaryLedger, JsString>> {
    Ok(match read_boundary_ledger(ledger).map_err(BoundaryGateError::Io)? {
        LedgerRead::Read { ledger } => Ok(ledger),
        LedgerRead::Invalid { message } => Err(interpolate(&["invalid boundary ledger \"".into(), ledger.to_string_lossy().as_ref().into(), "\": ".into(), message])),
        LedgerRead::Absent if legacy.exists() => Err(format!("{LEGACY_CEILINGS_FILENAME} holds per-scope counts and there is no {LEDGER_FILENAME}: run `code-graph . --boundaries --migrate-ceilings` once to seed the ledger.").into()),
        LedgerRead::Absent => Ok(BoundaryLedger::default()),
    })
}
pub fn run_boundary_gate(args: BoundaryGateArgs<'_>) -> Result<BoundaryGateResult> {
    let mode = match mode_of(args.flags) {
        Ok(mode) => mode,
        Err(message) => return Ok(refused(message)),
    };
    let rules = match resolve_boundary_rules(args.boundary_rules_file)
        .map_err(BoundaryGateError::Config)?
    {
        BoundaryConfigResolution::Resolved(rules) => rules,
        BoundaryConfigResolution::Refused { message } => return Ok(refused(message)),
    };
    let configs = declares_deployables(&rules) || declares_read_allowance(&rules);
    let listing = (configs || declares_libraries(&rules)).then(|| list_repo(args.repo_root));
    let catalog = if configs {
        Some(
            load_binding_catalog(args.repo_root, listing.as_ref())
                .map_err(BoundaryGateError::Catalog)?,
        )
    } else {
        None
    };
    let reads = match read_run(
        &rules,
        args,
        listing.as_ref(),
        catalog.as_ref().unwrap_or(&NO_CATALOG),
    )? {
        Ok(reads) => reads,
        Err(message) => return Ok(refused(message)),
    };
    let ledger_file = args.repo_root.join(LEDGER_FILENAME);
    let legacy_file = args.repo_root.join(LEGACY_CEILINGS_FILENAME);
    let declared: Vec<_> = object_keys(&rules.features)
        .into_iter()
        .cloned()
        .chain(library_scopes(&reads.libraries))
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    if matches!(mode, Mode::Migrate) {
        if ledger_file.exists() {
            return Ok(refused(
                format!("{LEDGER_FILENAME} already exists; there is nothing to migrate.").into(),
            ));
        }
        if !legacy_file.exists() {
            return Ok(refused(
                format!("no {LEGACY_CEILINGS_FILENAME} at the repo root to migrate.").into(),
            ));
        }
        let ceilings = match read_scope_ceilings(&legacy_file.to_string_lossy().as_ref().into())
            .map_err(BoundaryGateError::Ceiling)?
        {
            ScopeCeilingsResolution::Resolved(ceilings) => ceilings,
            ScopeCeilingsResolution::Refused { message } => return Ok(refused(message)),
        };
        let reports = match analyze_all(
            &scopes_under(&declared, &".".into()),
            &rules,
            &reads,
            listing.as_ref(),
            &".".into(),
            args,
        ) {
            Ok(analysis) => analysis.reports,
            Err(message) => return Ok(refused(message)),
        };
        let ledger = match migrated_ledger(&reports, &ceilings) {
            Migration::Migrated { ledger } => ledger,
            Migration::Refused { breaches } => {
                return Ok(refused(render_migration_refused(&breaches)));
            }
        };
        write_boundary_ledger(&ledger_file, &ledger).map_err(BoundaryGateError::Io)?;
        fs::remove_file(&legacy_file).map_err(BoundaryGateError::Io)?;
        return Ok(emitted(
            render_migrated(&ledger, reports.len() as f64, args.json, args.pretty)
                .map_err(BoundaryGateError::Render)?,
            0,
        ));
    }
    let under = scope_of(
        &args.repo_root.to_string_lossy().as_ref().into(),
        &args.root_absolute.to_string_lossy().as_ref().into(),
    )
    .map_err(BoundaryGateError::Io)?;
    let analysis = match analyze_all(
        &scopes_under(&declared, &under),
        &rules,
        &reads,
        listing.as_ref(),
        &under,
        args,
    ) {
        Ok(analysis) => analysis,
        Err(message) => return Ok(refused(message)),
    };
    match mode {
        Mode::Report => {
            let scopes: Vec<_> = analysis
                .reports
                .iter()
                .map(|report| report.scope.clone())
                .collect();
            let undeclared: Vec<_> = analysis
                .reports
                .iter()
                .flat_map(|report| &report.violations)
                .filter_map(|violation| match violation {
                    BoundaryViolation::LibraryUndeclared { from, .. } => Some(from.clone()),
                    _ => None,
                })
                .collect();
            let libraries = library_census(
                &reads.libraries,
                MeasuredLibraries {
                    scopes: &scopes,
                    undeclared: &undeclared,
                    unjudged: analysis.unjudged as f64,
                },
            );
            let deployables = deployable_census(&reads.deployables, &analysis.sites);
            Ok(emitted(
                render_boundaries(
                    &analysis.reports,
                    &under,
                    Censuses {
                        libraries: libraries.as_ref(),
                        deployables: deployables.as_ref(),
                    },
                    args.json,
                    args.pretty,
                )
                .map_err(BoundaryGateError::Render)?,
                0,
            ))
        }
        Mode::Gate | Mode::Accept { .. } => {
            let ledger = match current_ledger(&ledger_file, &legacy_file)? {
                Ok(ledger) => ledger,
                Err(message) => return Ok(refused(message)),
            };
            let result = reconcile(&ledger, &analysis.reports, &under);
            match mode {
                Mode::Gate => {
                    if !result.pruned.is_empty() {
                        write_boundary_ledger(&ledger_file, &result.kept)
                            .map_err(BoundaryGateError::Io)?;
                    }
                    let render = render_ledger_gate(&result, args.json, args.pretty)
                        .map_err(BoundaryGateError::Render)?;
                    Ok(emitted(render.stdout, render.exit_code))
                }
                Mode::Accept { reason } => {
                    if !result.pruned.is_empty() || !result.unrecorded.is_empty() {
                        write_boundary_ledger(
                            &ledger_file,
                            &with_accepted(&result.kept, &result.unrecorded, &reason),
                        )
                        .map_err(BoundaryGateError::Io)?;
                    }
                    Ok(emitted(
                        render_accepted(&result, &reason, args.json, args.pretty)
                            .map_err(BoundaryGateError::Render)?,
                        0,
                    ))
                }
                Mode::Report | Mode::Migrate => unreachable!("handled before ledger access"),
            }
        }
        Mode::Migrate => unreachable!("handled before scoped analysis"),
    }
}
