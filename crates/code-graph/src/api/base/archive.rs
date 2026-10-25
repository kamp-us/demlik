use super::{Checkout, ReadEvent, decoded, read_pipe, trim};
use crate::{
    api::map::{ApiArgumentError, ApiError, ApiInputError},
    project::{dirname_path_text, join_path_text},
    text::JsString,
};
use std::{
    error::Error,
    fs, io,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveProcess {
    Git,
    Tar,
}
#[derive(Debug)]
pub struct ArchiveDiagnostic {
    pub process: ArchiveProcess,
    pub bytes: Vec<u8>,
}
/// The two real subprocess outcomes and their stderr chunks in observed arrival order.
#[derive(Debug)]
pub struct GitArchiveFailure {
    pub top: JsString,
    pub revision: JsString,
    pub destination: JsString,
    pub archive_status: Option<ExitStatus>,
    pub extract_status: Option<ExitStatus>,
    pub diagnostics: Vec<ArchiveDiagnostic>,
    pub io_errors: Vec<(ArchiveProcess, io::Error)>,
}
impl std::fmt::Display for GitArchiveFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some((_, error)) = self.io_errors.first() {
            error.fmt(f)
        } else {
            write!(
                f,
                "git archive {:?}; tar extract {:?}",
                self.archive_status, self.extract_status
            )
        }
    }
}
impl Error for GitArchiveFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.io_errors.first().map(|(_, error)| error as _)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct BaseTree {
    pub temp: JsString,
    pub root: JsString,
}

fn archive_into(top: &JsString, revision: &JsString, into: &JsString) -> Result<(), ApiError> {
    let arguments = vec![
        JsString::from("archive"),
        "--format=tar".into(),
        "--".into(),
        revision.clone(),
    ];
    // The source documents read-only Git operations, but an unvalidated option-like
    // revision can write --output inside its checkout. The terminator prevents that.
    let archive = Command::new("git")
        .args(arguments.iter().map(JsString::to_lossy))
        .current_dir(top.to_lossy())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut evidence = GitArchiveFailure {
        top: top.clone(),
        revision: revision.clone(),
        destination: into.clone(),
        archive_status: None,
        extract_status: None,
        diagnostics: vec![],
        io_errors: vec![],
    };
    let mut archive = match archive {
        Ok(child) => Some(child),
        Err(error) => match ApiArgumentError::from_null_byte(top, &arguments, error) {
            Ok(error) => return Err(ApiError::Argument(error)),
            Err(error) => {
                evidence.io_errors.push((ArchiveProcess::Git, error));
                None
            }
        },
    };
    let source = archive
        .as_mut()
        .and_then(|child| child.stdout.take())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let mut command = Command::new("tar");
    command
        .args(["-x", "-f", "-", "-C"])
        .arg(into.to_lossy())
        .stdin(source)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut extract = match command.spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            evidence.io_errors.push((ArchiveProcess::Tar, error));
            if let Some(child) = &mut archive
                && let Err(error) = child.kill()
            {
                evidence.io_errors.push((ArchiveProcess::Git, error));
            }
            None
        }
    };
    // Dropping the parent copy of tar's stdin is essential for EOF and spawn errors.
    drop(command);
    let archive_stderr = archive.as_mut().and_then(|child| child.stderr.take());
    let extract_stderr = extract.as_mut().and_then(|child| child.stderr.take());
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::sync_channel(2);
        if let Some(pipe) = archive_stderr {
            let sender = sender.clone();
            scope.spawn(|| read_pipe(pipe, false, sender));
        }
        if let Some(pipe) = extract_stderr {
            let sender = sender.clone();
            scope.spawn(|| read_pipe(pipe, true, sender));
        }
        drop(sender);
        for event in receiver {
            match event {
                ReadEvent::Bytes(tar, bytes) => evidence.diagnostics.push(ArchiveDiagnostic {
                    process: if tar {
                        ArchiveProcess::Tar
                    } else {
                        ArchiveProcess::Git
                    },
                    bytes,
                }),
                ReadEvent::Error(tar, error) => evidence.io_errors.push((
                    if tar {
                        ArchiveProcess::Tar
                    } else {
                        ArchiveProcess::Git
                    },
                    error,
                )),
            }
        }
    });
    if let Some(mut child) = archive {
        match child.wait() {
            Ok(status) => evidence.archive_status = Some(status),
            Err(error) => evidence.io_errors.push((ArchiveProcess::Git, error)),
        }
    }
    if let Some(mut child) = extract {
        match child.wait() {
            Ok(status) => evidence.extract_status = Some(status),
            Err(error) => evidence.io_errors.push((ArchiveProcess::Tar, error)),
        }
    }
    if evidence.io_errors.is_empty()
        && evidence
            .archive_status
            .is_some_and(|status| status.success())
        && evidence
            .extract_status
            .is_some_and(|status| status.success())
    {
        return Ok(());
    }
    let mut message = JsString::from("git archive of ");
    message.extend(revision);
    message.push_str(" failed: ");
    if let Some((_, error)) = evidence.io_errors.first() {
        message.push_str(&error.to_string());
    } else {
        let mut stderr = JsString::default();
        for diagnostic in &evidence.diagnostics {
            stderr.extend(&decoded(&diagnostic.bytes));
        }
        let stderr = trim(&stderr);
        if stderr.is_empty() {
            message.push_str("no output");
        } else {
            message.extend(&stderr);
        }
    }
    Err(ApiError::Input(
        ApiInputError::new(message).with_cause(evidence),
    ))
}

