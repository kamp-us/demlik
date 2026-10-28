use super::reach::{full_adjacency, reachable_from};
use super::surface::public_surface_files;
use crate::extract::functions::is_test_file;
use crate::extract::references::ReferenceResult;
use crate::kinds::rules::{CompiledRule, JsRegex, matching_rules};
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{
    FunctionNode, ModuleNode, NodeKind, UnreachableCategory, UnreachableSymbol, WithheldReason,
    WithheldSymbol,
};
use indexmap::IndexSet;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachableResult {
    pub unreachable: Vec<UnreachableSymbol>,
    pub withheld: Vec<WithheldSymbol>,
    pub reachable_count: usize,
    pub exported_count: usize,
}

pub fn find_unreachable(
    functions: &[FunctionNode],
    modules: &[ModuleNode],
    refs: &ReferenceResult,
    extra_entry_files: &[String],
    test_support: &[CompiledRule],
    export_patterns: &[JsRegex],
    collation: &Collation,
) -> Result<UnreachableResult, CollationError> {
    let adjacency = full_adjacency(functions, &refs.references_by_id, collation)?;
    let mut roots: IndexSet<_> = refs.module_scope_roots.iter().cloned().collect();
    for node in functions {
        if matches!(node.node_kind, Some(NodeKind::Entry { .. })) {
            roots.insert(node.id.clone());
        }
    }
    let mut roots = roots
        .into_iter()
        .map(|id| CollationInput::from_text(&id).map(|key| (id, key)))
        .collect::<Result<Vec<_>, _>>()?;
    roots.sort_by(|left, right| collation.compare(&left.1, &right.1));
    let roots = roots.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    let reachable = reachable_from(&adjacency, &roots);
    let surface = public_surface_files(modules, extra_entry_files, export_patterns);
    let test_like =
        |file: &str| is_test_file(file) || !matching_rules(test_support, &file.into()).is_empty();
    let mut unreachable = Vec::new();
    let mut withheld = Vec::new();
    let mut exported_count = 0;
    for node in functions {
        if !node.is_exported || node.is_test {
            continue;
        }
        exported_count += 1;
        if reachable.contains(&node.id) {
            continue;
        }
        let mut tests = Vec::new();
        let mut production = Vec::new();
        for file in refs.identifier_files.get(&node.name).into_iter().flatten() {
            if *file != node.file {
                if test_like(file) {
                    tests.push(file.clone());
                } else {
                    production.push(file.clone());
                }
            }
        }
        let reason = if test_like(&node.file) {
            Some(WithheldReason::TestSupportSurface)
        } else if surface.contains(&node.file) {
            Some(WithheldReason::PublicEntrySurface)
        } else if !production.is_empty() {
            Some(WithheldReason::ReferencedInNonTestFile)
        } else {
            None
        };
        if let Some(reason) = reason {
            withheld.push(WithheldSymbol {
                id: node.id.clone(),
                reason,
            });
        } else {
            unreachable.push(UnreachableSymbol {
                id: node.id.clone(),
                file: node.file.clone(),
                start_line: node.start_line,
                category: if tests.is_empty() {
                    UnreachableCategory::Dead
                } else {
                    UnreachableCategory::OnlyCalledFromTests
                },
                test_references: tests,
            });
        }
    }
    let mut unreachable = unreachable
        .into_iter()
        .map(|row| {
            let category = CollationInput::from_text(row.category.as_str())?;
            let id = CollationInput::from_text(&row.id)?;
            Ok((row, category, id))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    unreachable.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
    });
    let mut withheld = withheld
        .into_iter()
        .map(|row| {
            let reason = CollationInput::from_text(row.reason.as_str())?;
            let id = CollationInput::from_text(&row.id)?;
            Ok((row, reason, id))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    withheld.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
    });
    Ok(UnreachableResult {
        unreachable: unreachable.into_iter().map(|(row, _, _)| row).collect(),
        withheld: withheld.into_iter().map(|(row, _, _)| row).collect(),
        reachable_count: reachable.len(),
        exported_count,
    })
}
