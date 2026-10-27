use super::analysis::{
    AnalysisBundle, AnalysisError, AnalysisOptions, AnalysisPrep, CompleteInput, NamedSymbol,
    analysis_inputs, complete_analysis, prepare_analysis,
};
use super::cross_runtime::{CrossRuntimeInput, create_cross_runtime_resolver};
use super::directories::build_directories;
use super::edges::{EdgeResult, resolve_edges_with_cross_runtime};
use super::functions::{DiscoveredFunction, discover_functions, is_test_file};
use super::metrics::{compute_function_metrics, module_comment_lines, module_loc};
use crate::checker::context::{
    TypeContext, TypeContextInput, with_type_context, with_type_context_text,
};
use crate::data::extract::load_data_report;
use crate::declarations::discover::{build_declaration_nodes, discover_declarations};
use crate::declarations::uses::resolve_declaration_uses;
use crate::engine::tsgo::{TsgoBinary, TsgoError};
use crate::extract::wrangler_config::CatalogError;
use crate::project::{
    EdgeScope, LoadedEdgeProject, LoadedProject, discover_package_roots, locale_compare,
    relative_path_text, resolve_path_text, to_relative,
};
use crate::schema::{
    Edges, FunctionNode, Graph, ModuleNode, Provenance, Severity, Stats, Summary, ThresholdError,
    Thresholds, UseSite,
};
use crate::smells::coupling::coupling_by_file;
use crate::smells::evaluate::{compare_flat_smells, smells_for_function, smells_for_module};
use crate::smells::health::{HealthInput, health_band};
use crate::smells::plan::{PlanAxis, rank_plan};
use crate::syntax::headers::function_header;
use crate::syntax::imports::{
    import_declaration_specifiers, resolve_imports, resolve_imports_text,
};
use crate::text::JsString;
use indexmap::IndexMap;
use std::{io, path::Path};

#[derive(Debug, Default, Clone, Copy)]
pub struct NodeFields {
    pub headers: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct DataOptions<'a> {
    pub repo_root: &'a Path,
}

#[derive(Debug)]
pub enum AssemblyError {
    WorkingDirectory(io::Error),
    Threshold(ThresholdError),
    Compiler(TsgoError),
    Analysis(AnalysisError),
    Data(CatalogError),
}
impl AssemblyError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Analysis(error) => error.name(),
            Self::Data(error) => error.name(),
            Self::WorkingDirectory(_) | Self::Threshold(_) | Self::Compiler(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Analysis(error) => error.message(),
            Self::Data(error) => error.message(),
            Self::WorkingDirectory(_) | Self::Threshold(_) | Self::Compiler(_) => {
                self.to_string().into()
            }
        }
    }
}
impl std::fmt::Display for AssemblyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkingDirectory(error) => error.fmt(formatter),
            Self::Threshold(error) => error.fmt(formatter),
            Self::Compiler(error) => error.fmt(formatter),
            Self::Analysis(error) => error.fmt(formatter),
            Self::Data(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for AssemblyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::WorkingDirectory(error) => Some(error),
            Self::Threshold(error) => Some(error),
            Self::Compiler(error) => Some(error),
            Self::Analysis(error) => Some(error),
            Self::Data(error) => Some(error),
        }
    }
}
impl From<AnalysisError> for AssemblyError {
    fn from(error: AnalysisError) -> Self {
        match error {
            AnalysisError::Compiler(error) => Self::Compiler(error),
            error => Self::Analysis(error),
        }
    }
}

/// The syntax-only graph records unmeasured semantic reports and uses as `None`.
pub fn assemble_graph(
    loaded: &LoadedProject,
    thresholds: Thresholds,
    fields: NodeFields,
) -> Result<Graph, AssemblyError> {
    build(
        BuildInput {
            loaded,
            root_text: None,
        },
        thresholds,
        fields,
        None,
        None,
        None,
        None,
    )
}

pub fn assemble_graph_with_data(
    loaded: &LoadedProject,
    thresholds: Thresholds,
    fields: NodeFields,
    data: DataOptions<'_>,
) -> Result<Graph, AssemblyError> {
    build(
        BuildInput {
            loaded,
            root_text: None,
        },
        thresholds,
        fields,
        None,
        None,
        None,
        Some(data),
    )
}

struct BuildInput<'a> {
    loaded: &'a LoadedProject,
    root_text: Option<&'a JsString>,
}

