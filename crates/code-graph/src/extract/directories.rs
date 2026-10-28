use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{DirectoryNode, ModuleNode, Thresholds};
use crate::smells::evaluate::smells_for_directory;
use indexmap::IndexMap;

pub fn build_directories(
    modules: &[ModuleNode],
    thresholds: &Thresholds,
    collation: &Collation,
) -> Result<Vec<DirectoryNode>, CollationError> {
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
        .map(|(dir, (files, function_count))| {
            let mut files = files
                .into_iter()
                .map(|file| {
                    let key = CollationInput::from_text(&file)?;
                    Ok((file, key))
                })
                .collect::<Result<Vec<_>, CollationError>>()?;
            files.sort_by(|left, right| collation.compare(&left.1, &right.1));
            let files = files.into_iter().map(|(file, _)| file).collect::<Vec<_>>();
            let mut node = DirectoryNode {
                dir: dir.into(),
                file_count: files.len(),
                function_count,
                files,
                smells: Vec::new(),
            };
            node.smells = smells_for_directory(&node, thresholds);
            let key = CollationInput::from_text(&node.dir)?;
            Ok((node, key))
        })
        .collect::<Result<_, CollationError>>()?;
    directories.sort_by(|left, right| collation.compare(&left.1, &right.1));
    Ok(directories.into_iter().map(|(node, _)| node).collect())
}