fn io_error(path: &JsString, source: io::Error) -> ApiError {
    match ApiArgumentError::from_null_path(path, source) {
        Ok(error) => ApiError::Argument(error),
        Err(source) => ApiError::Io {
            path: path.clone(),
            source,
        },
    }
}
fn after_failure(temp: &JsString, operation: ApiError) -> ApiError {
    match remove_base_tree(temp) {
        Ok(()) => operation,
        Err(cleanup) => ApiError::OperationAndCleanup {
            operation: Box::new(operation),
            cleanup: Box::new(cleanup),
        },
    }
}
fn temp_directory() -> Result<JsString, ApiError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir();
    loop {
        let name = format!(
            "code-graph-api-base-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let temp = base.join(name);
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&temp) {
            Ok(()) => {
                let raw: JsString = temp.to_string_lossy().as_ref().into();
                return fs::canonicalize(&temp)
                    .map(|path| path.to_string_lossy().as_ref().into())
                    .map_err(|source| after_failure(&raw, io_error(&raw, source)));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(&temp.to_string_lossy().as_ref().into(), error)),
        }
    }
}
fn link_installed(installed: &JsString, link: &JsString) -> Result<(), ApiError> {
    if !Path::new(&installed.to_lossy()).exists()
        || !Path::new(&dirname_path_text(link).to_lossy()).exists()
        || Path::new(&link.to_lossy()).exists()
    {
        return Ok(());
    }
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(installed.to_lossy(), link.to_lossy());
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_dir(installed.to_lossy(), link.to_lossy());
    result.map_err(
        |source| match ApiArgumentError::from_null_symlink(installed, link, source) {
            Ok(error) => ApiError::Argument(error),
            Err(source) => ApiError::Symlink {
                path: installed.clone(),
                destination: link.clone(),
                source,
            },
        },
    )
}

/// Export a commit or tree through a real `git archive | tar` pipe. This blocks.
/// The returned external temporary tree has explicit, fallible cleanup. Dependency
/// links point at the checkout's current installations and never replace tree entries.
/// Unlike the frozen helper, option-like raw revisions cannot enable Git write options.
pub fn export_base_tree_blocking(
    checkout: &Checkout,
    revision: &JsString,
) -> Result<BaseTree, ApiError> {
    let temp = temp_directory()?;
    let operation = (|| {
        archive_into(&checkout.top, revision, &temp)?;
        let root = join_path_text(&temp, &checkout.package_path);
        let package_now = join_path_text(&checkout.top, &checkout.package_path);
        link_installed(
            &join_path_text(&package_now, &"node_modules".into()),
            &join_path_text(&root, &"node_modules".into()),
        )?;
        link_installed(
            &join_path_text(&checkout.top, &"node_modules".into()),
            &join_path_text(&temp, &"node_modules".into()),
        )?;
        Ok(BaseTree {
            temp: temp.clone(),
            root,
        })
    })();
    match operation {
        Ok(tree) => Ok(tree),
        Err(operation) => Err(after_failure(&temp, operation)),
    }
}

/// Remove a temporary tree without following dependency symlinks. Missing is success.
pub fn remove_base_tree(temp: &JsString) -> Result<(), ApiError> {
    let path = temp.to_lossy();
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(temp, error)),
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        value => value.map_err(|source| io_error(temp, source)),
    }
}