struct EdgeBundle {
    result: EdgeResult,
    declaration_uses: IndexMap<String, Vec<UseSite>>,
    scope: EdgeScope,
    ts_config: String,
}
struct TextAssembly<'a> {
    root: &'a JsString,
    warning: &'a mut dyn FnMut(&JsString),
}
fn stderr_warning(line: &JsString) {
    eprint!("{}", line.to_lossy());
}
fn report_unjoined(unjoined: &[String], what: &str, warning: Option<&mut dyn FnMut(&JsString)>) {
    if unjoined.is_empty() {
        return;
    }
    let shown = unjoined
        .iter()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = if unjoined.len() > 5 { ", ..." } else { "" };
    let line = format!(
        "code-graph: warning: {} {what}: {shown}{more}\n",
        unjoined.len()
    )
    .into();
    match warning {
        Some(warning) => warning(&line),
        None => stderr_warning(&line),
    }
}

pub fn assemble_graph_with_edges(
    loaded: &LoadedEdgeProject,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
) -> Result<Graph, AssemblyError> {
    assemble_graph_with_reports(loaded, thresholds, binary, fields, None, None)
}

pub fn assemble_graph_with_analysis(
    loaded: &LoadedEdgeProject,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
    options: &AnalysisOptions<'_>,
) -> Result<Graph, AssemblyError> {
    assemble_graph_with_reports(loaded, thresholds, binary, fields, Some(options), None)
}

/// Reuse the original logical root supplied to `load_edge_project_text`.
/// Its Path-backed loaded input retains filesystem identity; the same text is sent to tsgo.
pub fn assemble_graph_with_analysis_text(
    loaded: &LoadedEdgeProject,
    root_text: &JsString,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
    options: &AnalysisOptions<'_>,
) -> Result<Graph, AssemblyError> {
    assemble_graph_with_analysis_text_and_warning(
        loaded,
        root_text,
        thresholds,
        binary,
        fields,
        options,
        &mut stderr_warning,
    )
}

/// Deliver complete warning lines immediately; the local CLI sink records pending IO failures.
pub(crate) fn assemble_graph_with_analysis_text_and_warning(
    loaded: &LoadedEdgeProject,
    root_text: &JsString,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
    options: &AnalysisOptions<'_>,
    warning: &mut dyn FnMut(&JsString),
) -> Result<Graph, AssemblyError> {
    assemble_graph_with_reports_in(
        loaded,
        thresholds,
        binary,
        fields,
        Some(options),
        None,
        Some(TextAssembly {
            root: root_text,
            warning,
        }),
    )
}

pub fn assemble_graph_with_reports(
    loaded: &LoadedEdgeProject,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
    options: Option<&AnalysisOptions<'_>>,
    data: Option<DataOptions<'_>>,
) -> Result<Graph, AssemblyError> {
    assemble_graph_with_reports_in(loaded, thresholds, binary, fields, options, data, None)
}

