//! Resolve import targets for the layer census, retaining real missing local imports.

use crate::{
    api::real_path,
    engine::oxc::{FileResolution, NearestTsconfigResolver, create_nearest_tsconfig_resolver},
    extract::package_exports::{package_name, package_source_entry_request, read_manifest},
    extract::wrangler_config::document::jsonc_recovered,
    project::{
        Collation, CollationError, dirname_path_text, discover_package_roots,
        find_nearest_tsconfig, join_path_text, relative_path_text_from,
    },
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
pub struct WorkspacePackage {
    pub name: JsString,
    pub dir: String,
    pub entry: Option<JsString>,
}
pub type WorkspacePackages = IndexMap<JsString, WorkspacePackage>;

pub fn workspace_packages(
    repo_root: &Path,
    package_dirs: &[String],
    collation: &Collation,
) -> Result<WorkspacePackages, CollationError> {
    workspace_packages_request(repo_root, package_dirs, &mut || Ok(collation))
}
pub(crate) fn workspace_packages_request<'c>(
    repo_root: &Path,
    package_dirs: &[String],
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<WorkspacePackages, CollationError> {
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
                entry: package_source_entry_request(repo_root, dir, request)?,
            },
        );
    }
    Ok(by_name)
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

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolvedTarget {
    File { file: JsString },
    Package { pkg: WorkspacePackage },
    External,
    Unresolved { specifier: JsString },
}

/// A resolver snapshots workspace packages at creation and caches tsconfig alias keys on use.
pub struct TargetResolver {
    root_text: JsString,
    real_root_text: JsString,
    packages: WorkspacePackages,
    nearest: NearestTsconfigResolver,
    keys_by_config: HashMap<PathBuf, Option<Vec<JsString>>>,
}

#[derive(Clone, Copy)]
enum ResolverRoot<'a> {
    Native(&'a Path),
    Text(&'a JsString),
}
#[derive(Debug)]
pub enum TargetResolverError {
    Io(io::Error),
    Collation(CollationError),
}
impl std::fmt::Display for TargetResolverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for TargetResolverError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Io(e) => e,
            Self::Collation(e) => e,
        })
    }
}
impl From<io::Error> for TargetResolverError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<CollationError> for TargetResolverError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
pub fn create_target_resolver(
    repo_root: &Path,
    collation: &Collation,
) -> Result<TargetResolver, TargetResolverError> {
    create(ResolverRoot::Native(repo_root), collation)
}
pub(super) fn create_target_resolver_text(
    repo_root: &JsString,
    collation: &Collation,
) -> Result<TargetResolver, TargetResolverError> {
    create(ResolverRoot::Text(repo_root), collation)
}
fn create(
    root: ResolverRoot<'_>,
    collation: &Collation,
) -> Result<TargetResolver, TargetResolverError> {
    let (repo_native, root_text) = match root {
        ResolverRoot::Native(path) => (
            path.to_path_buf(),
            JsString::from(path.to_string_lossy().as_ref()),
        ),
        ResolverRoot::Text(text) => (PathBuf::from(text.to_lossy()), text.clone()),
    };
    let packages = workspace_packages(
        &repo_native,
        &discover_package_roots(&repo_native, None),
        collation,
    )?;
    let real_root_text = match root {
        ResolverRoot::Native(path) => fs::canonicalize(path)?.to_string_lossy().as_ref().into(),
        ResolverRoot::Text(text) => real_path(text)?,
    };
    Ok(TargetResolver {
        root_text,
        real_root_text,
        packages,
        nearest: create_nearest_tsconfig_resolver(),
        keys_by_config: HashMap::new(),
    })
}

