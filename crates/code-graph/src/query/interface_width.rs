use crate::extract::references::ReferenceResult;
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{ExportWidth, FunctionNode, PackageWidth};
use indexmap::IndexMap;

pub fn package_of<'a>(file: &str, package_dirs: &'a [String]) -> &'a str {
    let mut best = "";
    for dir in package_dirs {
        if !dir.is_empty()
            && (file == dir
                || file
                    .strip_prefix(dir)
                    .is_some_and(|tail| tail.starts_with('/')))
            && dir.encode_utf16().count() > best.encode_utf16().count()
        {
            best = dir;
        }
    }
    best
}
pub fn find_interface_width(
    functions: &[FunctionNode],
    refs: &ReferenceResult,
    package_dirs: &[String],
    collation: &Collation,
) -> Result<Vec<PackageWidth>, CollationError> {
    let mut by_package: IndexMap<String, Vec<ExportWidth>> = IndexMap::new();
    for node in functions {
        if !node.is_exported || node.is_test {
            continue;
        }
        let package = package_of(&node.file, package_dirs);
        let external_consumers: Vec<_> = refs
            .identifier_files
            .get(&node.name)
            .into_iter()
            .flatten()
            .filter(|file| **file != node.file && package_of(file, package_dirs) != package)
            .cloned()
            .collect();
        let mut external_consumers = external_consumers
            .into_iter()
            .map(|file| CollationInput::from_text(&file).map(|key| (file, key)))
            .collect::<Result<Vec<_>, _>>()?;
        external_consumers.sort_by(|left, right| collation.compare(&left.1, &right.1));
        let external_consumers = external_consumers
            .into_iter()
            .map(|(file, _)| file)
            .collect();
        by_package
            .entry(package.into())
            .or_default()
            .push(ExportWidth {
                id: node.id.clone(),
                name: node.name.clone(),
                file: node.file.clone(),
                start_line: node.start_line,
                external_consumers,
            });
    }
    let packages: Vec<_> = by_package
        .into_iter()
        .map(|(package, exports)| {
            let mut exports = exports
                .into_iter()
                .map(|row| CollationInput::from_text(&row.id).map(|key| (row, key)))
                .collect::<Result<Vec<_>, _>>()?;
            exports.sort_by(|left, right| collation.compare(&left.1, &right.1));
            let exports: Vec<_> = exports.into_iter().map(|(row, _)| row).collect();
            Ok(PackageWidth {
                package,
                export_count: exports.len(),
                zero_consumer_count: exports
                    .iter()
                    .filter(|row| row.external_consumers.is_empty())
                    .count(),
                exports,
            })
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    let mut packages = packages
        .into_iter()
        .map(|row| CollationInput::from_text(&row.package).map(|key| (row, key)))
        .collect::<Result<Vec<_>, _>>()?;
    packages.sort_by(|left, right| {
        right
            .0
            .export_count
            .cmp(&left.0.export_count)
            .then_with(|| collation.compare(&left.1, &right.1))
    });
    Ok(packages.into_iter().map(|(row, _)| row).collect())
}
