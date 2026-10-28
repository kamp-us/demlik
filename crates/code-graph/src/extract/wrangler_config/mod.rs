pub(crate) mod document;
use crate::project::{
    Collation, CollationError, CollationInput, RepoListing, list_visible_files_request,
    normalize_lexical, relative_path_text, resolve_path_text, to_relative,
};
use crate::schema::{BindingKind, DataBindingKind};
use crate::text::JsString;
use crate::validation::RecordTypeError;
use document::Document;
use indexmap::IndexSet;
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingDecl {
    pub kind: BindingKind,
    pub binding: JsString,
    pub target_service: JsString,
    pub target_class: JsString,
}
#[derive(Debug, Serialize)]
pub struct DataBindingDecl {
    pub kind: DataBindingKind,
    pub binding: JsString,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceManifest {
    pub service: JsString,
    pub dir: String,
    pub config_file: String,
    pub main: Option<JsString>,
    pub bindings: Vec<BindingDecl>,
    pub data_bindings: Vec<DataBindingDecl>,
    pub env_keys: Vec<JsString>,
    pub binding_names: Vec<JsString>,
    pub dev_vars_keys: Vec<JsString>,
    pub dev_vars_files: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingCatalog {
    pub manifests: Vec<ServiceManifest>,
    pub unparsed_configs: Vec<String>,
}
#[derive(Debug)]
pub enum CatalogError {
    Record(RecordTypeError),
    WorkingDirectory(io::Error),
    Collation(CollationError),
}
impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Record(error) => error.fmt(formatter),
            Self::WorkingDirectory(error) => error.fmt(formatter),
            Self::Collation(error) => error.fmt(formatter),
        }
    }
}
impl CatalogError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Record(error) => error.name(),
            Self::WorkingDirectory(_) | Self::Collation(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Record(error) => error.message().clone(),
            Self::WorkingDirectory(error) => error.to_string().into(),
            Self::Collation(error) => error.to_string().into(),
        }
    }
}
impl std::error::Error for CatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Record(error) => error,
            Self::WorkingDirectory(error) => error,
            Self::Collation(error) => error,
        })
    }
}
impl From<RecordTypeError> for CatalogError {
    fn from(error: RecordTypeError) -> Self {
        Self::Record(error)
    }
}
impl From<CollationError> for CatalogError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}
pub fn find_wrangler_configs(
    root: &Path,
    listing: Option<&RepoListing>,
    collation: &Collation,
) -> Result<Vec<PathBuf>, CollationError> {
    find_wrangler_configs_request(root, listing, || Ok(collation))
}
fn find_wrangler_configs_request<'c>(
    root: &Path,
    listing: Option<&RepoListing>,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<Vec<PathBuf>, CollationError> {
    Ok(list_visible_files_request(
        root,
        &|file: &str| {
            ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]
                .contains(&file.rsplit('/').next().unwrap_or(file))
        },
        listing,
        request,
    )?
    .into_iter()
    .map(|file| normalize_lexical(&root.join(file)))
    .collect())
}
fn sorted_unique<'c>(
    values: impl IntoIterator<Item = JsString>,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<Vec<JsString>, CollationError> {
    let values: Vec<_> = values
        .into_iter()
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    if values.len() < 2 {
        return Ok(values);
    }
    let collation = request()?;
    let mut values = values
        .into_iter()
        .map(|value| CollationInput::from_utf16(value.units()).map(|input| (value, input)))
        .collect::<Result<Vec<_>, _>>()?;
    values.sort_by(|left, right| collation.compare(&left.1, &right.1));
    Ok(values.into_iter().map(|(value, _)| value).collect())
}
fn string(value: Option<&Document>) -> Option<JsString> {
    value.and_then(Document::string).cloned()
}
fn optional_string(value: Option<&Document>) -> Option<Option<JsString>> {
    match value {
        None => Some(None),
        Some(value) => value.string().cloned().map(Some),
    }
}
fn named_rows(value: Option<&Document>) -> Vec<JsString> {
    value
        .and_then(Document::array)
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    row.object()?;
                    string(row.get("binding"))
                })
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_default()
}
fn bindings<'c>(
    document: &Document,
    own: &JsString,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<Vec<BindingDecl>, CollationError> {
    let mut out = Vec::new();
    let services = document
        .get("services")
        .and_then(Document::array)
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    row.object()?;
                    Some(BindingDecl {
                        kind: BindingKind::Service,
                        binding: string(row.get("binding"))?,
                        target_service: string(row.get("service"))?,
                        target_class: optional_string(row.get("entrypoint"))?
                            .unwrap_or_else(|| "default".into()),
                    })
                })
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_default();
    out.extend(services);
    let durable = document
        .get("durable_objects")
        .filter(|value| value.object().is_some())
        .and_then(|value| value.get("bindings"))
        .and_then(Document::array)
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    row.object()?;
                    Some(BindingDecl {
                        kind: BindingKind::DurableObject,
                        binding: string(row.get("name"))?,
                        target_service: optional_string(row.get("script_name"))?
                            .unwrap_or_else(|| own.clone()),
                        target_class: string(row.get("class_name"))?,
                    })
                })
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_default();
    out.extend(durable);
    let workflows = document
        .get("workflows")
        .and_then(Document::array)
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    row.object()?;
                    Some(BindingDecl {
                        kind: BindingKind::Workflow,
                        binding: string(row.get("binding"))?,
                        target_service: optional_string(row.get("script_name"))?
                            .unwrap_or_else(|| own.clone()),
                        target_class: string(row.get("class_name"))?,
                    })
                })
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_default();
    out.extend(workflows);
    if out.len() < 2 {
        return Ok(out);
    }
    let collation = request()?;
    let mut out = out
        .into_iter()
        .map(|row| {
            let binding = CollationInput::from_utf16(row.binding.units())?;
            let service = CollationInput::from_utf16(row.target_service.units())?;
            let class = CollationInput::from_utf16(row.target_class.units())?;
            Ok((row, binding, service, class))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    out.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
            .then_with(|| collation.compare(&left.3, &right.3))
    });
    Ok(out.into_iter().map(|(row, _, _, _)| row).collect())
}
fn collect_bindings(document: &Document, top_level: bool, out: &mut Vec<JsString>) {
    if let Some(values) = document.array() {
        for value in values {
            collect_bindings(value, false, out);
        }
    }
    if let Some(object) = document.object() {
        for (key, value) in object.entries() {
            if top_level && key == "env" {
                continue;
            }
            if key == "binding"
                && let Some(value) = value.string()
            {
                out.push(value.clone());
            } else {
                collect_bindings(value, false, out);
            }
        }
    }
}
fn trim(text: &str) -> &str {
    text.trim_matches(|character| {
        matches!(
            character,
            '\t' | '\u{b}' | '\u{c}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
                    | '\n'
                    | '\r'
                    | '\u{2028}'
                    | '\u{2029}'
        )
    })
}
fn dev_vars<'c>(
    dir: &Path,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<(Vec<JsString>, Vec<String>), CollationError> {
    let mut keys = Vec::new();
    let mut files = Vec::new();
    for basename in [".dev.vars", ".dev.vars.example"] {
        let Ok(raw) = fs::read(dir.join(basename)) else {
            continue;
        };
        files.push(basename.into());
        let raw = String::from_utf8_lossy(&raw);
        for line in raw.split('\n') {
            let line = trim(line);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(equal) = line.find('=').filter(|index| *index > 0) {
                keys.push(trim(&line[..equal]).into());
            }
        }
    }
    Ok((sorted_unique(keys, request)?, files))
}
fn main_path(root: &Path, config_dir: &Path, main: &JsString) -> Result<JsString, CatalogError> {
    let target = resolve_path_text(config_dir, main).map_err(CatalogError::WorkingDirectory)?;
    relative_path_text(root, &target).map_err(CatalogError::WorkingDirectory)
}
pub fn load_binding_catalog(
    root: &Path,
    listing: Option<&RepoListing>,
    collation: &Collation,
) -> Result<BindingCatalog, CatalogError> {
    load_binding_catalog_request(root, listing, || Ok(collation))
}
pub(crate) fn load_binding_catalog_request<'c>(
    root: &Path,
    listing: Option<&RepoListing>,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<BindingCatalog, CatalogError> {
    let mut retained = None;
    let mut request = Some(request);
    let mut request = || {
        if let Some(collation) = retained {
            return Ok(collation);
        }
        let collation = request
            .take()
            .expect("catalog requests its borrowed handle once")()?;
        retained = Some(collation);
        Ok(collation)
    };
    let mut manifests = Vec::new();
    let mut unparsed_configs = Vec::new();
    for absolute in find_wrangler_configs_request(root, listing, || request())? {
        let file = to_relative(root, &absolute);
        let document = fs::read(&absolute).ok().and_then(|bytes| {
            let raw = String::from_utf8_lossy(&bytes);
            let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
            if absolute
                .extension()
                .is_some_and(|extension| extension == "toml")
            {
                document::toml(raw)
            } else {
                document::jsonc(raw)
            }
        });
        let Some(document) = document.filter(|document| document.object().is_some()) else {
            unparsed_configs.push(file);
            continue;
        };
        let vars = document
            .get("vars")
            .map(Document::record)
            .transpose()?
            .flatten();
        let (Some(name), Some(main)) = (
            optional_string(document.get("name")),
            optional_string(document.get("main")),
        ) else {
            unparsed_configs.push(file);
            continue;
        };
        let config_dir = absolute
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let dir = to_relative(root, config_dir);
        let service = name.unwrap_or_else(|| {
            if config_dir == Path::new(".") {
                ".".into()
            } else {
                config_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref()
                    .into()
            }
        });
        let bindings = bindings(&document, &service, &mut request)?;
        let mut data_bindings = Vec::new();
        for (key, kind) in [
            ("d1_databases", DataBindingKind::D1),
            ("kv_namespaces", DataBindingKind::Kv),
            ("r2_buckets", DataBindingKind::R2),
        ] {
            for binding in named_rows(document.get(key)) {
                data_bindings.push(DataBindingDecl { kind, binding });
            }
        }
        for binding in named_rows(
            document
                .get("queues")
                .filter(|value| value.object().is_some())
                .and_then(|value| value.get("producers")),
        ) {
            data_bindings.push(DataBindingDecl {
                kind: DataBindingKind::Queue,
                binding,
            });
        }
        for binding in &bindings {
            if binding.kind == BindingKind::DurableObject {
                data_bindings.push(DataBindingDecl {
                    kind: DataBindingKind::DurableObject,
                    binding: binding.binding.clone(),
                });
            }
        }
        if data_bindings.len() > 1 {
            let collation = request()?;
            let mut keyed = data_bindings
                .into_iter()
                .map(|row| {
                    let binding = CollationInput::from_utf16(row.binding.units())?;
                    let kind = CollationInput::from_text(row.kind.as_str())?;
                    Ok((row, binding, kind))
                })
                .collect::<Result<Vec<_>, CollationError>>()?;
            keyed.sort_by(|left, right| {
                collation
                    .compare(&left.1, &right.1)
                    .then_with(|| collation.compare(&left.2, &right.2))
            });
            data_bindings = keyed.into_iter().map(|(row, _, _)| row).collect();
        }
        let mut env_keys: Vec<_> = vars
            .into_iter()
            .flat_map(|vars| {
                vars.entries()
                    .filter(|(key, _)| *key != "__proto__")
                    .map(|(key, _)| key.clone())
            })
            .collect();
        if let Some(required) = document
            .get("secrets")
            .filter(|value| value.object().is_some())
            .and_then(|value| value.get("required"))
            .and_then(Document::array)
            .and_then(|values| {
                values
                    .iter()
                    .map(|value| value.string().cloned())
                    .collect::<Option<Vec<_>>>()
            })
        {
            env_keys.extend(required);
        }
        let mut binding_names = Vec::new();
        collect_bindings(&document, true, &mut binding_names);
        let (dev_vars_keys, dev_vars_files) = dev_vars(config_dir, &mut request)?;
        manifests.push(ServiceManifest {
            service,
            dir,
            config_file: file,
            main: main
                .as_ref()
                .map(|main| main_path(root, config_dir, main))
                .transpose()?,
            bindings,
            data_bindings,
            env_keys: sorted_unique(env_keys, &mut request)?,
            binding_names: sorted_unique(binding_names, &mut request)?,
            dev_vars_keys,
            dev_vars_files,
        });
    }
    if manifests.len() > 1 {
        let collation = request()?;
        let mut keyed = manifests
            .into_iter()
            .map(|row| {
                let dir = CollationInput::from_text(&row.dir)?;
                let service = CollationInput::from_utf16(row.service.units())?;
                Ok((row, dir, service))
            })
            .collect::<Result<Vec<_>, CollationError>>()?;
        keyed.sort_by(|left, right| {
            collation
                .compare(&left.1, &right.1)
                .then_with(|| collation.compare(&left.2, &right.2))
        });
        manifests = keyed.into_iter().map(|(row, _, _)| row).collect();
    }
    if unparsed_configs.len() > 1 {
        let collation = request()?;
        let mut keyed = unparsed_configs
            .into_iter()
            .map(|value| CollationInput::from_text(&value).map(|input| (value, input)))
            .collect::<Result<Vec<_>, _>>()?;
        keyed.sort_by(|left, right| collation.compare(&left.1, &right.1));
        unparsed_configs = keyed.into_iter().map(|(value, _)| value).collect();
    }
    Ok(BindingCatalog {
        manifests,
        unparsed_configs,
    })
}

