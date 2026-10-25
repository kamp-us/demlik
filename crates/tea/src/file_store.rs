//! Native JSON files with the reference adapter's PID temporary files and optional fence.
//!
//! A rename commits each file. Fenced writes hold `.fence.lock`, write state, then
//! write the version stamp. There is no fsync or atomic transaction across the
//! state and stamp. Unix lock ownership uses signal zero; other platforms return
//! an explicit error when an existing lock needs a process probe.

use std::{
    fmt, io,
    marker::PhantomData,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures::{FutureExt, future::LocalBoxFuture};
use serde::{Serialize, ser::SerializeMap};
use tokio::{fs, io::AsyncWriteExt};

use crate::{
    PlainData,
    data::{DependencyError, decode_json, plain_data, stringify_json},
    storage::{
        DeletableStore, FencedRead, Fencing, Migrated, Store, StoreConflictError, StoredCell,
        number_string,
    },
};

#[derive(Debug)]
pub enum FileStoreError {
    Io {
        operation: &'static str,
        path: PathBuf,
        cause: io::Error,
    },
    Json {
        path: PathBuf,
        raw: String,
        cause: serde_json::Error,
    },
    Version {
        path: PathBuf,
        raw: String,
    },
    Conflict(StoreConflictError),
    Coercion(crate::js_record::JsAccessError),
    Serialization(DependencyError),
    Undefined,
    ProcessProbeUnsupported,
}
impl FileStoreError {
    pub(crate) fn io(operation: &'static str, path: &Path, cause: io::Error) -> Self {
        Self::Io {
            operation,
            path: path.into(),
            cause,
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Json { .. } => "SyntaxError",
            Self::Conflict(error) => error.name(),
            Self::Coercion(error) => error.name,
            Self::Serialization(_) | Self::Undefined => "TypeError",
            _ => "Error",
        }
    }
    pub fn tag(&self) -> Option<&'static str> {
        match self {
            Self::Conflict(error) => Some(error.tag()),
            _ => None,
        }
    }
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Undefined => Some("ERR_INVALID_ARG_TYPE"),
            Self::Io { cause, .. } => {
                #[cfg(unix)]
                if let Some(code) = cause.raw_os_error().and_then(unix_error_code) {
                    return Some(code);
                }
                match cause.kind() {
                    io::ErrorKind::NotFound => Some("ENOENT"),
                    io::ErrorKind::AlreadyExists => Some("EEXIST"),
                    io::ErrorKind::PermissionDenied => Some("EACCES"),
                    io::ErrorKind::NotADirectory => Some("ENOTDIR"),
                    io::ErrorKind::IsADirectory => Some("EISDIR"),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}
#[cfg(unix)]
fn unix_error_code(errno: i32) -> Option<&'static str> {
    Some(match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::ESRCH => "ESRCH",
        libc::EINTR => "EINTR",
        libc::EIO => "EIO",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::EDQUOT => "EDQUOT",
        _ => return None,
    })
}
impl fmt::Display for FileStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, path, cause } => write!(f, "{operation} '{}': {cause}", path.display()),
            Self::Json { cause, .. } => cause.fmt(f),
            Self::Version { path, raw } => write!(f, "fileStore: version stamp at \"{}\" is not an integer: {raw}", path.display()),
            Self::Conflict(error) => error.fmt(f), Self::Serialization(error) => error.fmt(f),
            Self::Coercion(error) => error.fmt(f),
            Self::Undefined => f.write_str("The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined"),
            Self::ProcessProbeUnsupported => f.write_str("fileStore: checking the lock owner's process requires a supported native process adapter"),
        }
    }
}
impl std::error::Error for FileStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { cause, .. } => Some(cause),
            Self::Json { cause, .. } => Some(cause),
            Self::Conflict(cause) => Some(cause),
            Self::Coercion(cause) => Some(cause),
            Self::Serialization(cause) => Some(cause),
            _ => None,
        }
    }
}
impl Serialize for FileStoreError {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        if let Self::Conflict(error) = self {
            return error.serialize(serializer);
        }
        let mut fields = serializer.serialize_map(None)?;
        fields.serialize_entry("name", self.name())?;
        fields.serialize_entry("message", &self.to_string())?;
        if let Some(code) = self.code() {
            fields.serialize_entry("code", code)?;
        }
        match self {
            Self::Io {
                operation,
                path,
                cause,
            } => {
                fields.serialize_entry("syscall", operation)?;
                fields.serialize_entry("path", &path.to_string_lossy())?;
                fields.serialize_entry("errno", &cause.raw_os_error())?;
            }
            Self::Json { path, raw, .. } | Self::Version { path, raw } => {
                fields.serialize_entry("path", &path.to_string_lossy())?;
                fields.serialize_entry("raw", raw)?;
            }
            _ => {}
        }
        fields.end()
    }
}

