//! Blocking Git reads and temporary base-tree exports. Async hosts can offload these
//! operations to a blocking worker; they do not use or create an async executor.
mod archive;
use crate::{
    api::map::{ApiArgumentError, ApiError, ApiInputError},
    project::relative_path_text_from,
    text::{JsRegex, JsString},
};
pub use archive::{
    ArchiveDiagnostic, ArchiveProcess, BaseTree, GitArchiveFailure, export_base_tree_blocking,
    remove_base_tree,
};
use std::{
    error::Error,
    fs,
    io::{self, Read},
    process::{Command, ExitStatus, Stdio},
    sync::{LazyLock, mpsc},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkout {
    pub top: JsString,
    pub package_path: JsString,
}

pub use super::capture::{CaptureFailure as GitCaptureError, CaptureStream as GitStream};
/// Actual native process evidence, retained beneath the source-owned refusal.
/// Captured bytes, status and host diagnostics are not rewritten to imitate Node.
#[derive(Debug)]
pub struct GitReadFailure {
    pub cwd: JsString,
    pub arguments: Vec<JsString>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: Option<ExitStatus>,
    pub failures: Vec<GitCaptureError>,
}
impl std::fmt::Display for GitReadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(error) = self.failures.first() {
            error.fmt(f)
        } else {
            write!(f, "git exited with {:?}", self.status)
        }
    }
}
impl Error for GitReadFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.failures.first().map(|error| error as _)
    }
}

enum ReadEvent {
    Bytes(bool, Vec<u8>),
    Error(bool, io::Error),
}
fn read_pipe(mut pipe: impl Read, stderr: bool, sender: mpsc::SyncSender<ReadEvent>) {
    loop {
        let mut bytes = vec![0; 64 * 1024];
        match pipe.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                bytes.truncate(count);
                if sender.send(ReadEvent::Bytes(stderr, bytes)).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = sender.send(ReadEvent::Error(stderr, error));
                break;
            }
        }
    }
}
fn git_read(cwd: &JsString, arguments: Vec<JsString>) -> Result<GitReadFailure, ApiError> {
    let mut command = Command::new("git");
    command
        .args(arguments.iter().map(JsString::to_lossy))
        .current_dir(cwd.to_lossy())
        .stdin(Stdio::null());
    let mut captured = super::capture::capture(&mut command);
    if !captured.failures.is_empty() {
        let first = captured.failures.remove(0);
        captured.failures.insert(
            0,
            match first {
                GitCaptureError::Spawn(error) => {
                    match ApiArgumentError::from_null_byte(cwd, &arguments, error) {
                        Ok(error) => return Err(ApiError::Argument(error)),
                        Err(error) => GitCaptureError::Spawn(error),
                    }
                }
                other => other,
            },
        );
    }
    Ok(GitReadFailure {
        cwd: cwd.clone(),
        arguments,
        stdout: captured.stdout,
        stderr: captured.stderr,
        status: captured.status,
        failures: captured.failures,
    })
}
impl GitReadFailure {
    fn succeeded(&self) -> bool {
        self.failures.is_empty() && self.status.is_some_and(|status| status.success())
    }
}
pub(crate) fn trim(text: &JsString) -> JsString {
    static TRIM: LazyLock<JsRegex> =
        LazyLock::new(|| JsRegex::new(&r"^\s*([\s\S]*?)\s*$".into()).expect("trim pattern"));
    TRIM.capture_groups(text)
        .expect("trim matches every string")
        .remove(0)
        .expect("trim group always participates")
}
fn decoded(bytes: &[u8]) -> JsString {
    String::from_utf8_lossy(bytes).as_ref().into()
}
fn input(message: JsString, cause: GitReadFailure) -> ApiError {
    ApiError::Input(ApiInputError::new(message).with_cause(cause))
}

/// Find the checkout without writing its files, index or refs. This call blocks.
pub fn checkout_of(root_absolute: &JsString) -> Result<Checkout, ApiError> {
    let run = git_read(
        root_absolute,
        vec!["rev-parse".into(), "--show-toplevel".into()],
    )?;
    if !run.succeeded() {
        let mut message = root_absolute.clone();
        message
            .push_str(" is not inside a git repository; --api-base reads its base commit from git");
        return Err(input(message, run));
    }
    let top = trim(&decoded(&run.stdout));
    let canonical =
        fs::canonicalize(top.to_lossy()).map_err(|source| ApiError::Io { path: top, source })?;
    let top = JsString::from(canonical.to_string_lossy().as_ref());
    let package_path =
        relative_path_text_from(&top, root_absolute).map_err(|source| ApiError::Io {
            path: root_absolute.clone(),
            source,
        })?;
    Ok(Checkout { top, package_path })
}

/// Resolve a revision to a commit, rejecting option-like revisions. This call blocks.
pub fn resolve_base(checkout: &Checkout, rev: &JsString) -> Result<JsString, ApiError> {
    let mut commit = rev.clone();
    commit.push_str("^{commit}");
    let run = git_read(
        &checkout.top,
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "--end-of-options".into(),
            commit,
        ],
    )?;
    if !run.succeeded() {
        let mut message = JsString::from("base rev \"");
        message.extend(rev);
        message.push_str("\" does not resolve to a commit in ");
        message.extend(&checkout.top);
        message.push_str(" (in CI, fetch it first)");
        return Err(input(message, run));
    }
    Ok(trim(&decoded(&run.stdout)))
}

/// List names directly under a pathspec, preserving NUL-delimited names. This call blocks.
pub fn names_at_base(
    cwd: &JsString,
    sha: &JsString,
    dir: &JsString,
) -> Result<Vec<JsString>, ApiError> {
    let run = git_read(
        cwd,
        vec![
            "ls-tree".into(),
            "-z".into(),
            "--name-only".into(),
            sha.clone(),
            "--".into(),
            dir.clone(),
        ],
    )?;
    if !run.succeeded() {
        let mut message = JsString::from("git ls-tree of ");
        message.extend(sha);
        message.push_str(" failed: ");
        let stderr = trim(&decoded(&run.stderr));
        if !stderr.is_empty() {
            message.extend(&stderr);
        } else if let Some(error) = run.failures.first() {
            message.push_str(&error.to_string());
        } else {
            message.push_str("no output");
        }
        return Err(input(message, run));
    }
    Ok(decoded(&run.stdout)
        .units()
        .split(|unit| *unit == 0)
        .filter(|name| !name.is_empty())
        .map(|name| JsString::from_units(name.to_vec()))
        .collect())
}
