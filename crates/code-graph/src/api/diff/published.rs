use crate::{
    api::{
        base::{BaseTree, checkout_of, export_base_tree_blocking, remove_base_tree, resolve_base},
        diff::diff_subpath_names,
        map::{ApiError, ApiSubpath, api_subpaths, base_api_subpaths},
        model::{ApiDiff, EmittedNames, SubpathNames},
        package_root, project_relative,
        view::{PublishedApiOptions, read_emitted_names},
    },
    engine::tsgo::TsgoBinary,
    project::join_path_text,
    text::{JsString, JsValue},
};
use indexmap::IndexMap;
use std::{collections::HashSet, fs, path::Path};

struct BaseTreeGuard {
    tree: Option<BaseTree>,
}
impl BaseTreeGuard {
    fn new(tree: BaseTree) -> Self {
        Self { tree: Some(tree) }
    }
    fn tree(&self) -> &BaseTree {
        self.tree.as_ref().expect("live base tree")
    }
    fn finish<T>(mut self, result: Result<T, ApiError>) -> Result<T, ApiError> {
        let tree = self.tree.take().expect("live base tree");
        match (result, remove_base_tree(&tree.temp)) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(operation), Err(cleanup)) => Err(ApiError::OperationAndCleanup {
                operation: Box::new(operation),
                cleanup: Box::new(cleanup),
            }),
        }
    }
}
impl Drop for BaseTreeGuard {
    fn drop(&mut self) {
        if let Some(tree) = self.tree.take() {
            let _ = remove_base_tree(&tree.temp);
        }
    }
}

struct BaseSide {
    subpaths: Vec<ApiSubpath>,
    names: IndexMap<JsString, SubpathNames>,
}
fn read_side(
    root: &JsString,
    parts: &[ApiSubpath],
    compiler: &TsgoBinary,
    options: &mut PublishedApiOptions<'_>,
    repo_root: Option<&JsString>,
    context: Option<&JsString>,
) -> Result<EmittedNames, ApiError> {
    // The short forwarding borrow keeps the original local callback for the next
    // side without adding Send/static bounds or replacing its captured state.
    match options.warn.as_mut() {
        Some(warn) => {
            let mut forward = |message: &JsString| warn(message);
            read_emitted_names(
                root,
                parts,
                compiler,
                PublishedApiOptions {
                    repo_root,
                    warn: Some(&mut forward),
                },
                context,
            )
        }
        None => read_emitted_names(
            root,
            parts,
            compiler,
            PublishedApiOptions {
                repo_root,
                warn: None,
            },
            context,
        ),
    }
}
fn subpaths_at_base(root: &JsString, parts: &[ApiSubpath]) -> Result<Vec<ApiSubpath>, ApiError> {
    let mut present = Vec::new();
    for part in parts {
        let absolute = join_path_text(root, &part.entry);
        let path = absolute.to_lossy();
        if Path::new(&path).exists()
            && fs::metadata(&path)
                .map_err(|source| ApiError::Io {
                    path: absolute.clone(),
                    source,
                })?
                .is_file()
        {
            present.push(ApiSubpath {
                subpath: part.subpath.clone(),
                entry: part.entry.clone(),
                entry_absolute: absolute,
                tier: part.tier.clone(),
            });
        }
    }
    Ok(present)
}
fn read_present(
    guard: &BaseTreeGuard,
    sha: &JsString,
    present: Vec<ApiSubpath>,
    compiler: &TsgoBinary,
    options: &mut PublishedApiOptions<'_>,
) -> Result<BaseSide, ApiError> {
    if present.is_empty() {
        return Ok(BaseSide {
            subpaths: present,
            names: IndexMap::new(),
        });
    }
    let mut context = JsString::from(" at the base ");
    context.extend(&JsString::from_units(
        sha.units()[..sha.units().len().min(12)].to_vec(),
    ));
    let names = read_side(
        &guard.tree().root,
        &present,
        compiler,
        options,
        Some(&guard.tree().temp),
        Some(&context),
    )?
    .names;
    Ok(BaseSide {
        subpaths: present,
        names,
    })
}
fn assemble(
    root: &JsString,
    sha: JsString,
    parts: Vec<ApiSubpath>,
    now: EmittedNames,
    before: BaseSide,
) -> Result<ApiDiff, ApiError> {
    let kept = parts
        .iter()
        .map(|part| part.subpath.clone())
        .collect::<HashSet<_>>();
    let mut all = parts;
    all.extend(
        before
            .subpaths
            .into_iter()
            .filter(|part| !kept.contains(&part.subpath)),
    );
    all.sort_by(|a, b| a.subpath.cmp(&b.subpath));
    let empty = SubpathNames::default();
    let mut diff = IndexMap::new();
    for part in all {
        let then = before.names.get(&part.subpath).unwrap_or(&empty);
        let now = now.names.get(&part.subpath).unwrap_or(&empty);
        diff.insert(
            part.subpath,
            diff_subpath_names(part.tier.as_ref(), then, now),
        );
    }
    Ok(ApiDiff {
        root: project_relative(root)?,
        base: sha,
        compiler: now.compiler,
        subpaths: diff,
    })
}

