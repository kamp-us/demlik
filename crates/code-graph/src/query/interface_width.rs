use crate::extract::references::ReferenceResult;
use crate::project::locale_compare;
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
) -> Vec<PackageWidth> {
    let mut by_package: IndexMap<String, Vec<ExportWidth>> = IndexMap::new();
    for node in functions {
        if !node.is_exported || node.is_test {
            continue;
        }
        let package = package_of(&node.file, package_dirs);
        let mut external_consumers: Vec<_> = refs
            .identifier_files
            .get(&node.name)
            .into_iter()
            .flatten()
            .filter(|file| **file != node.file && package_of(file, package_dirs) != package)
            .cloned()
            .collect();
        external_consumers.sort_by(|left, right| locale_compare(left, right));
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
    let mut packages: Vec<_> = by_package
        .into_iter()
        .map(|(package, mut exports)| {
            exports.sort_by(|left, right| locale_compare(&left.id, &right.id));
            PackageWidth {
                package,
                export_count: exports.len(),
                zero_consumer_count: exports
                    .iter()
                    .filter(|row| row.external_consumers.is_empty())
                    .count(),
                exports,
            }
        })
        .collect();
    packages.sort_by(|left, right| {
        right
            .export_count
            .cmp(&left.export_count)
            .then_with(|| locale_compare(&left.package, &right.package))
    });
    packages
}
