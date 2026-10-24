use crate::kinds::rules::JsRegex;
use crate::schema::{ImportEdgeKind, ModuleNode};
use indexmap::{IndexMap, IndexSet};

fn is_barrel(file: &str) -> bool {
    file == "index.ts"
        || file == "index.tsx"
        || file.ends_with("/index.ts")
        || file.ends_with("/index.tsx")
}
pub fn public_surface_files(
    modules: &[ModuleNode],
    extra_entry_files: &[String],
    export_patterns: &[JsRegex],
) -> IndexSet<String> {
    let by_file: IndexMap<_, _> = modules
        .iter()
        .map(|node| (node.file.as_str(), node))
        .collect();
    let mut queue: Vec<_> = modules
        .iter()
        .filter(|node| is_barrel(&node.file))
        .map(|node| node.file.clone())
        .chain(
            extra_entry_files
                .iter()
                .filter(|file| by_file.contains_key(file.as_str()))
                .cloned(),
        )
        .chain(
            modules
                .iter()
                .filter(|node| {
                    export_patterns
                        .iter()
                        .any(|pattern| pattern.test_str(&node.file))
                })
                .map(|node| node.file.clone()),
        )
        .collect();
    let mut surface = IndexSet::new();
    let mut index = 0;
    while let Some(file) = queue.get(index).cloned() {
        index += 1;
        if !surface.insert(file.clone()) {
            continue;
        }
        for edge in by_file
            .get(file.as_str())
            .into_iter()
            .flat_map(|node| &node.import_edges)
        {
            if edge.kind == ImportEdgeKind::ExportFrom
                && let Some(target) = &edge.target
            {
                queue.push(target.clone());
            }
        }
    }
    surface
}
