use super::reach::{full_adjacency, reachable_from};
use super::surface::public_surface_files;
use crate::extract::functions::is_test_file;
use crate::extract::references::ReferenceResult;
use crate::kinds::rules::{CompiledRule, JsRegex, matching_rules};
use crate::project::locale_compare;
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
) -> UnreachableResult {
    let mut roots: IndexSet<_> = refs.module_scope_roots.iter().cloned().collect();
    for node in functions {
        if matches!(node.node_kind, Some(NodeKind::Entry { .. })) {
            roots.insert(node.id.clone());
        }
    }
    let mut roots: Vec<_> = roots.into_iter().collect();
    roots.sort_by(|left, right| locale_compare(left, right));
    let reachable = reachable_from(&full_adjacency(functions, &refs.references_by_id), &roots);
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
    unreachable.sort_by(|left, right| {
        locale_compare(left.category.as_str(), right.category.as_str())
            .then_with(|| locale_compare(&left.id, &right.id))
    });
    withheld.sort_by(|left, right| {
        locale_compare(left.reason.as_str(), right.reason.as_str())
            .then_with(|| locale_compare(&left.id, &right.id))
    });
    UnreachableResult {
        unreachable,
        withheld,
        reachable_count: reachable.len(),
        exported_count,
    }
}
