use crate::{
    boundaries::violation::BoundaryViolation,
    project::{dirname_path_text, join_path_text},
    syntax::imports::{ImportEdge, is_relative_units},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};

pub fn workspace_at<'a>(roots: &'a IndexSet<JsString>, target: &JsString) -> Option<&'a JsString> {
    if target == ".." || target.starts_with("../") {
        return None;
    }
    let mut dir = target.clone();
    loop {
        if let Some(root) = roots.get(&dir) {
            return Some(root);
        }
        if dir == "." {
            return None;
        }
        dir = dir
            .units()
            .iter()
            .rposition(|unit| *unit == 47)
            .map_or_else(
                || ".".into(),
                |slash| JsString::from_units(dir.units()[..slash].to_vec()),
            );
    }
}
pub fn cross_workspace_imports(
    roots: &IndexSet<JsString>,
    scope: &JsString,
    from: &JsString,
    edges: &[ImportEdge],
) -> Vec<BoundaryViolation> {
    let dir = dirname_path_text(from);
    let home = workspace_at(roots, &dir).unwrap_or(scope);
    let mut reached: IndexMap<JsString, (&JsString, bool)> = IndexMap::new();
    for edge in edges {
        if !is_relative_units(&edge.specifier) {
            continue;
        }
        let specifier = JsString::from_units(
            edge.specifier
                .units()
                .iter()
                .map(|unit| if *unit == 92 { 47 } else { *unit })
                .collect(),
        );
        let target = join_path_text(&dir, &specifier);
        let workspace = workspace_at(roots, &target).unwrap_or(scope);
        if workspace == home {
            continue;
        }
        let held = reached
            .entry(workspace.clone())
            .or_insert((&edge.specifier, true));
        held.1 &= edge.type_only;
    }
    reached
        .into_iter()
        .map(
            |(to, (specifier, type_only))| BoundaryViolation::RelativeImportCrossesWorkspace {
                from: from.clone(),
                to,
                specifier: specifier.clone(),
                type_only,
            },
        )
        .collect()
}
