use super::export_names_by_id;
use crate::extract::functions::DiscoveredFunction;
use crate::kinds::conventions::{compile_conventions, matching_conventions};
use crate::kinds::glob::GlobError;
use crate::kinds::presets::{entry_export_preset, entry_export_preset_names};
use crate::kinds::rules::NodeKindRules;
use crate::project::{Collation, CollationError, to_relative};
use crate::text::{JsString, JsValue};
use indexmap::{IndexMap, IndexSet};
use std::{
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

struct OwningPackage {
    dir: PathBuf,
    dependencies: IndexSet<JsString>,
}
fn read_dependencies(manifest: &Path) -> IndexSet<JsString> {
    let Some(value) = fs::read(manifest)
        .ok()
        .and_then(|bytes| JsValue::parse(&String::from_utf8_lossy(&bytes)).ok())
    else {
        return IndexSet::new();
    };
    let mut names = IndexSet::new();
    for group in ["dependencies", "devDependencies"] {
        if let Some(object) = value.get(group).and_then(JsValue::as_object) {
            names.extend(object.keys().cloned());
        }
    }
    names
}
fn locate(
    dir: &Path,
    repo: &Path,
    fallback: &Rc<OwningPackage>,
    cache: &mut IndexMap<PathBuf, Rc<OwningPackage>>,
) -> Rc<OwningPackage> {
    if let Some(cached) = cache.get(dir) {
        return cached.clone();
    }
    let manifest = dir.join("package.json");
    let parent = dir.parent().unwrap_or(dir);
    let found = if manifest.exists() {
        Rc::new(OwningPackage {
            dir: dir.into(),
            dependencies: read_dependencies(&manifest),
        })
    } else if dir == repo || parent == dir || to_relative(repo, dir).starts_with("..") {
        fallback.clone()
    } else {
        locate(parent, repo, fallback, cache)
    };
    cache.insert(dir.into(), found.clone());
    found
}
#[derive(Debug)]
pub enum ConventionEntriesError {
    Pattern(GlobError),
    Collation(CollationError),
}
impl std::fmt::Display for ConventionEntriesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pattern(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for ConventionEntriesError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Pattern(e) => e,
            Self::Collation(e) => e,
        })
    }
}
impl From<GlobError> for ConventionEntriesError {
    fn from(error: GlobError) -> Self {
        Self::Pattern(error)
    }
}
impl From<CollationError> for ConventionEntriesError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
pub fn convention_entries(
    functions: &[DiscoveredFunction],
    rules: &NodeKindRules,
    root: &Path,
    repo: &Path,
    collation: &Collation,
) -> Result<IndexMap<String, Vec<JsString>>, ConventionEntriesError> {
    let export_names = export_names_by_id(functions, collation)?;
    let user = compile_conventions(&rules.entry_export_conventions)?;
    let presets: Vec<_> = entry_export_preset_names()
        .into_iter()
        .map(|name| {
            let preset = entry_export_preset(name);
            compile_conventions(&preset.conventions)
                .map(|compiled| (name, preset.dependency, compiled))
        })
        .collect::<Result<_, _>>()?;
    let mut packages = IndexMap::new();
    let fallback = Rc::new(OwningPackage {
        dir: root.into(),
        dependencies: IndexSet::new(),
    });
    let mut out = IndexMap::new();
    for function in functions {
        let Some(names) = export_names.get(&function.id).filter(|_| !function.is_test) else {
            continue;
        };
        let absolute = root.join(&function.file);
        let pkg = locate(
            absolute.parent().unwrap_or(&absolute),
            repo,
            &fallback,
            &mut packages,
        );
        let package_path = JsString::from(to_relative(&pkg.dir, &absolute));
        let mut matched: IndexSet<_> = matching_conventions(&user, &package_path, names)
            .into_iter()
            .collect();
        for (name, dependency, compiled) in &presets {
            if rules.entry_export_presets.contains(name)
                || pkg
                    .dependencies
                    .contains(&JsString::from(dependency.as_str()))
            {
                matched.extend(matching_conventions(compiled, &package_path, names));
            }
        }
        if !matched.is_empty() {
            let mut matched: Vec<_> = matched.into_iter().collect();
            matched.sort_by(|left, right| {
                crate::project::locale_compare_units(left.units(), right.units())
            });
            out.insert(function.id.clone(), matched);
        }
    }
    Ok(out)
}
