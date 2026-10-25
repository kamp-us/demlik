//! Boundary rule input validation. Declaration consistency is judged separately.

use super::rules::*;
use crate::{
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, RecordTypeError, record_object},
};
use indexmap::IndexMap;

#[derive(Debug)]
pub enum BoundaryConfigResolution {
    Resolved(Box<BoundaryRules>),
    Refused { message: JsString },
}
#[derive(Debug)]
pub enum BoundaryConfigError {
    RecordType(RecordTypeError),
    Declaration(super::declaration::DeclarationError),
}
impl std::fmt::Display for BoundaryConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordType(error) => error.fmt(f),
            Self::Declaration(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for BoundaryConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::RecordType(error) => error,
            Self::Declaration(error) => error,
        })
    }
}
pub fn resolve_boundary_rules(
    file: Option<&JsString>,
) -> std::result::Result<BoundaryConfigResolution, BoundaryConfigError> {
    use crate::config::{ConfigFile, invalid_config, read_config};
    let rules = match file {
        None => BoundaryRules::default(),
        Some(file) => {
            let value = match read_config(ConfigFile::Text(file)) {
                Ok(value) => value,
                Err(message) => return Ok(BoundaryConfigResolution::Refused { message }),
            };
            match BoundaryRules::parse(&value) {
                Ok(rules) => rules,
                Err(BoundaryRuleInputError::Issue(issue)) => {
                    return Ok(BoundaryConfigResolution::Refused {
                        message: invalid_config(file, &issue),
                    });
                }
                Err(BoundaryRuleInputError::TypeError(error)) => {
                    return Err(BoundaryConfigError::RecordType(error));
                }
            }
        }
    };
    match super::declaration::declaration_issue(&rules).map_err(BoundaryConfigError::Declaration)? {
        Some(message) => Ok(BoundaryConfigResolution::Refused { message }),
        None => Ok(BoundaryConfigResolution::Resolved(Box::new(rules))),
    }
}

