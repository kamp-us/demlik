use crate::{
    api::{
        capture::{Captured, capture},
        map::{ApiArgumentError, ApiError, ApiInputError, ApiSubpath},
    },
    engine::tsgo::TsgoBinary,
    project::{join_path_text, relative_path_text_from},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    fs, io,
    process::{Command, Stdio},
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Debug, Serialize)]
pub struct DeclarationEmit {
    pub temp: JsString,
    pub out: JsString,
    pub compiler: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub diagnostics: f64,
}
pub fn emitted_file_of(
    emit: &DeclarationEmit,
    root: &JsString,
    entry: &JsString,
) -> Result<JsString, ApiError> {
    let mut relative = relative_path_text_from(root, entry).map_err(|source| ApiError::Io {
        path: entry.clone(),
        source,
    })?;
    for (source, declaration) in [
        (".mts", ".d.mts"),
        (".cts", ".d.cts"),
        (".tsx", ".d.ts"),
        (".ts", ".d.ts"),
    ] {
        let suffix = source.encode_utf16().collect::<Vec<_>>();
        if relative.units().ends_with(&suffix) {
            relative = JsString::from_units(
                relative.units()[..relative.units().len() - suffix.len()].to_vec(),
            );
            relative.push_str(declaration);
            break;
        }
    }
    Ok(join_path_text(&emit.out, &relative))
}
static DIAGNOSTICS: LazyLock<regress::Regex> = LazyLock::new(|| {
    regress::Regex::new(r"Found (\d+) errors?").expect("static diagnostic regex is valid")
});
fn diagnostic_count(output: &str, status: Option<i32>) -> f64 {
    DIAGNOSTICS
        .find(output)
        .and_then(|found| found.group(1))
        .map(|range| {
            output[range]
                .parse::<f64>()
                .expect("diagnostic count contains decimal digits")
        })
        .unwrap_or(if status == Some(0) { 0.0 } else { 1.0 })
}
pub fn remove_emit(temp: &JsString) -> Result<(), ApiError> {
    let path = temp.to_lossy();
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(path_error(temp, source));
        }
    };
    let removed = if metadata.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    removed
        .or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|source| path_error(temp, source))
}
fn path_error(path: &JsString, source: io::Error) -> ApiError {
    match ApiArgumentError::from_null_path(path, source) {
        Ok(argument) => ApiError::Argument(argument),
        Err(source) => ApiError::Io {
            path: path.clone(),
            source,
        },
    }
}
pub(crate) struct EmitGuard {
    emit: Option<DeclarationEmit>,
}
impl EmitGuard {
    pub(crate) fn new(emit: DeclarationEmit) -> Self {
        Self { emit: Some(emit) }
    }
    pub(crate) fn get(&self) -> &DeclarationEmit {
        self.emit.as_ref().expect("live emit guard")
    }
    fn release(mut self) -> DeclarationEmit {
        self.emit.take().expect("live emit guard")
    }
    pub(crate) fn finish<T>(mut self, result: Result<T, ApiError>) -> Result<T, ApiError> {
        let emit = self.emit.take().expect("live emit guard");
        match (result, remove_emit(&emit.temp)) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(operation), Err(cleanup)) => Err(ApiError::OperationAndCleanup {
                operation: Box::new(operation),
                cleanup: Box::new(cleanup),
            }),
        }
    }
}
impl Drop for EmitGuard {
    fn drop(&mut self) {
        if let Some(emit) = self.emit.take() {
            let _ = remove_emit(&emit.temp);
        }
    }
}
static NEXT_EMIT: AtomicU64 = AtomicU64::new(0);
fn create_emit(compiler: &TsgoBinary) -> Result<EmitGuard, ApiError> {
    let temp = loop {
        let temp = std::env::temp_dir().join(format!(
            "code-graph-api-{}-{}",
            std::process::id(),
            NEXT_EMIT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&temp) {
            Ok(()) => break temp,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => {
                return Err(ApiError::Io {
                    path: temp.to_string_lossy().as_ref().into(),
                    source,
                });
            }
        }
    };
    let raw: JsString = temp.to_string_lossy().as_ref().into();
    let canonical = match fs::canonicalize(&temp) {
        Ok(path) => path,
        Err(source) => {
            let error = ApiError::Io {
                path: raw.clone(),
                source,
            };
            let guard = EmitGuard::new(DeclarationEmit {
                temp: raw,
                out: JsString::default(),
                compiler: compiler.version().into(),
                diagnostics: 0.0,
            });
            return guard.finish(Err(error));
        }
    };
    let temp: JsString = canonical.to_string_lossy().as_ref().into();
    Ok(EmitGuard::new(DeclarationEmit {
        out: join_path_text(&temp, &"out".into()),
        temp,
        compiler: compiler.version().into(),
        diagnostics: 0.0,
    }))
}

pub use super::capture::{CaptureFailure, CaptureStream};

pub struct DeclarationEmitFailure {
    captured: Captured,
}
impl DeclarationEmitFailure {
    pub fn stdout(&self) -> &[u8] {
        &self.captured.stdout
    }
    pub fn stderr(&self) -> &[u8] {
        &self.captured.stderr
    }
    pub fn status(&self) -> Option<std::process::ExitStatus> {
        self.captured.status
    }
    pub fn failures(&self) -> &[CaptureFailure] {
        &self.captured.failures
    }
    fn code(&self) -> &'static str {
        let error = match self.captured.failures.first().expect("failed capture") {
            CaptureFailure::OutputLimit { .. } => return "ENOBUFS",
            CaptureFailure::ReaderPanic { .. } => return "UNKNOWN",
            CaptureFailure::Spawn(error)
            | CaptureFailure::Wait(error)
            | CaptureFailure::Kill(error)
            | CaptureFailure::Read { source: error, .. }
            | CaptureFailure::ReaderSpawn { source: error, .. } => error,
        };
        if error.raw_os_error() == Some(1) {
            return "EPERM";
        }
        match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::NotADirectory => "ENOTDIR",
            _ => "UNKNOWN",
        }
    }
}
impl std::fmt::Debug for DeclarationEmitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeclarationEmitFailure")
            .field("stdout_bytes", &self.stdout().len())
            .field("stderr_bytes", &self.stderr().len())
            .field("status", &self.status())
            .field("failures", &self.failures())
            .finish()
    }
}
impl std::fmt::Display for DeclarationEmitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.captured
            .failures
            .first()
            .expect("failed capture")
            .fmt(f)
    }
}
impl std::error::Error for DeclarationEmitFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.captured.failures.first().map(|error| error as _)
    }
}

