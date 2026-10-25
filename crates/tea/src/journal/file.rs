use super::{Journal, JournalBackend, JournalEntry, Seq, make_journal};
use crate::{
    PlainData,
    data::{JsText, decode_json, plain_data, stringify_json},
    file_store::{FileStoreError, acquire_file_lock},
};
use futures::FutureExt;
use std::{
    fmt,
    future::Future,
    io,
    marker::PhantomData,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    rc::Rc,
};
use tokio::fs;

#[derive(Debug)]
pub enum FileJournalError<E> {
    File(FileStoreError),
    Parse {
        path: PathBuf,
        line: usize,
        raw: PlainData,
        cause: E,
    },
    NullEnvelope {
        path: PathBuf,
        line: usize,
    },
    StreamEncoding {
        stream: JsText,
    },
}
impl<E: fmt::Display> fmt::Display for FileJournalError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::File(error) => error.fmt(f),
            Self::Parse { cause, .. } => cause.fmt(f),
            Self::NullEnvelope { .. } => {
                f.write_str("Cannot read properties of null (reading 'seq')")
            }
            Self::StreamEncoding { .. } => f.write_str("URI malformed"),
        }
    }
}
impl<E: fmt::Debug + fmt::Display> std::error::Error for FileJournalError<E> {}
impl<E> From<FileStoreError> for FileJournalError<E> {
    fn from(error: FileStoreError) -> Self {
        Self::File(error)
    }
}

pub struct FileBackend<R, P> {
    directory: PathBuf,
    parse: P,
    record: PhantomData<fn() -> R>,
}
pub fn file_journal<R: serde::Serialize, E, P: Fn(PlainData) -> Result<R, E>>(
    directory: impl Into<PathBuf>,
    parse: P,
) -> Journal<R, FileBackend<R, P>> {
    make_journal(FileBackend {
        directory: directory.into(),
        parse,
        record: PhantomData,
    })
}
impl<R, E, P: Fn(PlainData) -> Result<R, E>> FileBackend<R, P> {
    fn path(&self, stream: &JsText) -> Result<PathBuf, FileJournalError<E>> {
        let Some(text) = stream.as_utf8() else {
            return Err(FileJournalError::StreamEncoding {
                stream: stream.clone(),
            });
        };
        let mut encoded = String::new();
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                encoded.push(char::from(byte));
            } else {
                use fmt::Write;
                write!(encoded, "%{byte:02X}").expect("writing to String cannot fail");
            }
        }
        Ok(self.directory.join(format!("{encoded}.jsonl")))
    }
    async fn read_entries(
        &self,
        stream: JsText,
    ) -> Result<Vec<Rc<JournalEntry<R>>>, FileJournalError<E>> {
        let path = self.path(&stream)?;
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(FileStoreError::io("read", &path, error).into()),
        };
        let raw = String::from_utf8_lossy(&bytes);
        let mut entries = Vec::new();
        for (index, line) in raw
            .split('\n')
            .enumerate()
            .filter(|(_, line)| !line.is_empty())
        {
            let row = decode_json(line).map_err(|cause| FileStoreError::Json {
                path: path.clone(),
                raw: line.into(),
                cause,
            })?;
            let (seq, raw) = match row {
                PlainData::Null => {
                    return Err(FileJournalError::NullEnvelope {
                        path,
                        line: index + 1,
                    });
                }
                PlainData::Object(mut fields) => (
                    fields
                        .shift_remove(&JsText::from("seq"))
                        .unwrap_or(PlainData::Undefined),
                    fields
                        .shift_remove(&JsText::from("record"))
                        .unwrap_or(PlainData::Undefined),
                ),
                _ => (PlainData::Undefined, PlainData::Undefined),
            };
            let record = (self.parse)(raw.clone()).map_err(|cause| FileJournalError::Parse {
                path: path.clone(),
                line: index + 1,
                raw,
                cause,
            })?;
            entries.push(Rc::new(JournalEntry {
                stream: stream.clone(),
                seq: Seq(seq),
                record: Rc::new(record),
            }));
        }
        Ok(entries)
    }
}
impl<R: serde::Serialize, E, P: Fn(PlainData) -> Result<R, E>> JournalBackend<R>
    for FileBackend<R, P>
{
    type Error = FileJournalError<E>;
    async fn read(&self, stream: JsText) -> Result<Vec<Rc<JournalEntry<R>>>, Self::Error> {
        self.read_entries(stream).await
    }
    async fn append(
        &self,
        stream: JsText,
        record: Rc<R>,
    ) -> Result<Rc<JournalEntry<R>>, Self::Error> {
        let mut entries = self.read_entries(stream.clone()).await?;
        let entry = Rc::new(JournalEntry {
            stream: stream.clone(),
            seq: ((entries.len() + 1) as f64).into(),
            record,
        });
        entries.push(Rc::clone(&entry));
        let path = self.path(&stream)?;
        let mut lines = Vec::with_capacity(entries.len());
        for entry in entries {
            let row = PlainData::Object(indexmap::IndexMap::from([
                ("seq".into(), entry.seq.raw().clone()),
                (
                    "record".into(),
                    plain_data(&*entry.record).map_err(FileStoreError::Serialization)?,
                ),
            ]));
            lines.push(stringify_json(&row).expect("an object always encodes as JSON"));
        }
        fs::create_dir_all(&self.directory)
            .await
            .map_err(|error| FileStoreError::io("mkdir", &self.directory, error))?;
        let temp = sidecar(&path, &format!(".{}.tmp", std::process::id()));
        fs::write(&temp, format!("{}\n", lines.join("\n")))
            .await
            .map_err(|error| FileStoreError::io("write", &temp, error))?;
        fs::rename(&temp, &path)
            .await
            .map_err(|error| FileStoreError::io("rename", &path, error))?;
        Ok(entry)
    }
    async fn lock<T>(
        &self,
        stream: JsText,
        effect: impl Future<Output = T>,
    ) -> Result<T, Self::Error> {
        let path = sidecar(&self.path(&stream)?, ".lock");
        acquire_file_lock(&self.directory, &path).await?;
        let lock = LockFile(Some(path));
        let result = AssertUnwindSafe(effect).catch_unwind().await;
        lock.release().await;
        match result {
            Ok(value) => Ok(value),
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    value.into()
}
struct LockFile(Option<PathBuf>);
impl LockFile {
    async fn release(mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path).await;
        }
    }
}
impl Drop for LockFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