fn assemble_graph_with_reports_in(
    loaded: &LoadedEdgeProject,
    thresholds: Thresholds,
    binary: &TsgoBinary,
    fields: NodeFields,
    options: Option<&AnalysisOptions<'_>>,
    data: Option<DataOptions<'_>>,
    mut text: Option<TextAssembly<'_>>,
) -> Result<Graph, AssemblyError> {
    let root_text = text.as_ref().map(|text| text.root);
    thresholds.validate().map_err(AssemblyError::Threshold)?;
    let functions = discover_functions(&loaded.project.source_files).functions;
    let ids: Vec<_> = functions
        .iter()
        .map(|function| function.id.clone())
        .collect();
    let imports = match root_text {
        Some(root) => {
            resolve_imports_text(root, &loaded.project.source_files, &loaded.ts_config_path)
                .map_err(AssemblyError::WorkingDirectory)?
        }
        None => resolve_imports(
            &loaded.project.root_absolute,
            &loaded.project.source_files,
            &loaded.ts_config_path,
        ),
    };
    let input = TypeContextInput {
        project: &loaded.project,
        ts_config_path: &loaded.ts_config_path,
        functions: &functions,
    };
    let read = |context: &mut TypeContext<'_, '_>| {
        report_unjoined(
            &context.unjoined,
            "function(s) have no node in tsgo's tree, so their calls are not resolved",
            text.as_mut()
                .map(|text| &mut *text.warning as &mut dyn FnMut(&JsString)),
        );
        Ok((|| -> Result<_, AnalysisError> {
            let prep = options
                .map(prepare_analysis)
                .transpose()?
                .unwrap_or_else(AnalysisPrep::default);
            let mut resolver = options
                .zip(prep.catalog.as_ref())
                .map(|(options, catalog)| {
                    create_cross_runtime_resolver(
                        CrossRuntimeInput {
                            catalog,
                            root_absolute: &loaded.project.root_absolute,
                            repo_root: options.repo_root,
                        },
                        context,
                    )
                })
                .transpose()?;
            let result =
                resolve_edges_with_cross_runtime(context, imports, &ids, resolver.as_mut())?;
            let uses = resolve_declaration_uses(
                context,
                &discover_declarations(&loaded.project.source_files),
            )?;
            report_unjoined(
                &uses.unjoined,
                "declaration(s) have no node in tsgo's tree, so their uses are unknown",
                text.as_mut()
                    .map(|text| &mut *text.warning as &mut dyn FnMut(&JsString)),
            );
            let analysis = options
                .map(|options| {
                    complete_analysis(CompleteInput {
                        options,
                        prep: &prep,
                        root_absolute: &loaded.project.root_absolute,
                        context,
                        functions: &functions,
                        inputs: &analysis_inputs(functions.iter().map(NamedSymbol::from)),
                        resolver: resolver.as_ref(),
                    })
                })
                .transpose()?;
            Ok((result, uses.uses_by_id, analysis))
        })())
    };
    let resolved = match root_text {
        Some(root) => with_type_context_text(binary, input, root, read),
        None => with_type_context(binary, input, read),
    };
    let (result, declaration_uses, analysis) = resolved
        .map_err(AssemblyError::Compiler)?
        .map_err(AssemblyError::from)?;
    build(
        BuildInput {
            loaded: &loaded.project,
            root_text,
        },
        thresholds,
        fields,
        Some(EdgeBundle {
            result,
            declaration_uses,
            scope: loaded.scope,
            ts_config: match root_text {
                Some(root) => {
                    crate::project::selected_config_text(root, &loaded.ts_config_path).to_lossy()
                }
                None => loaded.ts_config_path.to_string_lossy().into_owned(),
            },
        }),
        Some(functions),
        analysis,
        data,
    )
}