pub fn emit_declarations(
    root: &JsString,
    config: &JsString,
    compiler: &TsgoBinary,
) -> Result<DeclarationEmit, ApiError> {
    let mut guard = create_emit(compiler)?;
    let mut arguments: Vec<JsString> = vec!["-p".into(), config.clone()];
    arguments.extend(
        [
            "--noEmit",
            "false",
            "--declaration",
            "--emitDeclarationOnly",
            "--declarationMap",
            "false",
            "--noEmitOnError",
            "false",
            "--incremental",
            "false",
            "--composite",
            "false",
            "--rootDir",
        ]
        .map(JsString::from),
    );
    arguments.extend([root.clone(), "--outDir".into(), guard.get().out.clone()]);
    let mut command = Command::new(compiler.path());
    command
        .args(arguments.iter().map(JsString::to_lossy))
        .current_dir(root.to_lossy());
    command.stdin(Stdio::null());
    let mut captured = capture(&mut command);
    if matches!(captured.failures.first(), Some(CaptureFailure::Spawn(_))) {
        let CaptureFailure::Spawn(cause) = captured.failures.remove(0) else {
            unreachable!("matched spawn failure")
        };
        match ApiArgumentError::from_null_byte(root, &arguments, cause) {
            Ok(argument) => return guard.finish(Err(ApiError::Argument(argument))),
            Err(cause) => captured.failures.insert(0, CaptureFailure::Spawn(cause)),
        }
    }
    if !captured.failures.is_empty() {
        let failure = DeclarationEmitFailure { captured };
        let code = failure.code();
        let error = ApiError::Input(
            ApiInputError::new(
                format!(
                    "tsgo failed to start: spawnSync {} {code}",
                    compiler.path().display()
                )
                .into(),
            )
            .with_cause(failure),
        );
        return guard.finish(Err(error));
    }
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&captured.stdout),
        String::from_utf8_lossy(&captured.stderr)
    );
    let status = captured.status.and_then(|status| status.code());
    let installed = join_path_text(root, &"node_modules".into());
    if std::path::Path::new(&installed.to_lossy()).exists() {
        let link = join_path_text(&guard.get().temp, &"node_modules".into());
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(installed.to_lossy(), link.to_lossy());
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(installed.to_lossy(), link.to_lossy());
        if let Err(source) = linked {
            let error = match ApiArgumentError::from_null_symlink(&installed, &link, source) {
                Ok(argument) => ApiError::Argument(argument),
                Err(source) => ApiError::Symlink {
                    path: installed,
                    destination: link,
                    source,
                },
            };
            return guard.finish(Err(error));
        }
    }
    guard.emit.as_mut().expect("live emit guard").diagnostics = diagnostic_count(&output, status);
    Ok(guard.release())
}
pub fn emitted_entries(
    emit: &DeclarationEmit,
    root: &JsString,
    subpaths: &[ApiSubpath],
) -> Result<IndexMap<JsString, JsString>, ApiError> {
    let mut files = IndexMap::new();
    for part in subpaths {
        let emitted = emitted_file_of(emit, root, &part.entry_absolute)?;
        if !std::path::Path::new(&emitted.to_lossy()).exists() {
            let mut message = part.subpath.clone();
            message.push_str(": entry ");
            message.extend(&part.entry);
            message.push_str(" has no emitted declaration file (does the tsconfig include it?)");
            return Err(ApiError::Input(ApiInputError::new(message)));
        }
        files.insert(part.subpath.clone(), emitted);
    }
    Ok(files)
}
