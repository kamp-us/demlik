use demlik_code_graph::{
    api::{
        base::{BaseTree, Checkout, GitArchiveFailure, GitReadFailure},
        map::ApiError,
        ratchet::changesets::ChangesetsOptions,
    },
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    error::Error,
    fs,
    io::{self, BufRead},
    path::Path,
};
macro_rules! observe {
    ($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsString,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootInput {
    root: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RevisionInput {
    top: JsString,
    package_path: JsString,
    revision: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NamesInput {
    cwd: JsString,
    sha: JsString,
    dir: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadInput {
    root: JsString,
    base: JsString,
    #[serde(default, deserialize_with = "present_string")]
    repo_root: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TempInput {
    temp: JsString,
}
fn present_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<JsString>, D::Error> {
    JsString::deserialize(d).map(Some)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutView {
    top: JsString,
    package_path: JsString,
}
#[derive(Serialize)]
struct Success<T> {
    value: T,
}
#[derive(Serialize)]
struct Failure {
    error: ErrorView,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorView {
    name: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    argument: Option<JsString>,
}
fn io_code(error: &io::Error) -> &'static str {
    if error.raw_os_error() == Some(1) {
        return "EPERM";
    }
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        _ => "UNKNOWN",
    }
}
fn error_view(error: &ApiError) -> ErrorView {
    if let ApiError::OperationAndCleanup { cleanup, .. } = error {
        return error_view(cleanup);
    }
    let mut view = ErrorView {
        name: error.name(),
        message: error.message(),
        code: None,
        path: None,
        destination: None,
        location: None,
        argument: None,
    };
    match error {
        ApiError::Argument(error) => {
            view.code = Some(error.code());
            view.location = Some(error.location().label());
            view.argument = Some(error.argument().clone());
        }
        ApiError::Io { path, source } => {
            view.path = Some(path.clone());
            view.code = Some(io_code(source));
        }
        ApiError::Symlink {
            path,
            destination,
            source,
        } => {
            view.path = Some(path.clone());
            view.destination = Some(destination.clone());
            view.code = Some(io_code(source));
        }
        _ => {}
    }
    view
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDetails<'a> {
    variant: &'static str,
    source_chain: Vec<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git: Option<GitDetails<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive: Option<ArchiveDetails<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<Box<NativeDetails<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleanup: Option<Box<NativeDetails<'a>>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDetails<'a> {
    cwd: &'a JsString,
    arguments: &'a [JsString],
    stdout: &'a [u8],
    stderr: &'a [u8],
    status: Option<i32>,
    signal: Option<i32>,
    failures: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveDetails<'a> {
    top: &'a JsString,
    revision: &'a JsString,
    destination: &'a JsString,
    archive_status: Option<i32>,
    archive_signal: Option<i32>,
    extract_status: Option<i32>,
    extract_signal: Option<i32>,
    diagnostics: Vec<(&'static str, &'a [u8])>,
    io_errors: Vec<JsString>,
}
fn signal(status: Option<std::process::ExitStatus>) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.and_then(|s| s.signal())
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
fn details(error: &ApiError) -> NativeDetails<'_> {
    let mut source = error.source();
    let mut source_chain = vec![];
    let mut git = None;
    let mut archive = None;
    while let Some(cause) = source {
        source_chain.push(cause.to_string().into());
        if let Some(cause) = cause.downcast_ref::<GitReadFailure>() {
            git = Some(GitDetails {
                cwd: &cause.cwd,
                arguments: &cause.arguments,
                stdout: &cause.stdout,
                stderr: &cause.stderr,
                status: cause.status.and_then(|s| s.code()),
                signal: signal(cause.status),
                failures: cause
                    .failures
                    .iter()
                    .map(|e| e.to_string().into())
                    .collect(),
            });
        }
        if let Some(cause) = cause.downcast_ref::<GitArchiveFailure>() {
            archive = Some(ArchiveDetails {
                top: &cause.top,
                revision: &cause.revision,
                destination: &cause.destination,
                archive_status: cause.archive_status.and_then(|s| s.code()),
                archive_signal: signal(cause.archive_status),
                extract_status: cause.extract_status.and_then(|s| s.code()),
                extract_signal: signal(cause.extract_status),
                diagnostics: cause
                    .diagnostics
                    .iter()
                    .map(|d| {
                        (
                            match d.process {
                                demlik_code_graph::api::base::ArchiveProcess::Git => "git",
                                demlik_code_graph::api::base::ArchiveProcess::Tar => "tar",
                            },
                            d.bytes.as_slice(),
                        )
                    })
                    .collect(),
                io_errors: cause
                    .io_errors
                    .iter()
                    .map(|(process, e)| format!("{process:?}: {e}").into())
                    .collect(),
            });
        }
        source = cause.source();
    }
    let (variant, operation, cleanup) = match error {
        ApiError::Input(_) => ("input", None, None),
        ApiError::Argument(_) => ("argument", None, None),
        ApiError::Io { .. } => ("io", None, None),
        ApiError::Symlink { .. } => ("symlink", None, None),
        ApiError::OperationAndCleanup { operation, cleanup } => (
            "compound",
            Some(Box::new(details(operation))),
            Some(Box::new(details(cleanup))),
        ),
        _ => ("other", None, None),
    };
    NativeDetails {
        variant,
        source_chain,
        git,
        archive,
        operation,
        cleanup,
    }
}
fn finish<T: Serialize>(
    value: Result<T, ApiError>,
    evidence: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    match value {
        Ok(value) => to_raw_value(&Success { value }),
        Err(error) => {
            *evidence = Some(to_raw_value(&details(&error)).map_err(|e| e.to_string())?);
            to_raw_value(&Failure {
                error: error_view(&error),
            })
        }
    }
    .map_err(|e| e.to_string())
}
#[derive(Serialize)]
struct Entry {
    path: JsString,
    kind: &'static str,
    mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<JsString>,
}
fn entries(root: &Path, relative: &Path, output: &mut Vec<Entry>) -> io::Result<()> {
    let mut children = fs::read_dir(root.join(relative))?.collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| JsString::from(entry.file_name().to_string_lossy().as_ref()));
    for child in children {
        let path = relative.join(child.file_name());
        let metadata = fs::symlink_metadata(child.path())?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o7777
        };
        #[cfg(not(unix))]
        let mode = 0;
        let (kind, bytes, target) = if metadata.file_type().is_symlink() {
            (
                "symlink",
                None,
                Some(
                    fs::read_link(child.path())?
                        .to_string_lossy()
                        .as_ref()
                        .into(),
                ),
            )
        } else if metadata.is_dir() {
            ("directory", None, None)
        } else {
            ("file", Some(fs::read(child.path())?), None)
        };
        output.push(Entry {
            path: path.to_string_lossy().as_ref().into(),
            kind,
            mode,
            bytes,
            target,
        });
        if metadata.is_dir() {
            entries(root, &path, output)?;
        }
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportView {
    temp_external: bool,
    temp_mode: u32,
    root_relative: JsString,
    root_exists: bool,
    entries: Vec<Entry>,
    removed: bool,
    repeat_removed: bool,
}
fn export_view(
    tree: &BaseTree,
    checkout: &Checkout,
    calls: &mut Vec<&'static str>,
) -> Result<ExportView, ApiError> {
    let temp = tree.temp.to_lossy();
    let root = Path::new(&temp);
    let mut found = vec![];
    entries(root, Path::new(""), &mut found).map_err(|source| ApiError::Io {
        path: tree.temp.clone(),
        source,
    })?;
    #[cfg(unix)]
    let temp_mode = {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(root)
            .map_err(|source| ApiError::Io {
                path: tree.temp.clone(),
                source,
            })?
            .permissions()
            .mode()
            & 0o7777
    };
    #[cfg(not(unix))]
    let temp_mode = 0;
    let root_relative = if tree.root == tree.temp {
        JsString::default()
    } else {
        JsString::from_units(tree.root.units()[tree.temp.units().len() + 1..].to_vec())
    };
    let mut view = ExportView {
        temp_external: !Path::new(&temp).starts_with(checkout.top.to_lossy()),
        temp_mode,
        root_relative,
        root_exists: Path::new(&tree.root.to_lossy()).exists(),
        entries: found,
        removed: false,
        repeat_removed: false,
    };
    observe!(
        calls,
        demlik_code_graph::api::base::remove_base_tree,
        &tree.temp
    )?;
    view.removed = !root.exists();
    observe!(
        calls,
        demlik_code_graph::api::base::remove_base_tree,
        &tree.temp
    )?;
    view.repeat_removed = !root.exists();
    Ok(view)
}
fn execute(
    request: Request,
    calls: &mut Vec<&'static str>,
    evidence: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    macro_rules! input {
        ($ty:ty) => {
            serde_json::from_str::<$ty>(request.input.get()).map_err(|e| e.to_string())?
        };
    }
    match request.operation.as_str() {
        "checkout" => {
            let input = input!(RootInput);
            let result = observe!(
                calls,
                demlik_code_graph::api::base::checkout_of,
                &input.root
            )
            .map(|value| CheckoutView {
                top: value.top,
                package_path: value.package_path,
            });
            finish(result, evidence)
        }
        "resolve" => {
            let input = input!(RevisionInput);
            let checkout = Checkout {
                top: input.top,
                package_path: input.package_path,
            };
            finish(
                observe!(
                    calls,
                    demlik_code_graph::api::base::resolve_base,
                    &checkout,
                    &input.revision
                ),
                evidence,
            )
        }
        "names" => {
            let input = input!(NamesInput);
            finish(
                observe!(
                    calls,
                    demlik_code_graph::api::base::names_at_base,
                    &input.cwd,
                    &input.sha,
                    &input.dir
                ),
                evidence,
            )
        }
        "read" => {
            let input = input!(ReadInput);
            finish(
                observe!(
                    calls,
                    demlik_code_graph::api::ratchet::changesets::read_changesets_since,
                    &input.root,
                    &input.base,
                    ChangesetsOptions {
                        repo_root: input.repo_root.as_ref()
                    }
                ),
                evidence,
            )
        }
        "export" => {
            let input = input!(RevisionInput);
            let checkout = Checkout {
                top: input.top,
                package_path: input.package_path,
            };
            let result = observe!(
                calls,
                demlik_code_graph::api::base::export_base_tree_blocking,
                &checkout,
                &input.revision
            )
            .and_then(|tree| export_view(&tree, &checkout, calls));
            finish(result, evidence)
        }
        "remove" => {
            let input = input!(TempInput);
            #[derive(Serialize)]
            struct Removed {
                removed: bool,
            }
            finish(
                observe!(
                    calls,
                    demlik_code_graph::api::base::remove_base_tree,
                    &input.temp
                )
                .map(|()| Removed {
                    removed: fs::symlink_metadata(input.temp.to_lossy())
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
                }),
                evidence,
            )
        }
        _ => Err("unsupported operation".into()),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<JsString>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsString>,
    observed_calls: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_details: Option<Box<RawValue>>,
}
fn main() -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|r| r.id.clone());
        let mut calls = vec![];
        let mut native_details = None;
        let result = request
            .map_err(|e| e.to_string())
            .and_then(|r| execute(r, &mut calls, &mut native_details));
        let (ok, output, error) = match result {
            Ok(value) => (true, Some(value), None),
            Err(error) => (false, None, Some(error.into())),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
                id,
                ok,
                output,
                error,
                observed_calls: calls,
                native_details
            })?
        );
    }
    Ok(())
}
