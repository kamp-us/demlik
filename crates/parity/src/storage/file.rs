use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use demlik_tea::{
    PlainData,
    data::decode_json,
    file_store::FileStoreError,
    storage::{DeletableStore, Migrated, RestoreCause},
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::normalized;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Parse {
    #[default]
    Identity,
    Strict,
    Refuse,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Load,
    LoadFenced,
    Restore,
    Delete,
    ReadFiles,
    Save {
        json: Option<String>,
    },
    SaveFenced {
        json: Option<String>,
        expected: super::super::Number,
    },
    Migrate {
        json: Option<String>,
    },
    WriteRaw {
        value: String,
    },
    WriteFence {
        value: String,
    },
    StateDirectory,
    ParentFile,
    DeadLock,
}
#[derive(Deserialize)]
struct Input {
    path: Option<PathBuf>,
    #[serde(default)]
    fenced: bool,
    raw: Option<String>,
    bytes: Option<Vec<u8>>,
    fence: Option<String>,
    #[serde(default)]
    parse: Parse,
    actions: Vec<Action>,
}
fn migrate(mode: Parse, raw: PlainData) -> Migrated<PlainData> {
    match mode {
        Parse::Identity => {
            if matches!(raw, PlainData::Null) {
                Migrated::Fresh
            } else {
                Migrated::State(raw)
            }
        }
        Parse::Refuse => Migrated::Refused(demlik_tea::storage::refuse("not a saved State")),
        Parse::Strict => {
            let parse =
                demlik_tea::storage::schema_migrate(|raw: PlainData| -> Result<PlainData, ()> {
                    let PlainData::Object(values) = raw else {
                        return Err(());
                    };
                    let Some(PlainData::Number(count)) = values.get("count") else {
                        return Err(());
                    };
                    if !count.is_finite() {
                        return Err(());
                    }
                    Ok(PlainData::Object(
                        [("count".into(), PlainData::Number(*count))].into(),
                    ))
                });
            parse(raw)
        }
    }
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    value.into()
}
fn error(error: &FileStoreError, root: &Path, diagnostics: &mut Vec<Value>) -> Value {
    diagnostics.push(json!({ "source": "fileStore", "error": error }));
    match error {
        FileStoreError::Conflict(error) => super::conflict(error),
        FileStoreError::Json { .. } => json!({ "name": error.name(), "kind": "invalid_json" }),
        FileStoreError::Io { .. } => json!({ "name": error.name(), "code": error.code() }),
        _ => {
            let mut value = json!({ "name": error.name(), "message": error.to_string().replace(&root.to_string_lossy().to_string(), "<dir>") });
            if let Some(code) = error.code() {
                value["code"] = json!(code);
            }
            value
        }
    }
}
async fn contents(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::read(path).await {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::IsADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}
async fn files(path: &Path) -> Result<Value, String> {
    let state = contents(path).await?;
    let fence = contents(&sidecar(path, ".fence")).await?;
    let lock = contents(&sidecar(path, ".fence.lock")).await?;
    let mut names = Vec::new();
    if let Ok(mut directory) =
        tokio::fs::read_dir(path.parent().unwrap_or_else(|| Path::new("."))).await
    {
        while let Some(entry) = directory
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            names.push(
                entry
                    .file_name()
                    .to_string_lossy()
                    .replace(&format!(".{}.", std::process::id()), ".<pid>."),
            );
        }
    }
    names.sort();
    Ok(
        json!({ "stateText": state.as_ref().map(|bytes| String::from_utf8_lossy(bytes)), "stateBytes": state, "fenceText": fence.as_ref().map(|bytes| String::from_utf8_lossy(bytes)), "lockPresent": lock.is_some(), "files": names }),
    )
}
pub async fn execute(
    input: Value,
    calls: &mut Vec<&'static str>,
    diagnostics: &mut Vec<Value>,
) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let directory = if input.path.is_none() {
        let path = std::env::temp_dir().join(format!(
            "demlik-storage-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::create_dir_all(&path)
            .await
            .map_err(|error| error.to_string())?;
        Some(Directory(path))
    } else {
        None
    };
    let path = input.path.unwrap_or_else(|| {
        directory
            .as_ref()
            .expect("temp directory")
            .0
            .join("state.json")
    });
    let root = path.parent().unwrap_or_else(|| Path::new(".")).to_owned();
    if let Some(raw) = input.raw {
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::write(&path, raw)
            .await
            .map_err(|error| error.to_string())?;
    }
    if let Some(bytes) = input.bytes {
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|error| error.to_string())?;
    }
    if let Some(fence) = input.fence {
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::write(sidecar(&path, ".fence"), fence)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mode = input.parse;
    let store = observe!(
        calls,
        demlik_tea::file_store::file_store,
        path.clone(),
        move |raw| migrate(mode, raw)
    );
    if input.fenced {
        drive(store.fenced(), &path, input.actions, calls, diagnostics).await
    } else {
        drive(store, &path, input.actions, calls, diagnostics).await
    }
}
async fn drive<P>(
    store: P,
    path: &Path,
    actions: Vec<Action>,
    calls: &mut Vec<&'static str>,
    diagnostics: &mut Vec<Value>,
) -> Result<Value, String>
where
    P: DeletableStore<PlainData, Raw = PlainData, Error = FileStoreError>,
{
    let root = path.parent().unwrap_or_else(|| Path::new("."));
    let fenced = observe!(calls, demlik_tea::storage::is_fenced_store, &store);
    let mut observations = Vec::new();
    for action in actions {
        let result: Result<Value, FileStoreError> = match action {
            Action::Load => observe_async!(calls, demlik_tea::storage::Store::load, &store).map(|raw| json!({ "op": "load", "raw": normalized(&raw) })),
            Action::LoadFenced => observe_async!(calls, demlik_tea::storage::Fencing::load_fenced, store.fencing().ok_or("store is not fenced")?).map(|read| json!({ "op": "loadFenced", "raw": normalized(&read.raw), "version": super::normalized(&read.version.snapshot()) })),
            Action::Save { json: text } => {
                let state = text.map(|text| decode_json(&text)).transpose().map_err(|error| error.to_string())?.unwrap_or(PlainData::Undefined);
                observe_async!(calls, demlik_tea::storage::Store::save, &store, &state).map(|()| json!({ "op": "save" }))
            },
            Action::SaveFenced { json: text, expected } => {
                let state = text.map(|text| decode_json(&text)).transpose().map_err(|error| error.to_string())?.unwrap_or(PlainData::Undefined);
                observe_async!(calls, demlik_tea::storage::Fencing::save_fenced, store.fencing().ok_or("store is not fenced")?, &state, expected.value().into()).map(|version| json!({ "op": "saveFenced", "version": super::normalized(&version.snapshot()) }))
            },
            Action::Delete => observe_async!(calls, demlik_tea::storage::DeletableStore::delete, &store).map(|()| json!({ "op": "delete" })),
            Action::Migrate { json: text } => {
                let raw = text.map(|text| decode_json(&text)).transpose().map_err(|error| error.to_string())?.unwrap_or(PlainData::Undefined);
                Ok(match observe!(calls, demlik_tea::storage::Store::migrate, &store, raw) {
                    Migrated::Fresh => json!({ "op": "migrate", "kind": "fresh" }),
                    Migrated::State(value) => json!({ "op": "migrate", "kind": "state", "value": normalized(&value) }),
                    Migrated::Refused(value) => json!({ "op": "migrate", "kind": "refused", "refusal": value }),
                })
            },
            Action::Restore => {
                let outcome = match observe_async!(calls, demlik_tea::storage::restore, &store) {
                    Ok(value) => json!({ "op": "restore", "raw": value.as_ref().map(normalized) }),
                    Err(failure) => {
                        let mut value = super::restore::restore_error(&failure, |cause| error(cause, root, diagnostics));
                        if let Some(RestoreCause::Load(cause)) = &failure.cause && matches!(cause, FileStoreError::Json { .. } | FileStoreError::Io { .. }) {
                            let reason = "the saved state could not be read (<cause>)";
                            value["reason"] = json!(reason); value["message"] = json!(format!("@demlik/tea: store refused — {reason}. The saved state was not restored and nothing was written."));
                        }
                        json!({ "op": "restore", "error": value })
                    },
                };
                Ok(outcome)
            },
            Action::ReadFiles => Ok(json!({ "op": "readFiles", "files": files(path).await? })),
            Action::WriteRaw { value } => { tokio::fs::create_dir_all(root).await.map_err(|error| error.to_string())?; tokio::fs::write(path, value).await.map_err(|error| error.to_string())?; Ok(json!({ "op": "writeRaw" })) },
            Action::WriteFence { value } => { tokio::fs::create_dir_all(root).await.map_err(|error| error.to_string())?; tokio::fs::write(sidecar(path, ".fence"), value).await.map_err(|error| error.to_string())?; Ok(json!({ "op": "writeFence" })) },
            Action::StateDirectory => { tokio::fs::create_dir_all(path).await.map_err(|error| error.to_string())?; Ok(json!({ "op": "stateDirectory" })) },
            Action::ParentFile => { if let Some(parent) = root.parent() { tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?; } tokio::fs::write(root, "parent remains").await.map_err(|error| error.to_string())?; Ok(json!({ "op": "parentFile" })) },
            Action::DeadLock => {
                let mut child = std::process::Command::new(std::env::current_exe().map_err(|error| error.to_string())?).arg("--storage-exit").spawn().map_err(|error| error.to_string())?;
                let pid = child.id(); child.wait().map_err(|error| error.to_string())?;
                tokio::fs::create_dir_all(root).await.map_err(|error| error.to_string())?;
                tokio::fs::write(sidecar(path, ".fence.lock"), pid.to_string()).await.map_err(|error| error.to_string())?;
                Ok(json!({ "op": "deadLock" }))
            },
        };
        observations.push(match result {
            Ok(value) => value,
            Err(failure) => json!({ "error": error(&failure, root, diagnostics) }),
        });
    }
    Ok(json!({ "fenced": fenced, "observations": observations }))
}