#[cfg(test)]
mod metadata_order_tests {
    use super::*;
    use std::{
        cell::Cell,
        rc::Rc,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(source: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "demlik-d-catalog-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("wrangler.json"), source).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                assert!(std::thread::panicking(), "fixture cleanup failed: {error}");
            }
        }
    }
    #[test]
    fn record_error_precedes_collation_request() {
        let fixture = Fixture::new(r#"{"name":"a","vars":{"constructor":null}}"#);
        let calls = Cell::new(0);
        let result = load_binding_catalog_request(&fixture.0, None, || {
            calls.set(calls.get() + 1);
            panic!("record validation must precede the native ordering request")
        });
        let CatalogError::Record(error) = result.unwrap_err() else {
            panic!("original record error is retained")
        };
        assert_eq!(error.name(), "TypeError");
        assert_eq!(calls.get(), 0);
    }
    #[test]
    fn one_borrowed_request_serves_multiple_sorts_and_owned_results() {
        let fixture = Fixture::new(
            r#"{"name":"a","vars":{"z":1,"a":2},"services":[{"binding":"z","service":"z"},{"binding":"a","service":"a"}]}"#,
        );
        let host = Rc::new(Cell::new(0));
        let catalog = {
            let collation = Collation::try_node22_en_us().unwrap();
            let borrowed_host = &host;
            let catalog = load_binding_catalog_request(&fixture.0, None, || {
                borrowed_host.set(borrowed_host.get() + 1);
                Ok(&collation)
            })
            .unwrap();
            assert_eq!(host.get(), 1);
            catalog
        };
        assert_eq!(
            catalog.manifests[0].env_keys,
            vec![JsString::from("a"), JsString::from("z")]
        );
        assert_eq!(catalog.manifests[0].bindings[0].binding, "a");
    }
}