/// Diff the dirty working tree against a resolved commit through actual Git and
/// compiler IO. This function blocks; async hosts must choose their blocking context.
pub fn diff_published_api_blocking<'a>(
    root: &JsString,
    map: &JsValue,
    base: &JsString,
    compiler: &'a TsgoBinary,
    options: PublishedApiOptions<'a>,
) -> Result<ApiDiff, ApiError> {
    let mut work = begin(root, map, base, compiler, options)?;
    let result = (|| {
        let present = subpaths_at_base(&work.guard.tree().root, &work.parts)?;
        read_present(&work.guard, &work.sha, present, compiler, &mut work.options)
    })();
    finish(work, result)
}

struct DiffWork<'a> {
    root: JsString,
    sha: JsString,
    parts: Vec<ApiSubpath>,
    now: EmittedNames,
    guard: BaseTreeGuard,
    compiler: &'a TsgoBinary,
    options: PublishedApiOptions<'a>,
}
fn begin<'a>(
    root: &JsString,
    map: &JsValue,
    base: &JsString,
    compiler: &'a TsgoBinary,
    mut options: PublishedApiOptions<'a>,
) -> Result<DiffWork<'a>, ApiError> {
    let root = package_root(root)?;
    let parts = api_subpaths(&root, map)?;
    let sha = resolve_base(&checkout_of(&root)?, base)?;
    let repo_root = options.repo_root;
    let now = read_side(&root, &parts, compiler, &mut options, repo_root, None)?;
    let guard = BaseTreeGuard::new(export_base_tree_blocking(&checkout_of(&root)?, &sha)?);
    Ok(DiffWork {
        root,
        sha,
        parts,
        now,
        guard,
        compiler,
        options,
    })
}
fn finish(work: DiffWork<'_>, result: Result<BaseSide, ApiError>) -> Result<ApiDiff, ApiError> {
    let before = work.guard.finish(result)?;
    assemble(&work.root, work.sha, work.parts, work.now, before)
}

/// The callback is skipped when the base commit predates the package.
#[must_use]
pub enum BaseMapStep<'a> {
    Complete(ApiDiff),
    Awaiting(BaseMapRequest<'a>),
}

/// Owns the exported tree while the caller awaits its own map-loading future.
/// Finish or abort explicitly to observe cleanup errors. Dropping it attempts
/// cleanup best-effort, including when a caller cancels its local future.
#[must_use]
pub struct BaseMapRequest<'a> {
    work: DiffWork<'a>,
}
impl BaseMapRequest<'_> {
    pub fn root(&self) -> &JsString {
        &self.work.guard.tree().root
    }
    /// Resume the blocking compiler segment with the actual callback result.
    pub fn finish_blocking(self, map: Result<JsValue, ApiError>) -> Result<ApiDiff, ApiError> {
        let mut work = self.work;
        let result = map.and_then(|map| {
            let present = base_api_subpaths(&work.guard.tree().root, &map, &work.sha)?;
            read_present(
                &work.guard,
                &work.sha,
                present,
                work.compiler,
                &mut work.options,
            )
        });
        finish(work, result)
    }
    pub fn abort_blocking(self) -> Result<(), ApiError> {
        self.work.guard.finish(Ok(()))
    }
}

/// Complete current-side IO and export the base before returning a map request.
/// No future is polled here. The caller can await an arbitrary borrowed, local
/// future between this blocking segment and `BaseMapRequest::finish_blocking`.
pub fn prepare_api_diff_with_base_map_blocking<'a>(
    root: &JsString,
    map: &JsValue,
    base: &JsString,
    compiler: &'a TsgoBinary,
    options: PublishedApiOptions<'a>,
) -> Result<BaseMapStep<'a>, ApiError> {
    let work = begin(root, map, base, compiler, options)?;
    let path = work.guard.tree().root.to_lossy();
    let present = if Path::new(&path).exists() {
        fs::metadata(path)
            .map(|meta| meta.is_dir())
            .map_err(|source| ApiError::Io {
                path: work.guard.tree().root.clone(),
                source,
            })
    } else {
        Ok(false)
    };
    match present {
        Ok(true) => Ok(BaseMapStep::Awaiting(BaseMapRequest { work })),
        Ok(false) => finish(
            work,
            Ok(BaseSide {
                subpaths: Vec::new(),
                names: IndexMap::new(),
            }),
        )
        .map(BaseMapStep::Complete),
        Err(error) => work.guard.finish(Err(error)),
    }
}
