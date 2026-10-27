//! Repository visibility and TypeScript source discovery.

use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::LazyLock;

use crate::engine::oxc::{ParseFailure, parse_type_script};
use crate::syntax::SyntaxFile;
use crate::text::JsString;
use icu_collator::{Collator, CollatorBorrowed};

mod collation;
mod text_paths;
pub use collation::{Collation, CollationError, CollationInput};
pub(crate) use text_paths::{
    basename_path_text, dirname_path_text, join_path_text, normalize_path_text, relative_path_text,
    relative_path_text_from, resolve_path_text, resolve_path_text_from,
};

static FILE_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), Default::default())
        .expect("compiled root collation is available")
});

pub(crate) fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    FILE_COLLATOR.compare(left, right)
}

pub(crate) fn locale_compare_units(left: &[u16], right: &[u16]) -> std::cmp::Ordering {
    FILE_COLLATOR.compare_utf16(left, right)
}

const WALK_PRUNE: &[&str] = &[
    ".claude",
    ".git",
    ".next",
    ".turbo",
    ".wrangler",
    "__generated__",
    "coverage",
    "dist",
    "node_modules",
    "vendor",
];
const EXCLUDED_SEGMENTS: &[&str] = &["node_modules", "vendor", "dist", ".next", "__generated__"];

fn git_visible_files(root: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|file| !file.is_empty() && !file.ends_with('/'))
            .map(str::to_owned)
            .collect(),
    )
}

fn walked_files(root: &Path) -> Vec<String> {
    fn walk(directory: &Path, relative: &str, found: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if kind.is_dir() {
                if !WALK_PRUNE.contains(&name.as_str()) {
                    walk(&entry.path(), &relative, found);
                }
            } else if kind.is_file() {
                found.push(relative);
            }
        }
    }
    let mut found = Vec::new();
    walk(root, "", &mut found);
    found
}

fn source_file(relative: &str) -> bool {
    (relative.ends_with(".ts") || relative.ends_with(".tsx"))
        && !relative.ends_with(".d.ts")
        && !relative.ends_with(".gen.ts")
        && !relative
            .split('/')
            .any(|segment| segment.starts_with('.') || EXCLUDED_SEGMENTS.contains(&segment))
}

/// A single visibility snapshot reusable by multiple package scopes.
#[derive(Debug, Clone)]
pub struct RepoListing {
    pub root: PathBuf,
    pub files: Vec<String>,
}

pub fn list_repo(root: &Path) -> RepoListing {
    RepoListing {
        root: root.to_path_buf(),
        files: git_visible_files(root).unwrap_or_else(|| walked_files(root)),
    }
}

pub(crate) fn absolute_lexical(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .expect("current directory is unavailable")
            .join(path)
    };
    normalize_lexical(&absolute)
}

pub(crate) fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some_and(|name| name != "..") {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push("..");
                }
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        normalized.push(".");
    }
    normalized
}

