mod document;
use crate::project::{
    RepoListing, list_visible_files, locale_compare_units, normalize_lexical, to_relative,
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
}
impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Record(error) => error.fmt(formatter),
            Self::WorkingDirectory(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for CatalogError {}
impl From<RecordTypeError> for CatalogError {
    fn from(error: RecordTypeError) -> Self {
        Self::Record(error)
    }
}
pub fn find_wrangler_configs(root: &Path, listing: Option<&RepoListing>) -> Vec<PathBuf> {
    list_visible_files(
        root,
        &|file: &str| {
            ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]
                .contains(&file.rsplit('/').next().unwrap_or(file))
        },
        listing,
    )
    .into_iter()
    .map(|file| normalize_lexical(&root.join(file)))
    .collect()
}
fn sorted_unique(values: impl IntoIterator<Item = JsString>) -> Vec<JsString> {
    let mut values: Vec<_> = values
        .into_iter()
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    values.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    values
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
fn bindings(document: &Document, own: &JsString) -> Vec<BindingDecl> {
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
    out.sort_by(|left, right| {
        locale_compare_units(left.binding.units(), right.binding.units())
            .then_with(|| {
                locale_compare_units(left.target_service.units(), right.target_service.units())
            })
            .then_with(|| {
                locale_compare_units(left.target_class.units(), right.target_class.units())
            })
    });
    out
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
fn dev_vars(dir: &Path) -> (Vec<JsString>, Vec<String>) {
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
    (sorted_unique(keys), files)
}
fn normalize(path: &JsString) -> JsString {
    let mut stack: Vec<&[u16]> = Vec::new();
    for part in path.units().split(|unit| *unit == u16::from(b'/')) {
        if part.is_empty() || part == [u16::from(b'.')] {
            continue;
        }
        if part == [u16::from(b'.'), u16::from(b'.')] {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    let mut units = vec![u16::from(b'/')];
    for (index, part) in stack.into_iter().enumerate() {
        if index > 0 {
            units.push(u16::from(b'/'));
        }
        units.extend_from_slice(part);
    }
    JsString::from_units(units)
}
fn absolute(path: &Path) -> Result<JsString, CatalogError> {
    let path = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir()
            .map_err(CatalogError::WorkingDirectory)?
            .join(path)
    };
    Ok(normalize(&path.to_string_lossy().as_ref().into()))
}
fn main_path(root: &Path, config_dir: &Path, main: &JsString) -> Result<JsString, CatalogError> {
    let mut target = if main.starts_with("/") {
        main.clone()
    } else {
        let mut target = absolute(config_dir)?;
        target.push_str("/");
        target.extend(main);
        target
    };
    target = normalize(&target);
    let root = absolute(root)?;
    let from: Vec<_> = root
        .units()
        .split(|unit| *unit == u16::from(b'/'))
        .filter(|part| !part.is_empty())
        .collect();
    let to: Vec<_> = target
        .units()
        .split(|unit| *unit == u16::from(b'/'))
        .filter(|part| !part.is_empty())
        .collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<Vec<u16>> = (common..from.len()).map(|_| vec![46, 46]).collect();
    parts.extend(to[common..].iter().map(|part| part.to_vec()));
    let mut units = Vec::new();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            units.push(u16::from(b'/'));
        }
        units.extend(part);
    }
    Ok(JsString::from_units(units))
}
pub fn load_binding_catalog(
    root: &Path,
    listing: Option<&RepoListing>,
) -> Result<BindingCatalog, CatalogError> {
    let mut manifests = Vec::new();
    let mut unparsed_configs = Vec::new();
    for absolute in find_wrangler_configs(root, listing) {
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
        let bindings = bindings(&document, &service);
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
        data_bindings.sort_by(|left, right| {
            locale_compare_units(left.binding.units(), right.binding.units()).then_with(|| {
                crate::project::locale_compare(left.kind.as_str(), right.kind.as_str())
            })
        });
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
        let (dev_vars_keys, dev_vars_files) = dev_vars(config_dir);
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
            env_keys: sorted_unique(env_keys),
            binding_names: sorted_unique(binding_names),
            dev_vars_keys,
            dev_vars_files,
        });
    }
    manifests.sort_by(|left, right| {
        crate::project::locale_compare(&left.dir, &right.dir)
            .then_with(|| locale_compare_units(left.service.units(), right.service.units()))
    });
    unparsed_configs.sort_by(|left, right| crate::project::locale_compare(left, right));
    Ok(BindingCatalog {
        manifests,
        unparsed_configs,
    })
}