#[derive(Debug)]
pub enum BoundaryRuleInputError {
    Issue(InputIssue),
    TypeError(RecordTypeError),
}
impl std::fmt::Display for BoundaryRuleInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issue(issue) => issue.fmt(f),
            Self::TypeError(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for BoundaryRuleInputError {}
impl From<RecordTypeError> for BoundaryRuleInputError {
    fn from(value: RecordTypeError) -> Self {
        Self::TypeError(value)
    }
}
type Result<T> = std::result::Result<T, BoundaryRuleInputError>;
type Path = Vec<PathSegment>;
fn field(path: &[PathSegment], name: impl Into<JsString>) -> Path {
    let mut out = path.to_vec();
    out.push(PathSegment::Field(name.into()));
    out
}
fn indexed(path: &[PathSegment], index: usize) -> Path {
    let mut out = path.to_vec();
    out.push(PathSegment::Index(index));
    out
}
fn issue(path: &[PathSegment], message: impl Into<JsString>) -> BoundaryRuleInputError {
    BoundaryRuleInputError::Issue(InputIssue::new(path.to_vec(), message))
}
fn invalid(
    path: &[PathSegment],
    expected: &str,
    value: Option<&JsValue>,
) -> BoundaryRuleInputError {
    let received = match value {
        None => "undefined",
        Some(JsValue::Null) => "null",
        Some(JsValue::Bool(_)) => "boolean",
        Some(JsValue::Number(n)) if n.is_nan() => "NaN",
        Some(JsValue::Number(_)) => "number",
        Some(JsValue::String(_)) => "string",
        Some(JsValue::Array(_)) => "array",
        Some(JsValue::Object(_)) => "object",
    };
    issue(
        path,
        format!("Invalid input: expected {expected}, received {received}"),
    )
}
fn object<'a>(
    value: Option<&'a JsValue>,
    path: &[PathSegment],
    record: bool,
) -> Result<&'a JsObject> {
    let Some(JsValue::Object(fields)) = value else {
        return Err(invalid(
            path,
            if record { "record" } else { "object" },
            value,
        ));
    };
    if record && record_object(value.expect("checked present object"))?.is_none() {
        return Err(invalid(path, "record", value));
    }
    Ok(fields)
}
fn get<'a>(fields: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    fields.get(&JsString::from(key))
}
fn strict(fields: &JsObject, allowed: &[&str], path: &[PathSegment]) -> Result<()> {
    let keys = object_keys(fields)
        .into_iter()
        .filter(|key| !allowed.iter().any(|name| *key == name))
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(());
    }
    let mut message = JsString::from(if keys.len() == 1 {
        "Unrecognized key: "
    } else {
        "Unrecognized keys: "
    });
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            message.push_str(", ");
        }
        message.push_str("\"");
        message.extend(key);
        message.push_str("\"");
    }
    Err(issue(path, message))
}
fn text(value: Option<&JsValue>, path: &[PathSegment], folder: bool) -> Result<JsString> {
    let Some(JsValue::String(text)) = value else {
        return Err(invalid(path, "string", value));
    };
    if text.is_empty() {
        return Err(issue(
            path,
            "Too small: expected string to have >=1 characters",
        ));
    }
    if folder && text.units().contains(&47) {
        return Err(issue(path, "a top-level folder under src/, not a path"));
    }
    Ok(text.clone())
}
fn boolean(value: Option<&JsValue>, path: &[PathSegment]) -> Result<bool> {
    value
        .and_then(JsValue::as_bool)
        .ok_or_else(|| invalid(path, "boolean", value))
}
fn array<T>(
    value: Option<&JsValue>,
    path: &[PathSegment],
    nonempty: bool,
    mut parse: impl FnMut(&JsValue, &[PathSegment]) -> Result<T>,
) -> Result<Vec<T>> {
    let Some(JsValue::Array(values)) = value else {
        return Err(invalid(path, "array", value));
    };
    let out = values
        .iter()
        .enumerate()
        .map(|(index, value)| parse(value, &indexed(path, index)))
        .collect::<Result<Vec<_>>>()?;
    if nonempty && out.is_empty() {
        return Err(issue(path, "Too small: expected array to have >=1 items"));
    }
    Ok(out)
}
fn strings(
    value: Option<&JsValue>,
    path: &[PathSegment],
    nonempty: bool,
    folder: bool,
) -> Result<Vec<JsString>> {
    array(value, path, nonempty, |value, path| {
        text(Some(value), path, folder)
    })
}
fn record<T>(
    value: Option<&JsValue>,
    path: &[PathSegment],
    mut parse: impl FnMut(&JsValue, &[PathSegment]) -> Result<T>,
) -> Result<IndexMap<JsString, T>> {
    let fields = object(value, path, true)?;
    let mut out = IndexMap::new();
    for key in object_keys(fields) {
        if key == "__proto__" {
            continue;
        }
        let path = field(path, key.clone());
        if key.is_empty() {
            return Err(issue(&path, "Invalid key in record"));
        }
        out.insert(key.clone(), parse(&fields[key], &path)?);
    }
    Ok(out)
}
fn named_files(value: &JsValue, path: &[PathSegment]) -> Result<IndexMap<JsString, Vec<JsString>>> {
    record(Some(value), path, |value, path| {
        strings(Some(value), path, true, false)
    })
}
fn choice(value: &JsValue, path: &[PathSegment], names: &[&str]) -> Result<usize> {
    if let Some(text) = value.as_string()
        && let Some(index) = names.iter().position(|name| text == name)
    {
        return Ok(index);
    }
    Err(issue(
        path,
        format!(
            "Invalid option: expected one of {}",
            names
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>()
                .join("|")
        ),
    ))
}
fn library_type(value: &JsValue, path: &[PathSegment]) -> Result<LibraryType> {
    let fields = object(Some(value), path, false)?;
    let imports = strings(
        get(fields, "imports"),
        &field(path, "imports"),
        false,
        false,
    )?;
    let pure = boolean(get(fields, "pure"), &field(path, "pure"))?;
    let imported_from = get(fields, "importedFrom")
        .map(|value| {
            array(
                Some(value),
                &field(path, "importedFrom"),
                true,
                |value, path| {
                    Ok([
                        ImportedFrom::Driven,
                        ImportedFrom::Configurator,
                        ImportedFrom::Any,
                    ][choice(value, path, &["driven", "configurator", "any"])?])
                },
            )
        })
        .transpose()?;
    strict(fields, &["imports", "pure", "importedFrom"], path)?;
    Ok(LibraryType {
        imports,
        pure,
        imported_from,
    })
}
fn read_allowance(value: &JsValue, path: &[PathSegment]) -> Result<ReadAllowance> {
    let fields = object(Some(value), path, false)?;
    let driven = strings(get(fields, "driven"), &field(path, "driven"), false, false)?;
    let decided_by = get(fields, "decidedBy")
        .map(|value| strings(Some(value), &field(path, "decidedBy"), false, false))
        .transpose()?;
    strict(fields, &["driven", "decidedBy"], path)?;
    Ok(ReadAllowance { driven, decided_by })
}
fn preflight(value: Option<&JsValue>, nested: bool) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(fields) = record_object(value)? else {
        return Ok(());
    };
    if nested {
        for key in object_keys(fields) {
            if key != "__proto__" && !key.is_empty() {
                preflight(Some(&fields[key]), false)?;
            }
        }
    }
    Ok(())
}
impl BoundaryRules {
    /// Parses this package's rule shape and preserves its first input issue.
    pub fn parse(value: &JsValue) -> Result<Self> {
        let fields = object(Some(value), &[], false)?;
        // The source visits remaining fields after normal issues; thrown record
        // errors still escape. Only known record-shaped fields can throw here.
        for (name, nested) in [
            ("features", false),
            ("libraryTypes", false),
            ("libraries", false),
            ("allowImportNames", true),
            ("bindingOwners", true),
            ("readAllowance", false),
        ] {
            preflight(get(fields, name), nested)?;
        }
        let defaults = Self::default();
        let features = get(fields, "features")
            .map(|value| {
                record(Some(value), &field(&[], "features"), |value, path| {
                    strings(Some(value), path, true, true)
                })
            })
            .transpose()?
            .unwrap_or(defaults.features);
        let lib = get(fields, "lib")
            .map(|value| strings(Some(value), &field(&[], "lib"), false, true))
            .transpose()?
            .unwrap_or(defaults.lib);
        let library_types = get(fields, "libraryTypes")
            .map(|value| record(Some(value), &field(&[], "libraryTypes"), library_type))
            .transpose()?
            .unwrap_or(defaults.library_types);
        let libraries = get(fields, "libraries")
            .map(|value| {
                record(Some(value), &field(&[], "libraries"), |value, path| {
                    text(Some(value), path, false)
                })
            })
            .transpose()?
            .unwrap_or(defaults.libraries);
        let library_roots = get(fields, "libraryRoots")
            .map(|value| strings(Some(value), &field(&[], "libraryRoots"), false, false))
            .transpose()?
            .unwrap_or(defaults.library_roots);
        let world_libraries = get(fields, "worldLibraries")
            .map(|value| strings(Some(value), &field(&[], "worldLibraries"), false, false))
            .transpose()?
            .unwrap_or(defaults.world_libraries);
        let allow_import_names = get(fields, "allowImportNames")
            .map(|value| record(Some(value), &field(&[], "allowImportNames"), named_files))
            .transpose()?
            .unwrap_or(defaults.allow_import_names);
        let across_deployables = get(fields, "acrossDeployables")
            .map(|value| {
                array(
                    Some(value),
                    &field(&[], "acrossDeployables"),
                    false,
                    |value, path| {
                        Ok([
                            DeployableKind::BindingOutsideDrivenAdapter,
                            DeployableKind::WorkerCallCycle,
                            DeployableKind::RelativeImportCrossesWorkspace,
                        ][choice(
                            value,
                            path,
                            &[
                                "binding-outside-driven-adapter",
                                "worker-call-cycle",
                                "relative-import-crosses-workspace",
                            ],
                        )?])
                    },
                )
            })
            .transpose()?
            .unwrap_or(defaults.across_deployables);
        let binding_owners = get(fields, "bindingOwners")
            .map(|value| record(Some(value), &field(&[], "bindingOwners"), named_files))
            .transpose()?
            .unwrap_or(defaults.binding_owners);
        let application_shape = get(fields, "applicationShape")
            .map(|value| {
                array(
                    Some(value),
                    &field(&[], "applicationShape"),
                    false,
                    |value, path| {
                        Ok([
                            ShapeKind::IndexNotExportsOnly,
                            ShapeKind::ApplicationImportOutsideAllowlist,
                        ][choice(
                            value,
                            path,
                            &[
                                "index-not-exports-only",
                                "application-import-outside-allowlist",
                            ],
                        )?])
                    },
                )
            })
            .transpose()?
            .unwrap_or(defaults.application_shape);
        let application_may_import = get(fields, "applicationMayImport")
            .map(|value| {
                strings(
                    Some(value),
                    &field(&[], "applicationMayImport"),
                    false,
                    false,
                )
            })
            .transpose()?
            .unwrap_or(defaults.application_may_import);
        let pure_dependencies = get(fields, "pureDependencies")
            .map(|value| strings(Some(value), &field(&[], "pureDependencies"), false, false))
            .transpose()?
            .unwrap_or(defaults.pure_dependencies);
        let test_files = get(fields, "testFiles")
            .map(|value| strings(Some(value), &field(&[], "testFiles"), false, false))
            .transpose()?
            .unwrap_or(defaults.test_files);
        let read_allowance = get(fields, "readAllowance")
            .map(|value| record(Some(value), &field(&[], "readAllowance"), read_allowance))
            .transpose()?
            .unwrap_or(defaults.read_allowance);
        let composition_roots = get(fields, "compositionRoots")
            .map(|value| strings(Some(value), &field(&[], "compositionRoots"), false, false))
            .transpose()?
            .unwrap_or(defaults.composition_roots);
        strict(
            fields,
            &[
                "features",
                "lib",
                "libraryTypes",
                "libraries",
                "libraryRoots",
                "worldLibraries",
                "allowImportNames",
                "acrossDeployables",
                "bindingOwners",
                "applicationShape",
                "applicationMayImport",
                "pureDependencies",
                "testFiles",
                "readAllowance",
                "compositionRoots",
            ],
            &[],
        )?;
        Ok(Self {
            features,
            lib,
            library_types,
            libraries,
            library_roots,
            world_libraries,
            allow_import_names,
            across_deployables,
            binding_owners,
            application_shape,
            application_may_import,
            pure_dependencies,
            test_files,
            read_allowance,
            composition_roots,
        })
    }
}