/// Lexical, POSIX-separated relative path, including paths that do not exist.
pub fn to_relative(root: &Path, path: &Path) -> String {
    let root = absolute_lexical(root);
    let path = absolute_lexical(path);
    let root_components: Vec<_> = root.components().collect();
    let path_components: Vec<_> = path.components().collect();
    if root_components.first() != path_components.first() {
        return path.to_string_lossy().replace('\\', "/");
    }
    let common = root_components
        .iter()
        .zip(&path_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = vec!["..".to_owned(); root_components.len() - common];
    relative.extend(
        path_components[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    relative.join("/")
}

/// Existing visible files below a scope. The predicate receives relative POSIX paths.
pub fn list_visible_files(
    root: &Path,
    mut keep: impl FnMut(&str) -> bool,
    listing: Option<&RepoListing>,
) -> Vec<String> {
    let mut files = match listing {
        None => list_repo(root).files,
        Some(listing) => {
            let prefix = to_relative(&listing.root, root);
            if prefix.is_empty() {
                listing.files.clone()
            } else {
                let prefix = format!("{prefix}/");
                listing
                    .files
                    .iter()
                    .filter_map(|file| file.strip_prefix(&prefix).map(str::to_owned))
                    .collect()
            }
        }
    };
    files.retain(|file| keep(file) && normalize_lexical(&root.join(file)).is_file());
    files.sort_by(|left, right| FILE_COLLATOR.compare(left, right));
    files
}

/// Package manifest directories under the selected scope, always including the scope itself.
pub fn discover_package_roots(root: &Path, listing: Option<&RepoListing>) -> Vec<String> {
    let mut roots = vec![String::new()];
    for file in list_visible_files(
        root,
        |file| file.rsplit('/').next() == Some("package.json"),
        listing,
    ) {
        if file
            .split('/')
            .any(|segment| EXCLUDED_SEGMENTS.contains(&segment))
        {
            continue;
        }
        roots.push(
            file.rsplit_once('/')
                .map_or("", |(directory, _)| directory)
                .to_owned(),
        );
    }
    roots.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    roots.dedup();
    roots
}

/// Existing, Git-visible `.ts` and `.tsx` files, excluding declarations and generated files.
/// Outside Git, the directory walk prunes build and dependency directories.
pub fn list_source_files(root: &Path) -> Vec<PathBuf> {
    list_visible_files(root, source_file, None)
        .into_iter()
        .map(|file| normalize_lexical(&root.join(file)))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeScope {
    Package,
    Deep,
}

#[derive(Debug)]
pub struct MissingTsConfig {
    pub start: PathBuf,
    pub scope: EdgeScope,
    message: JsString,
}
impl MissingTsConfig {
    fn new(start: &Path, scope: EdgeScope, root_text: Option<&JsString>) -> Self {
        let display = root_text
            .cloned()
            .unwrap_or_else(|| start.to_string_lossy().as_ref().into());
        let mut message = JsString::from("code-graph: no tsconfig.json found ");
        match scope {
            EdgeScope::Package => message.push_str("at or above "),
            EdgeScope::Deep => message.push_str("at or above the repo root ("),
        }
        message.extend(&display);
        if scope == EdgeScope::Deep {
            message.push_str(")");
        }
        message.push_str("; the edge pass needs one to resolve modules (SPEC §3).");
        Self {
            start: start.to_path_buf(),
            scope,
            message,
        }
    }
    pub fn message(&self) -> &JsString {
        &self.message
    }
}
impl fmt::Display for MissingTsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message.to_lossy())
    }
}

impl std::error::Error for MissingTsConfig {}

pub fn find_nearest_tsconfig(start: &Path) -> Option<PathBuf> {
    for directory in start.ancestors() {
        let candidate = directory.join("tsconfig.json");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

pub fn resolve_edge_ts_config(
    root: &Path,
    scope: EdgeScope,
    repo_root: &Path,
) -> Result<PathBuf, MissingTsConfig> {
    resolve_edge_ts_config_in(root, scope, repo_root, None)
}
pub fn resolve_edge_ts_config_text(
    root: &JsString,
    scope: EdgeScope,
    repo_root: &Path,
) -> Result<JsString, MissingTsConfig> {
    let native_root = root.to_lossy();
    let selected =
        resolve_edge_ts_config_in(Path::new(&native_root), scope, repo_root, Some(root))?;
    let start = match scope {
        EdgeScope::Package => root.clone(),
        EdgeScope::Deep => repo_root.to_string_lossy().as_ref().into(),
    };
    Ok(selected_config_text(&start, &selected))
}
pub(crate) fn selected_config_text(start: &JsString, selected: &Path) -> JsString {
    let relative = to_relative(Path::new(&start.to_lossy()), selected);
    join_path_text(start, &relative.into())
}
fn resolve_edge_ts_config_in(
    root: &Path,
    scope: EdgeScope,
    repo_root: &Path,
    root_text: Option<&JsString>,
) -> Result<PathBuf, MissingTsConfig> {
    let start = match scope {
        EdgeScope::Package => root,
        EdgeScope::Deep => repo_root,
    };
    let display = match scope {
        EdgeScope::Package => root_text,
        EdgeScope::Deep => None,
    };
    find_nearest_tsconfig(start).ok_or_else(|| MissingTsConfig::new(start, scope, display))
}

fn workspace_root_index(ancestors: impl Iterator<Item = PathBuf>) -> Option<usize> {
    ancestors.enumerate().find_map(|(index, directory)| {
        directory
            .join("pnpm-workspace.yaml")
            .exists()
            .then_some(index)
    })
}

/// The nearest pnpm workspace root; a standalone scope retains its own root.
pub fn find_repo_root(start: &Path) -> PathBuf {
    workspace_root_index(start.ancestors().map(Path::to_path_buf))
        .and_then(|index| start.ancestors().nth(index))
        .unwrap_or(start)
        .to_path_buf()
}

/// Resolve the same workspace marker while retaining the caller's JavaScript path text.
pub fn find_repo_root_text(start: &JsString) -> JsString {
    let ancestors: Vec<_> = std::iter::successors(Some(start.clone()), |directory| {
        let parent = dirname_path_text(directory);
        (parent != *directory).then_some(parent)
    })
    .collect();
    workspace_root_index(
        ancestors
            .iter()
            .map(|directory| PathBuf::from(directory.to_lossy())),
    )
    .map_or_else(|| start.clone(), |index| ancestors[index].clone())
}

#[derive(Debug)]
pub struct SourceUnit {
    pub absolute_path: PathBuf,
    pub file: String,
    pub syntax: SyntaxFile,
}

#[derive(Debug)]
pub struct LoadedProject {
    pub root_absolute: PathBuf,
    pub source_files: Vec<Rc<SourceUnit>>,
    pub parse_failures: Vec<String>,
}

pub fn load_cheap_project(
    root: &Path,
    listing: Option<&RepoListing>,
) -> Result<LoadedProject, ParseFailure> {
    let mut source_files = Vec::new();
    let mut parse_failures = Vec::new();
    for file in list_visible_files(root, source_file, listing) {
        let absolute_path = normalize_lexical(&root.join(&file));
        let Ok(bytes) = fs::read(&absolute_path) else {
            parse_failures.push(file);
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        match parse_type_script(&absolute_path, text) {
            Ok(syntax) => source_files.push(Rc::new(SourceUnit {
                absolute_path,
                file,
                syntax,
            })),
            Err(ParseFailure::Syntax(_)) => parse_failures.push(file),
            Err(error) => return Err(error),
        }
    }
    parse_failures.sort_by(|left, right| FILE_COLLATOR.compare(left, right));
    Ok(LoadedProject {
        root_absolute: root.to_path_buf(),
        source_files,
        parse_failures,
    })
}

#[derive(Debug)]
pub struct LoadedEdgeProject {
    pub project: LoadedProject,
    pub ts_config_path: PathBuf,
    pub scope: EdgeScope,
}

#[derive(Debug)]
pub enum ProjectLoadError {
    MissingTsConfig(MissingTsConfig),
    Parse(ParseFailure),
}
impl ProjectLoadError {
    pub fn message(&self) -> JsString {
        match self {
            Self::MissingTsConfig(error) => error.message().clone(),
            Self::Parse(error) => error.to_string().into(),
        }
    }
}

impl fmt::Display for ProjectLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTsConfig(error) => error.fmt(formatter),
            Self::Parse(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for ProjectLoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::MissingTsConfig(error) => error,
            Self::Parse(error) => error,
        })
    }
}

pub fn load_edge_project(
    root: &Path,
    scope: EdgeScope,
    repo_root: &Path,
    listing: Option<&RepoListing>,
) -> Result<LoadedEdgeProject, ProjectLoadError> {
    load_edge_project_in(root, scope, repo_root, listing, None)
}

/// Load a declared JavaScript root, retaining its text in source-owned refusals.
/// UTF-16 replacement is limited to the filesystem path, as in Node's string path boundary.
pub fn load_edge_project_text(
    root: &JsString,
    scope: EdgeScope,
    repo_root: &Path,
    listing: Option<&RepoListing>,
) -> Result<LoadedEdgeProject, ProjectLoadError> {
    let native = PathBuf::from(root.to_lossy());
    load_edge_project_in(&native, scope, repo_root, listing, Some(root))
}

fn load_edge_project_in(
    root: &Path,
    scope: EdgeScope,
    repo_root: &Path,
    listing: Option<&RepoListing>,
    root_text: Option<&JsString>,
) -> Result<LoadedEdgeProject, ProjectLoadError> {
    let ts_config_path = resolve_edge_ts_config_in(root, scope, repo_root, root_text)
        .map_err(ProjectLoadError::MissingTsConfig)?;
    let project = load_cheap_project(root, listing).map_err(ProjectLoadError::Parse)?;
    Ok(LoadedEdgeProject {
        project,
        ts_config_path,
        scope,
    })
}
