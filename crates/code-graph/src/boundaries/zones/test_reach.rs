use super::test_role::matches_globs;
use crate::{
    boundaries::{
        rules::in_scope,
        violation::{BoundaryViolation, False},
    },
    kinds::rules::JsRegex,
    syntax::imports::ImportEdge,
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::sync::{Arc, LazyLock};

pub struct OpeningFile<'a> {
    pub file: &'a JsString,
    pub import_edges: &'a [ImportEdge],
    pub runtime_specifiers: &'a IndexSet<JsString>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootReach {
    pub roots: IndexSet<JsString>,
    pub in_reach: IndexSet<JsString>,
}

static NO_ROOTS: LazyLock<Arc<RootReach>> = LazyLock::new(|| Arc::new(RootReach::default()));

fn opened(file: &OpeningFile<'_>) -> IndexMap<JsString, JsString> {
    let mut targets = IndexMap::new();
    for edge in file.import_edges {
        let Some(target) = &edge.target else { continue };
        if file.runtime_specifiers.contains(&edge.specifier) {
            targets
                .entry(target.as_str().into())
                .or_insert_with(|| edge.specifier.clone());
        }
    }
    targets
}

pub fn root_reach_of(
    globs: &[JsRegex],
    scope: &JsString,
    files: &[OpeningFile<'_>],
) -> Arc<RootReach> {
    if globs.is_empty() {
        return Arc::clone(&NO_ROOTS);
    }
    let roots: IndexSet<_> = files
        .iter()
        .filter(|file| matches_globs(globs, scope, file.file))
        .map(|file| file.file.clone())
        .collect();
    let mut opened_by: IndexMap<JsString, Vec<JsString>> = IndexMap::new();
    for file in files {
        for target in opened(file).into_keys() {
            opened_by.entry(target).or_default().push(file.file.clone());
        }
    }
    let mut in_reach = roots.clone();
    let mut pending: Vec<_> = roots.iter().cloned().collect();
    while let Some(next) = pending.pop() {
        for opener in opened_by.get(&next).into_iter().flatten() {
            if in_reach.insert(opener.clone()) {
                pending.push(opener.clone());
            }
        }
    }
    Arc::new(RootReach { roots, in_reach })
}

pub fn test_reach_violations(
    reach: &RootReach,
    scope: &JsString,
    test: &OpeningFile<'_>,
) -> Vec<BoundaryViolation> {
    if reach.roots.contains(test.file) {
        return Vec::new();
    }
    opened(test)
        .into_iter()
        .filter(|(target, _)| reach.in_reach.contains(target))
        .map(
            |(target, specifier)| BoundaryViolation::TestReachesCompositionRoot {
                from: in_scope(scope, test.file),
                to: in_scope(scope, &target),
                specifier,
                type_only: False,
            },
        )
        .collect()
}