fn leaf(value: &impl serde::Serialize) -> JsValue {
    JsValue::parse(&serde_json::to_string(value).expect("rule leaves are JSON data"))
        .expect("serialized rule leaf is valid JSON")
}
fn record_value<T>(items: &IndexMap<JsString, T>, value: impl Fn(&T) -> JsValue) -> JsValue {
    JsValue::Object(
        items
            .iter()
            .map(|(key, item)| (key.clone(), value(item)))
            .collect(),
    )
}
impl BoundaryRules {
    pub fn as_value(&self) -> JsValue {
        JsValue::Object(
            [
                ("features".into(), record_value(&self.features, leaf)),
                ("lib".into(), leaf(&self.lib)),
                (
                    "libraryTypes".into(),
                    record_value(&self.library_types, leaf),
                ),
                ("libraries".into(), record_value(&self.libraries, leaf)),
                ("libraryRoots".into(), leaf(&self.library_roots)),
                ("worldLibraries".into(), leaf(&self.world_libraries)),
                (
                    "allowImportNames".into(),
                    record_value(&self.allow_import_names, |items| record_value(items, leaf)),
                ),
                ("acrossDeployables".into(), leaf(&self.across_deployables)),
                (
                    "bindingOwners".into(),
                    record_value(&self.binding_owners, |items| record_value(items, leaf)),
                ),
                ("applicationShape".into(), leaf(&self.application_shape)),
                (
                    "applicationMayImport".into(),
                    leaf(&self.application_may_import),
                ),
                ("pureDependencies".into(), leaf(&self.pure_dependencies)),
                ("testFiles".into(), leaf(&self.test_files)),
                (
                    "readAllowance".into(),
                    record_value(&self.read_allowance, leaf),
                ),
                ("compositionRoots".into(), leaf(&self.composition_roots)),
            ]
            .into_iter()
            .collect(),
        )
    }
}
impl serde::Serialize for BoundaryRules {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.as_value().serialize(serializer)
    }
}
