use super::rules::{
    DirectoryFacts, FunctionFacts, ModuleFacts, RuleContext, evaluate_rule, smell_kinds,
};
use crate::extract::edges::distinct_external_callers;
use crate::project::locale_compare;
use crate::schema::{
    DirectoryNode, FunctionNode, ModuleNode, Severity, Smell, SmellTarget, Thresholds,
};
use std::cmp::Ordering;

pub struct CouplingFacts {
    pub cycle_size: usize,
    pub cross_boundary_out_count: usize,
}
fn compare_smells(left: &Smell, right: &Smell) -> Ordering {
    locale_compare(left.kind.as_str(), right.kind.as_str())
        .then_with(|| {
            if left.severity == right.severity {
                Ordering::Equal
            } else if left.severity == Severity::High {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        })
        .then_with(|| right.value.cmp(&left.value))
}
fn evaluate(context: RuleContext<'_>) -> Vec<Smell> {
    let mut smells: Vec<_> = smell_kinds()
        .into_iter()
        .flat_map(|kind| {
            evaluate_rule(kind, &context)
                .into_iter()
                .map(move |raw| Smell {
                    kind,
                    target: raw.target,
                    value: raw.value,
                    threshold: raw.threshold,
                    severity: raw.severity,
                })
        })
        .collect();
    smells.sort_by(compare_smells);
    smells
}

pub fn smells_for_function(function: &FunctionNode, thresholds: &Thresholds) -> Vec<Smell> {
    let facts = FunctionFacts {
        id: &function.id,
        file: &function.file,
        start_line: function.start_line,
        loc: function.loc,
        comment_lines: function.comment_lines,
        nesting_depth: function.nesting_depth,
        complexity: function.complexity,
        called_by_count: function
            .edges
            .as_ref()
            .map(|edges| distinct_external_callers(&function.id, &edges.called_by)),
        call_chain_depth: function.edges.as_ref().map(|edges| edges.call_chain_depth),
    };
    evaluate(RuleContext {
        function: Some(&facts),
        module: None,
        directory: None,
        thresholds,
    })
}
pub fn smells_for_module(
    module: &ModuleNode,
    thresholds: &Thresholds,
    coupling: Option<&CouplingFacts>,
) -> Vec<Smell> {
    let facts = ModuleFacts {
        file: &module.file,
        loc: module.loc,
        cycle_size: coupling.map(|facts| facts.cycle_size),
        cross_boundary_out_count: coupling.map(|facts| facts.cross_boundary_out_count),
    };
    evaluate(RuleContext {
        function: None,
        module: Some(&facts),
        directory: None,
        thresholds,
    })
}
pub fn smells_for_directory(directory: &DirectoryNode, thresholds: &Thresholds) -> Vec<Smell> {
    let facts = DirectoryFacts {
        dir: &directory.dir,
        file_count: directory.file_count,
    };
    evaluate(RuleContext {
        function: None,
        module: None,
        directory: Some(&facts),
        thresholds,
    })
}
fn locator(smell: &Smell) -> String {
    match &smell.target {
        SmellTarget::Function {
            file, start_line, ..
        } => format!("{file}:{start_line:08}"),
        SmellTarget::Module { file } => file.clone(),
        SmellTarget::Directory { dir } => dir.clone(),
    }
}
pub fn compare_flat_smells(left: &Smell, right: &Smell) -> Ordering {
    locale_compare(&locator(left), &locator(right)).then_with(|| compare_smells(left, right))
}
