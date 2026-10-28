use super::rules::{BoundaryRules, ImportedFrom, LibraryType, declares_libraries, interpolate};
use crate::{
    kinds::{
        glob::{GlobError, glob_to_regexp},
        rules::JsRegex,
    },
    layers::resolve_target::{WorkspacePackages, match_package, workspace_packages_request},
    project::{
        Collation, CollationError, RepoListing, discover_package_roots, join_path_text, list_repo,
        locale_compare, normalize_path_text,
    },
    text::{JsString, object_keys},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::path::Path;

pub mod allowance;
pub mod census;
pub mod violations;

#[derive(Debug, Clone, Copy)]
pub enum LibraryRuleError {
    InheritedType,
    InheritedLicense,
    NullLicense,
    RestrictedFunctionProperty,
}
impl LibraryRuleError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InheritedType => "Cannot read properties of undefined (reading 'includes')",
            Self::InheritedLicense => "licensed.includes is not a function",
            Self::NullLicense => "Cannot read properties of null (reading 'includes')",
            Self::RestrictedFunctionProperty => crate::text::RESTRICTED_FUNCTION_PROPERTY_MESSAGE,
        }
    }
}
impl std::fmt::Display for LibraryRuleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}
impl std::error::Error for LibraryRuleError {}

#[derive(Debug, Default)]
pub struct Libraries<'a> {
    rules: Option<&'a BoundaryRules>,
    pub dirs: Vec<String>,
    pub type_of_dir: IndexMap<String, &'a JsString>,
    pub packages: WorkspacePackages,
    pub package_dirs: Vec<String>,
    world: Vec<JsRegex>,
}
impl<'a> Libraries<'a> {
    pub fn declared(&self) -> bool {
        self.rules.is_some()
    }
    pub fn rules(&self) -> Option<&'a BoundaryRules> {
        self.rules
    }
}
#[derive(Debug)]
pub enum LibrariesRead<'a> {
    Read(Libraries<'a>),
    Refused { message: JsString },
}
#[derive(Debug)]
pub enum LibraryReadError {
    Pattern(GlobError),
    Collation(CollationError),
}
impl std::fmt::Display for LibraryReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pattern(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for LibraryReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Pattern(e) => e,
            Self::Collation(e) => e,
        })
    }
}
impl From<GlobError> for LibraryReadError {
    fn from(error: GlobError) -> Self {
        Self::Pattern(error)
    }
}
impl From<CollationError> for LibraryReadError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
pub fn read_libraries<'a>(
    rules: &'a BoundaryRules,
    repo_root: &Path,
    listing: Option<&RepoListing>,
    collation: &Collation,
) -> Result<LibrariesRead<'a>, LibraryReadError> {
    read_libraries_request(rules, repo_root, listing, &mut || Ok(collation))
}
pub(crate) fn read_libraries_request<'a, 'c>(
    rules: &'a BoundaryRules,
    repo_root: &Path,
    listing: Option<&RepoListing>,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<LibrariesRead<'a>, LibraryReadError> {
    if !declares_libraries(rules) {
        return Ok(LibrariesRead::Read(Libraries::default()));
    }
    let owned;
    let files = match listing {
        Some(listing) => listing,
        None => {
            owned = list_repo(repo_root);
            &owned
        }
    };
    let package_dirs: Vec<_> = discover_package_roots(repo_root, Some(files))
        .into_iter()
        .filter(|dir| !dir.is_empty())
        .collect();
    let known: IndexSet<JsString> = package_dirs.iter().map(|dir| dir.as_str().into()).collect();
    let root_text: JsString = repo_root.to_string_lossy().as_ref().into();
    let mut issues = Vec::new();
    for root in &rules.library_roots {
        let clean = normalize_path_text(root) == *root
            && !root.starts_with("..")
            && root.units().last() != Some(&47);
        if !clean || !Path::new(&join_path_text(&root_text, root).to_lossy()).is_dir() {
            issues.push(interpolate(&[
                "libraryRoots entry \"".into(),
                root.clone(),
                "\" is no directory of the repo: write a repo-relative path such as packages."
                    .into(),
            ]));
        }
    }
    for dir in object_keys(&rules.libraries) {
        if !known.contains(dir) {
            issues.push(interpolate(&["library \"".into(),dir.clone(),"\" is no package root: a library is a directory below the repo root that holds a package.json.".into()]));
        }
    }
    if let Some(message) = issues.into_iter().next() {
        return Ok(LibrariesRead::Refused { message });
    }
    let type_of_dir: IndexMap<_, _> = object_keys(&rules.libraries)
        .into_iter()
        .map(|dir| {
            (
                dir.to_utf8().expect("a known package directory is UTF-8"),
                &rules.libraries[dir],
            )
        })
        .collect();
    let mut dirs: Vec<_> = type_of_dir.keys().cloned().collect();
    dirs.sort_by_key(|dir| std::cmp::Reverse(dir.encode_utf16().count()));
    Ok(LibrariesRead::Read(Libraries {
        rules: Some(rules),
        dirs,
        type_of_dir,
        packages: workspace_packages_request(repo_root, &package_dirs, request)?,
        package_dirs,
        world: rules
            .world_libraries
            .iter()
            .map(glob_to_regexp)
            .collect::<Result<_, _>>()?,
    }))
}
pub fn library_scopes(libraries: &Libraries<'_>) -> Vec<JsString> {
    libraries
        .dirs
        .iter()
        .map(|dir| dir.as_str().into())
        .chain(
            libraries
                .rules
                .into_iter()
                .flat_map(|rules| rules.library_roots.iter().cloned()),
        )
        .collect()
}
pub fn library_type_of<'a>(
    libraries: &'a Libraries<'_>,
    dir: &JsString,
) -> Option<&'a LibraryType> {
    let dir = dir.to_utf8().ok()?;
    let name = libraries.type_of_dir.get(&dir)?;
    libraries.rules?.library_types.get(*name)
}
pub fn owner_of<'a>(libraries: &'a Libraries<'_>, file: &JsString) -> Option<&'a str> {
    libraries
        .dirs
        .iter()
        .find(|dir| file.starts_with(&format!("{dir}/")))
        .map(String::as_str)
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ImportTarget<'a> {
    Library {
        dir: &'a str,
        #[serde(rename = "type")]
        type_name: &'a JsString,
    },
    Undeclared {
        dir: &'a str,
    },
    Outside,
}
pub fn import_target_of<'a>(
    libraries: &'a Libraries<'_>,
    specifier: &JsString,
) -> ImportTarget<'a> {
    let Some(package) = match_package(specifier, &libraries.packages) else {
        return ImportTarget::Outside;
    };
    match libraries.type_of_dir.get(&package.dir) {
        Some(type_name) => ImportTarget::Library {
            dir: &package.dir,
            type_name,
        },
        None => ImportTarget::Undeclared { dir: &package.dir },
    }
}
pub fn in_package_globs(globs: &[JsRegex], specifier: &JsString) -> bool {
    if specifier.starts_with(".") || specifier.starts_with("/") {
        return false;
    }
    let units = specifier.units();
    let mut ends = units
        .iter()
        .enumerate()
        .filter_map(|(index, unit)| (*unit == 47).then_some(index))
        .collect::<Vec<_>>();
    ends.push(units.len());
    ends.into_iter().any(|end| {
        let head = JsString::from_units(units[..end].to_vec());
        globs.iter().any(|glob| glob.test(&head))
    })
}
pub fn is_world_library(libraries: &Libraries<'_>, specifier: &JsString) -> bool {
    in_package_globs(&libraries.world, specifier)
}
pub fn imported_from_outside(
    libraries: &Libraries<'_>,
    dir: &JsString,
    zone: Option<ImportedFrom>,
) -> bool {
    let Some(zones) = library_type_of(libraries, dir).and_then(|kind| kind.imported_from.as_ref())
    else {
        return false;
    };
    !zones.contains(&ImportedFrom::Any) && zone.is_none_or(|zone| !zones.contains(&zone))
}
fn root_of<'a>(libraries: &'a Libraries<'_>, dir: &str) -> Option<&'a JsString> {
    let mut nearest: Option<&JsString> = None;
    for root in &libraries.rules?.library_roots {
        let below = root == "."
            || JsString::from(dir)
                .units()
                .starts_with(&root.units().iter().copied().chain([47]).collect::<Vec<_>>());
        if !below {
            continue;
        }
        let depth = |root: &JsString| {
            if root == "." {
                0
            } else {
                root.units().iter().filter(|unit| **unit == 47).count() + 1
            }
        };
        if nearest.is_none_or(|old| depth(root) > depth(old)) {
            nearest = Some(root);
        }
    }
    nearest
}
pub fn undeclared_under(libraries: &Libraries<'_>, root: &JsString) -> Vec<String> {
    let mut dirs = libraries
        .package_dirs
        .iter()
        .filter(|dir| {
            !libraries.type_of_dir.contains_key(*dir) && root_of(libraries, dir) == Some(root)
        })
        .cloned()
        .collect::<Vec<_>>();
    dirs.sort_by(|a, b| locale_compare(a, b));
    dirs
}