fn build(
    input: BuildInput<'_>,
    thresholds: Thresholds,
    fields: NodeFields,
    mut edges: Option<EdgeBundle>,
    discovered: Option<Vec<DiscoveredFunction>>,
    analysis: Option<AnalysisBundle>,
    data: Option<DataOptions<'_>>,
) -> Result<Graph, AssemblyError> {
    let BuildInput { loaded, root_text } = input;
    thresholds.validate().map_err(AssemblyError::Threshold)?;
    let cwd = std::env::current_dir().map_err(AssemblyError::WorkingDirectory)?;
    let root = match root_text {
        Some(root) => {
            let absolute =
                resolve_path_text(&cwd, root).map_err(AssemblyError::WorkingDirectory)?;
            relative_path_text(&cwd, &absolute).map_err(AssemblyError::WorkingDirectory)?
        }
        None => to_relative(&cwd, &loaded.root_absolute).into(),
    };
    let discovered =
        discovered.unwrap_or_else(|| discover_functions(&loaded.source_files).functions);
    let functions: Vec<_> = discovered
        .iter()
        .map(|discovered| {
            let metrics = compute_function_metrics(discovered);
            let header = fields.headers.then(|| function_header(discovered.node()));
            let measured = edges.as_mut().map(|bundle| Edges {
                calls: bundle
                    .result
                    .calls_by_id
                    .shift_remove(&discovered.id)
                    .unwrap_or_default(),
                called_by: bundle
                    .result
                    .called_by_id
                    .shift_remove(&discovered.id)
                    .unwrap_or_default(),
                call_chain_depth: bundle
                    .result
                    .chain_depth_by_id
                    .shift_remove(&discovered.id)
                    .unwrap_or(0),
            });
            let mut function = FunctionNode {
                id: discovered.id.clone(),
                name: discovered.name.clone(),
                kind: discovered.kind,
                file: discovered.file.clone(),
                start_line: discovered.start_line,
                end_line: discovered.end_line,
                loc: metrics.loc,
                comment_lines: metrics.comment_lines,
                nesting_depth: metrics.nesting_depth,
                complexity: metrics.complexity,
                is_exported: discovered.is_exported,
                is_test: discovered.is_test,
                edges: measured,
                node_kind: None,
                smells: Vec::new(),
                header,
            };
            function.smells = smells_for_function(&function, &thresholds);
            function
        })
        .collect();
    let mut ids_by_file: IndexMap<&str, Vec<String>> = IndexMap::new();
    for function in &functions {
        ids_by_file
            .entry(&function.file)
            .or_default()
            .push(function.id.clone());
    }
    let mut modules: Vec<_> = loaded
        .source_files
        .iter()
        .map(|unit| {
            let mut function_ids = ids_by_file
                .shift_remove(unit.file.as_str())
                .unwrap_or_default();
            function_ids.sort_by(|left, right| locale_compare(left, right));
            let (imports, imported_by, import_edges) = if let Some(bundle) = edges.as_mut() {
                (
                    bundle
                        .result
                        .imports_by_file
                        .shift_remove(&unit.file)
                        .unwrap_or_default(),
                    bundle
                        .result
                        .imported_by_file
                        .shift_remove(&unit.file)
                        .unwrap_or_default(),
                    bundle
                        .result
                        .import_edges_by_file
                        .shift_remove(&unit.file)
                        .unwrap_or_default(),
                )
            } else {
                (
                    import_declaration_specifiers(&unit.syntax),
                    Vec::new(),
                    Vec::new(),
                )
            };
            ModuleNode {
                file: unit.file.clone(),
                loc: module_loc(&unit.syntax),
                comment_lines: module_comment_lines(&unit.syntax),
                function_ids,
                imports,
                imported_by,
                import_edges,
                is_test: is_test_file(&unit.file),
                smells: Vec::new(),
            }
        })
        .collect();
    modules.sort_by(|left, right| locale_compare(&left.file, &right.file));
    let coupling = edges.as_ref().map(|_| {
        coupling_by_file(
            &modules,
            &discover_package_roots(&loaded.root_absolute, None),
        )
    });
    for module in &mut modules {
        module.smells = smells_for_module(
            module,
            &thresholds,
            coupling.as_ref().and_then(|facts| facts.get(&module.file)),
        );
    }
    let directories = build_directories(&modules, &thresholds);
    let mut smells: Vec<_> = functions
        .iter()
        .flat_map(|function| &function.smells)
        .chain(modules.iter().flat_map(|module| &module.smells))
        .chain(directories.iter().flat_map(|directory| &directory.smells))
        .cloned()
        .collect();
    smells.sort_by(compare_flat_smells);
    let smell_count = smells.len();
    let high_severity_count = smells
        .iter()
        .filter(|smell| smell.severity == Severity::High)
        .count();
    let top_targets: Vec<_> = rank_plan(&functions, PlanAxis::Rot)
        .into_iter()
        .filter(|row| row.components.smells > 0)
        .take(10)
        .collect();
    let worst_function = top_targets.first().map(|row| row.id.clone());
    let mut worst_file = None;
    let mut worst_weight = 0;
    for module in &modules {
        let weight = module
            .smells
            .iter()
            .map(|smell| {
                if smell.severity == Severity::High {
                    2
                } else {
                    1
                }
            })
            .sum();
        if weight > worst_weight {
            worst_weight = weight;
            worst_file = Some(module.file.clone());
        }
    }
    let summary = Summary {
        health: health_band(HealthInput {
            smell_count,
            high_severity_count,
            file_count: modules.len(),
        }),
        file_count: modules.len(),
        function_count: functions.len(),
        smell_count,
        high_severity_count,
        worst_file,
        worst_function,
        top_targets,
        parse_failures: loaded.parse_failures.clone(),
    };
    let stats = Stats {
        file_count: modules.len(),
        function_count: functions.len(),
        total_loc: modules.iter().map(|module| module.loc).sum(),
        total_comment_lines: modules.iter().map(|module| module.comment_lines).sum(),
        smell_count,
        parse_failures: loaded.parse_failures.clone(),
    };
    let mut graph = Graph {
        root: if root.is_empty() { ".".into() } else { root },
        provenance: edges
            .as_ref()
            .map_or(Provenance::Cheap, |bundle| Provenance::Edges {
                ts_config: bundle.ts_config.clone(),
                scope: bundle.scope,
            }),
        thresholds,
        summary,
        cross_runtime: None,
        reachability: None,
        clusters: None,
        interface_width: None,
        data: None,
        functions,
        declarations: build_declaration_nodes(
            &loaded.source_files,
            edges.as_ref().map(|bundle| &bundle.declaration_uses),
        ),
        modules,
        directories,
        smells,
        stats,
    };
    if let Some(analysis) = analysis {
        analysis.apply(&mut graph).map_err(AssemblyError::from)?;
    }
    graph.data = data
        .map(|options| load_data_report(&loaded.source_files, &discovered, options.repo_root))
        .transpose()
        .map_err(AssemblyError::Data)?;
    Ok(graph)
}

#[cfg(test)]
#[path = "assembly_warning_tests.rs"]
mod warning_tests;
