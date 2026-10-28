use super::export_names_by_id;
use crate::extract::functions::DiscoveredFunction;
use crate::kinds::conventions::{compile_conventions, matching_conventions};
use crate::kinds::presets::{entry_export_preset, entry_export_preset_names};
use crate::kinds::rules::NodeKindRules;
use crate::project::{Collation, CollationInput, to_relative};
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
pub use crate::kinds::conventions::ConventionError as ConventionEntriesError;
pub fn convention_entries(
    functions: &[DiscoveredFunction],
    rules: &NodeKindRules,
    root: &Path,
    repo: &Path,
    collation: &Collation,
) -> Result<IndexMap<String, Vec<JsString>>, ConventionEntriesError> {
    let export_names = export_names_by_id(functions, collation)?;
    let user = compile_conventions(&rules.entry_export_conventions, collation)?;
    let presets: Vec<_> = entry_export_preset_names()
        .into_iter()
        .map(|name| {
            let preset = entry_export_preset(name);
            compile_conventions(&preset.conventions, collation)
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
        let mut matched: IndexSet<_> =
            matching_conventions(&user, &package_path, names, collation)?
                .into_iter()
                .collect();
        for (name, dependency, compiled) in &presets {
            if rules.entry_export_presets.contains(name)
                || pkg
                    .dependencies
                    .contains(&JsString::from(dependency.as_str()))
            {
                matched.extend(matching_conventions(
                    compiled,
                    &package_path,
                    names,
                    collation,
                )?);
            }
        }
        if !matched.is_empty() {
            let mut matched = matched
                .into_iter()
                .map(|value| CollationInput::from_utf16(value.units()).map(|key| (value, key)))
                .collect::<Result<Vec<_>, _>>()?;
            matched.sort_by(|a, b| collation.compare(&a.1, &b.1));
            out.insert(
                function.id.clone(),
                matched.into_iter().map(|(value, _)| value).collect(),
            );
        }
    }
    Ok(out)
}
