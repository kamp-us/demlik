use super::rules::{
    DirectoryFacts, FunctionFacts, ModuleFacts, RuleContext, evaluate_rule, smell_kinds,
};
use crate::extract::edges::distinct_external_callers;
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{
    DirectoryNode, FunctionNode, ModuleNode, Severity, Smell, SmellTarget, Thresholds,
};
use std::cmp::Ordering;

pub use super::coupling::CouplingFacts;
fn compare_smells(left: &Smell, right: &Smell) -> Ordering {
    left.kind
        .as_str()
        .cmp(right.kind.as_str())
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
fn compare_flat_by_key(
    left: &Smell,
    right: &Smell,
    left_key: &CollationInput,
    right_key: &CollationInput,
    collation: &Collation,
) -> Ordering {
    collation
        .compare(left_key, right_key)
        .then_with(|| compare_smells(left, right))
}

pub fn compare_flat_smells(
    left: &Smell,
    right: &Smell,
    collation: &Collation,
) -> Result<Ordering, CollationError> {
    let left_key = CollationInput::from_text(&locator(left))?;
    let right_key = CollationInput::from_text(&locator(right))?;
    Ok(compare_flat_by_key(
        left, right, &left_key, &right_key, collation,
    ))
}

pub(crate) fn sort_flat_smells(
    smells: Vec<Smell>,
    collation: &Collation,
) -> Result<Vec<Smell>, CollationError> {
    let mut rows = smells
        .into_iter()
        .map(|smell| CollationInput::from_text(&locator(&smell)).map(|key| (smell, key)))
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by(|(left, left_key), (right, right_key)| {
        compare_flat_by_key(left, right, left_key, right_key, collation)
    });
    Ok(rows.into_iter().map(|(smell, _)| smell).collect())
}
