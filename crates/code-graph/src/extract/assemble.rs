use super::directories::build_directories;
use super::functions::{discover_functions, is_test_file};
use super::metrics::{compute_function_metrics, module_comment_lines, module_loc};
use crate::declarations::discover::build_declaration_nodes;
use crate::project::{LoadedProject, locale_compare, to_relative};
use crate::schema::{
    FunctionNode, Graph, ModuleNode, Provenance, Severity, Stats, Summary, ThresholdError,
    Thresholds,
};
use crate::smells::evaluate::{compare_flat_smells, smells_for_function, smells_for_module};
use crate::smells::health::{HealthInput, health_band};
use crate::smells::plan::{PlanAxis, rank_plan};
use crate::syntax::headers::function_header;
use crate::syntax::imports::import_declaration_specifiers;
use indexmap::IndexMap;
use std::io;

#[derive(Debug, Default, Clone, Copy)]
pub struct NodeFields {
    pub headers: bool,
}

#[derive(Debug)]
pub enum AssemblyError {
    WorkingDirectory(io::Error),
    Threshold(ThresholdError),
}
impl std::fmt::Display for AssemblyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkingDirectory(error) => error.fmt(formatter),
            Self::Threshold(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for AssemblyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::WorkingDirectory(error) => Some(error),
            Self::Threshold(error) => Some(error),
        }
    }
}

/// The syntax-only graph records unmeasured semantic reports and uses as `None`.
pub fn assemble_graph(
    loaded: &LoadedProject,
    thresholds: Thresholds,
    fields: NodeFields,
) -> Result<Graph, AssemblyError> {
    thresholds.validate().map_err(AssemblyError::Threshold)?;
    let root = to_relative(
        &std::env::current_dir().map_err(AssemblyError::WorkingDirectory)?,
        &loaded.root_absolute,
    );
    let functions: Vec<_> = discover_functions(&loaded.source_files)
        .functions
        .into_iter()
        .map(|discovered| {
            let metrics = compute_function_metrics(&discovered);
            let header = fields.headers.then(|| function_header(discovered.node()));
            let mut function = FunctionNode {
                id: discovered.id,
                name: discovered.name,
                kind: discovered.kind,
                file: discovered.file,
                start_line: discovered.start_line,
                end_line: discovered.end_line,
                loc: metrics.loc,
                comment_lines: metrics.comment_lines,
                nesting_depth: metrics.nesting_depth,
                complexity: metrics.complexity,
                is_exported: discovered.is_exported,
                is_test: discovered.is_test,
                edges: None,
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
            let mut module = ModuleNode {
                file: unit.file.clone(),
                loc: module_loc(&unit.syntax),
                comment_lines: module_comment_lines(&unit.syntax),
                function_ids,
                imports: import_declaration_specifiers(&unit.syntax),
                imported_by: Vec::new(),
                import_edges: Vec::new(),
                is_test: is_test_file(&unit.file),
                smells: Vec::new(),
            };
            module.smells = smells_for_module(&module, &thresholds, None);
            module
        })
        .collect();
    modules.sort_by(|left, right| locale_compare(&left.file, &right.file));
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
    Ok(Graph {
        root: if root.is_empty() { ".".into() } else { root },
        provenance: Provenance::Cheap,
        thresholds,
        summary,
        cross_runtime: None,
        reachability: None,
        clusters: None,
        interface_width: None,
        data: None,
        functions,
        declarations: build_declaration_nodes(&loaded.source_files, None),
        modules,
        directories,
        smells,
        stats,
    })
}