impl TargetResolver {
    pub fn resolve(
        &mut self,
        from_file: &JsString,
        specifier: &JsString,
    ) -> io::Result<ResolvedTarget> {
        if specifier.starts_with(".") {
            return self.resolve_relative(from_file, specifier);
        }
        if let Some(pkg) = match_package(specifier, &self.packages) {
            return Ok(ResolvedTarget::Package { pkg: pkg.clone() });
        }
        let absolute = join_path_text(&self.root_text, from_file);
        match self
            .nearest
            .resolve(Path::new(&absolute.to_lossy()), &specifier.to_lossy())
        {
            FileResolution::Path(path) => {
                let relative = relative_path_text_from(
                    &self.real_root_text,
                    &path.to_string_lossy().as_ref().into(),
                )?;
                let node_modules = JsString::from("node_modules");
                if relative
                    .units()
                    .split(|unit| *unit == 47)
                    .any(|part| part == node_modules.units())
                    || relative == ".."
                    || relative.starts_with("../")
                    || relative.starts_with("/")
                {
                    Ok(ResolvedTarget::External)
                } else {
                    Ok(ResolvedTarget::File { file: relative })
                }
            }
            FileResolution::Builtin => Ok(ResolvedTarget::External),
            FileResolution::Missing => {
                let directory = dirname_path_text(&absolute).to_lossy();
                let keys = find_nearest_tsconfig(Path::new(&directory))
                    .and_then(|config| self.alias_keys(&config, &mut HashSet::new()))
                    .unwrap_or_default();
                if keys.iter().any(|key| matches_paths_key(key, specifier)) {
                    Ok(ResolvedTarget::Unresolved {
                        specifier: specifier.clone(),
                    })
                } else {
                    Ok(ResolvedTarget::External)
                }
            }
        }
    }

    fn resolve_relative(
        &self,
        from_file: &JsString,
        specifier: &JsString,
    ) -> io::Result<ResolvedTarget> {
        let absolute = join_path_text(&self.root_text, from_file);
        let mut base = join_path_text(&dirname_path_text(&absolute), specifier);
        for suffix in [".js", ".jsx", ".mjs", ".cjs"] {
            let suffix: Vec<_> = suffix.encode_utf16().collect();
            if base.units().ends_with(&suffix) {
                base = JsString::from_units(
                    base.units()[..base.units().len() - suffix.len()].to_vec(),
                );
                break;
            }
        }
        for probe in [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx", ""] {
            let mut candidate = base.clone();
            candidate.push_str(probe);
            let native = candidate.to_lossy();
            let path = Path::new(&native);
            if path.exists() && fs::metadata(path)?.is_file() {
                return Ok(ResolvedTarget::File {
                    file: relative_path_text_from(&self.root_text, &candidate)?,
                });
            }
        }
        Ok(ResolvedTarget::Unresolved {
            specifier: specifier.clone(),
        })
    }

    fn alias_keys(
        &mut self,
        file: &Path,
        visiting: &mut HashSet<PathBuf>,
    ) -> Option<Vec<JsString>> {
        if let Some(cached) = self.keys_by_config.get(file) {
            return cached.clone();
        }
        if !visiting.insert(file.to_path_buf()) {
            return None;
        }
        let keys = read_tsconfig(file).and_then(|config| {
            if let Some(keys) = config.paths {
                return Some(keys);
            }
            for parent in config.extends.into_iter().rev() {
                let located = self
                    .nearest
                    .locate(file.parent().unwrap_or(file), &parent.to_lossy());
                if let Some(keys) = located.and_then(|located| self.alias_keys(&located, visiting))
                {
                    return Some(keys);
                }
            }
            None
        });
        visiting.remove(file);
        self.keys_by_config.insert(file.to_path_buf(), keys.clone());
        keys
    }
}

struct Tsconfig {
    extends: Vec<JsString>,
    paths: Option<Vec<JsString>>,
}

fn read_tsconfig(file: &Path) -> Option<Tsconfig> {
    let bytes = fs::read(file).ok()?;
    let document = jsonc_recovered(&String::from_utf8_lossy(&bytes))?;
    document.object()?;
    let extends = match document.get("extends") {
        None => Vec::new(),
        Some(value) if value.string().is_some() => vec![value.string()?.clone()],
        Some(value) => value
            .array()?
            .iter()
            .map(|value| value.string().cloned())
            .collect::<Option<_>>()?,
    };
    let options = document.get("compilerOptions");
    if let Some(options) = options {
        options.object()?;
    }
    let paths = match options.and_then(|options| options.get("paths")) {
        None => None,
        Some(paths) => Some(
            paths
                .record()
                .ok()??
                .entries()
                .filter(|(key, _)| *key != "__proto__")
                .map(|(key, _)| key.clone())
                .collect(),
        ),
    };
    Some(Tsconfig { extends, paths })
}

fn matches_paths_key(key: &JsString, specifier: &JsString) -> bool {
    let Some(star) = key.units().iter().position(|unit| *unit == b'*' as u16) else {
        return key == specifier;
    };
    let prefix = &key.units()[..star];
    let suffix = &key.units()[star + 1..];
    specifier.units().len() >= prefix.len() + suffix.len()
        && specifier.units().starts_with(prefix)
        && specifier.units().ends_with(suffix)
}
