//! Workspace package names; filesystem and tsconfig target resolution are separate.

use crate::{
    extract::package_exports::{package_name, package_source_entry, read_manifest},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct WorkspacePackage {
    pub name: JsString,
    pub dir: String,
    pub entry: Option<JsString>,
}
pub type WorkspacePackages = IndexMap<JsString, WorkspacePackage>;

pub fn workspace_packages(repo_root: &Path, package_dirs: &[String]) -> WorkspacePackages {
    let mut by_name = IndexMap::new();
    for dir in package_dirs {
        if dir.is_empty() {
            continue;
        }
        let Some(manifest) = read_manifest(repo_root, dir) else {
            continue;
        };
        let Some(name) = package_name(&manifest) else {
            continue;
        };
        if by_name.contains_key(name) {
            continue;
        }
        by_name.insert(
            name.clone(),
            WorkspacePackage {
                name: name.clone(),
                dir: dir.clone(),
                entry: package_source_entry(repo_root, dir),
            },
        );
    }
    by_name
}
pub fn match_package<'a>(
    specifier: &JsString,
    packages: &'a WorkspacePackages,
) -> Option<&'a WorkspacePackage> {
    if let Some(direct) = packages.get(specifier) {
        return Some(direct);
    }
    let mut parts = specifier.units().split(|unit| *unit == 47);
    let first = parts.next().unwrap_or_default();
    let mut head = first.to_vec();
    if specifier.starts_with("@")
        && let Some(second) = parts.next()
    {
        head.push(47);
        head.extend_from_slice(second);
    }
    packages.get(&JsString::from_units(head))
}
