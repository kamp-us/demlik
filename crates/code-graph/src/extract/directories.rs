use crate::project::locale_compare;
use crate::schema::{DirectoryNode, ModuleNode, Thresholds};
use crate::smells::evaluate::smells_for_directory;
use indexmap::IndexMap;

pub fn build_directories(modules: &[ModuleNode], thresholds: &Thresholds) -> Vec<DirectoryNode> {
    let mut by_dir: IndexMap<&str, (Vec<String>, usize)> = IndexMap::new();
    for module in modules {
        let dir = module
            .file
            .rsplit_once('/')
            .map_or(".", |(dir, _)| if dir.is_empty() { "." } else { dir });
        let (files, function_count) = by_dir.entry(dir).or_default();
        files.push(module.file.clone());
        *function_count += module.function_ids.len();
    }
    let mut directories: Vec<_> = by_dir
        .into_iter()
        .map(|(dir, (mut files, function_count))| {
            files.sort_by(|left, right| locale_compare(left, right));
            let mut node = DirectoryNode {
                dir: dir.into(),
                file_count: files.len(),
                function_count,
                files,
                smells: Vec::new(),
            };
            node.smells = smells_for_directory(&node, thresholds);
            node
        })
        .collect();
    directories.sort_by(|left, right| locale_compare(&left.dir, &right.dir));
    directories
}