pub struct FileStore<S, F> {
    path: Arc<PathBuf>,
    parse: Arc<F>,
    state: PhantomData<fn() -> S>,
}
impl<S, F> Clone for FileStore<S, F> {
    fn clone(&self) -> Self {
        Self {
            path: Arc::clone(&self.path),
            parse: Arc::clone(&self.parse),
            state: PhantomData,
        }
    }
}
pub fn file_store<S, F: Fn(PlainData) -> Migrated<S>>(
    path: impl Into<PathBuf>,
    parse: F,
) -> FileStore<S, F> {
    FileStore {
        path: Arc::new(path.into()),
        parse: Arc::new(parse),
        state: PhantomData,
    }
}
impl<S, F> FileStore<S, F> {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn fenced(self) -> FencedFileStore<S, F> {
        FencedFileStore(self)
    }
    fn parent(&self) -> &Path {
        self.path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
    }
    fn sidecar(&self, suffix: &str) -> PathBuf {
        let mut path = self.path.as_os_str().to_owned();
        path.push(suffix);
        path.into()
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> Store<S> for FileStore<S, F> {
    type Raw = PlainData;
    type Error = FileStoreError;
    async fn load(&self) -> Result<PlainData, FileStoreError> {
        let bytes = match fs::read(&*self.path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(PlainData::Null),
            Err(error) => return Err(FileStoreError::io("read", &self.path, error)),
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        decode_json(&raw).map_err(|cause| FileStoreError::Json {
            path: (*self.path).clone(),
            raw,
            cause,
        })
    }
    async fn save(&self, state: &S) -> Result<(), FileStoreError> {
        fs::create_dir_all(self.parent())
            .await
            .map_err(|error| FileStoreError::io("mkdir", self.parent(), error))?;
        let data = plain_data(state).map_err(FileStoreError::Serialization)?;
        let text = stringify_json(&data).ok_or(FileStoreError::Undefined)?;
        let temp = self.sidecar(&format!(".{}.tmp", std::process::id()));
        fs::write(&temp, text)
            .await
            .map_err(|error| FileStoreError::io("write", &temp, error))?;
        fs::rename(&temp, &*self.path)
            .await
            .map_err(|error| FileStoreError::io("rename", &self.path, error))?;
        Ok(())
    }
    fn migrate(&self, raw: PlainData) -> Migrated<S> {
        (self.parse)(raw)
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> DeletableStore<S> for FileStore<S, F> {
    async fn delete(&self) -> Result<(), FileStoreError> {
        remove_if_present(&self.sidecar(".fence")).await?;
        remove_if_present(&self.path).await
    }
}

pub struct FencedFileStore<S, F>(FileStore<S, F>);
impl<S, F> Clone for FencedFileStore<S, F> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> Store<S> for FencedFileStore<S, F> {
    type Raw = PlainData;
    type Error = FileStoreError;
    async fn load(&self) -> Result<PlainData, FileStoreError> {
        self.0.load().await
    }
    async fn save(&self, state: &S) -> Result<(), FileStoreError> {
        self.0.save(state).await
    }
    fn migrate(&self, raw: PlainData) -> Migrated<S> {
        self.0.migrate(raw)
    }
    fn fencing(&self) -> Option<&dyn Fencing<S, Raw = PlainData, Error = FileStoreError>> {
        Some(self)
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> FencedFileStore<S, F> {
    async fn read_version(&self) -> Result<f64, FileStoreError> {
        let path = self.0.sidecar(".fence");
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0.0),
            Err(error) => return Err(FileStoreError::io("read", &path, error)),
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let version = parse_integer(&raw);
        if !version.is_finite()
            || version.fract() != 0.0
            || !(0.0..=9_007_199_254_740_991.0).contains(&version)
        {
            return Err(FileStoreError::Version { path, raw });
        }
        Ok(version)
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> Fencing<S> for FencedFileStore<S, F> {
    type Raw = PlainData;
    type Error = FileStoreError;
    fn load_fenced(&self) -> LocalBoxFuture<'_, Result<FencedRead<PlainData>, FileStoreError>> {
        async move {
            let version = self.read_version().await?;
            Ok(FencedRead {
                raw: self.0.load().await?,
                version: StoredCell::Number(version),
            })
        }
        .boxed_local()
    }
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: StoredCell,
    ) -> LocalBoxFuture<'a, Result<StoredCell, FileStoreError>> {
        async move {
            fs::create_dir_all(self.0.parent())
                .await
                .map_err(|error| FileStoreError::io("mkdir", self.0.parent(), error))?;
            let lock = self.0.sidecar(".fence.lock");
            acquire_file_lock(self.0.parent(), &lock).await?;
            let result = async {
                let actual_version = self.read_version().await?;
                if StoredCell::Number(actual_version) != expected_version {
                    return Err(FileStoreError::Conflict(
                        StoreConflictError::new(expected_version, actual_version)
                            .map_err(FileStoreError::Coercion)?,
                    ));
                }
                let next = actual_version + 1.0;
                self.0.save(state).await?;
                let fence = self.0.sidecar(".fence");
                let temp = self
                    .0
                    .sidecar(&format!(".fence.{}.tmp", std::process::id()));
                fs::write(&temp, number_string(next))
                    .await
                    .map_err(|error| FileStoreError::io("write", &temp, error))?;
                fs::rename(&temp, &fence)
                    .await
                    .map_err(|error| FileStoreError::io("rename", &fence, error))?;
                Ok(StoredCell::Number(next))
            }
            .await;
            let _ = fs::remove_file(&lock).await;
            result
        }
        .boxed_local()
    }
}
impl<S: Serialize, F: Fn(PlainData) -> Migrated<S>> DeletableStore<S> for FencedFileStore<S, F> {
    async fn delete(&self) -> Result<(), FileStoreError> {
        let lock = self.0.sidecar(".fence.lock");
        acquire_file_lock(self.0.parent(), &lock).await?;
        let result = self.0.delete().await;
        let _ = fs::remove_file(&lock).await;
        result
    }
}
async fn remove_if_present(path: &Path) -> Result<(), FileStoreError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FileStoreError::io("unlink", path, error)),
    }
}
fn trim_js(value: &str) -> &str {
    value.trim_matches(|character| matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn parse_integer(value: &str) -> f64 {
    let value = trim_js(value);
    let sign = usize::from(value.starts_with(['+', '-']));
    let digits = value.as_bytes()[sign..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return f64::NAN;
    }
    value[..sign + digits].parse().unwrap_or(f64::NAN)
}
fn parse_pid(value: &str) -> f64 {
    let value = trim_js(value);
    if value.is_empty() {
        return 0.0;
    }
    let radix = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .map(|value| (value, 16))
        .or_else(|| {
            value
                .strip_prefix("0b")
                .or_else(|| value.strip_prefix("0B"))
                .map(|value| (value, 2))
        })
        .or_else(|| {
            value
                .strip_prefix("0o")
                .or_else(|| value.strip_prefix("0O"))
                .map(|value| (value, 8))
        });
    if let Some((value, radix)) = radix {
        return radix_pid(value, radix);
    }
    value.parse().unwrap_or(f64::NAN)
}
fn radix_pid(value: &str, radix: u32) -> f64 {
    if value.is_empty() {
        return f64::NAN;
    }
    let width = radix.trailing_zeros();
    let mut significant = 0_usize;
    let mut first_54_are_ones = true;
    for character in value.chars() {
        let Some(digit) = character.to_digit(radix) else {
            return f64::NAN;
        };
        for bit in (0..width).rev().map(|bit| (digit >> bit) & 1) {
            if significant == 0 && bit == 0 {
                continue;
            }
            significant += 1;
            if significant <= 54 && bit == 0 {
                first_54_are_ones = false;
            }
        }
    }
    // Only the process-ID range matters. JS Number still distinguishes a huge
    // finite integer (kill throws, stale) from Infinity (not an integer, held).
    match significant {
        0..=31 => u32::from_str_radix(value, radix)
            .map(f64::from)
            .unwrap_or(f64::NAN),
        32..=1023 => f64::from(i32::MAX) + 1.0,
        1024 if !first_54_are_ones => f64::from(i32::MAX) + 1.0,
        _ => f64::INFINITY,
    }
}
pub(crate) async fn acquire_file_lock(parent: &Path, path: &Path) -> Result<(), FileStoreError> {
    fs::create_dir_all(parent)
        .await
        .map_err(|error| FileStoreError::io("mkdir", parent, error))?;
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await
        {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())
                    .await
                    .map_err(|error| FileStoreError::io("write", path, error))?;
                file.flush()
                    .await
                    .map_err(|error| FileStoreError::io("write", path, error))?;
                drop(file);
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let bytes = match fs::read(path).await {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(FileStoreError::io("read", path, error)),
                };
                let pid = parse_pid(&String::from_utf8_lossy(&bytes));
                if pid.is_finite() && pid.fract() == 0.0 && pid > 0.0 && !process_alive(pid)? {
                    let _ = fs::remove_file(path).await;
                    continue;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(FileStoreError::io("open", path, error)),
        }
    }
}
#[cfg(unix)]
fn process_alive(pid: f64) -> Result<bool, FileStoreError> {
    if pid > f64::from(i32::MAX) {
        return Ok(false);
    }
    // Signal zero only probes existence; EPERM still proves a live holder.
    let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    Ok(alive || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}
#[cfg(not(unix))]
fn process_alive(_: f64) -> Result<bool, FileStoreError> {
    Err(FileStoreError::ProcessProbeUnsupported)
}
