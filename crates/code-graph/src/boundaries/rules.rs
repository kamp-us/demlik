//! A scope chooses one layout; its zones own which crossings it permits.

use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportedFrom {
    Driven,
    Configurator,
    Any,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryType {
    pub imports: Vec<JsString>,
    pub pure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<Vec<ImportedFrom>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeployableKind {
    BindingOutsideDrivenAdapter,
    WorkerCallCycle,
    RelativeImportCrossesWorkspace,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShapeKind {
    IndexNotExportsOnly,
    ApplicationImportOutsideAllowlist,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadAllowance {
    pub driven: Vec<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<Vec<JsString>>,
}
pub type NamedFiles = IndexMap<JsString, IndexMap<JsString, Vec<JsString>>>;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct BoundaryRules {
    pub features: IndexMap<JsString, Vec<JsString>>,
    pub lib: Vec<JsString>,
    pub library_types: IndexMap<JsString, LibraryType>,
    pub libraries: IndexMap<JsString, JsString>,
    pub library_roots: Vec<JsString>,
    pub world_libraries: Vec<JsString>,
    pub allow_import_names: NamedFiles,
    pub across_deployables: Vec<DeployableKind>,
    pub binding_owners: NamedFiles,
    pub application_shape: Vec<ShapeKind>,
    pub application_may_import: Vec<JsString>,
    pub pure_dependencies: Vec<JsString>,
    pub test_files: Vec<JsString>,
    pub read_allowance: IndexMap<JsString, ReadAllowance>,
    pub composition_roots: Vec<JsString>,
}
impl Default for BoundaryRules {
    fn default() -> Self {
        Self {
            features: IndexMap::new(),
            lib: vec!["lib".into()],
            library_types: IndexMap::new(),
            libraries: IndexMap::new(),
            library_roots: vec![],
            world_libraries: vec![],
            allow_import_names: IndexMap::new(),
            across_deployables: vec![],
            binding_owners: IndexMap::new(),
            application_shape: vec![],
            application_may_import: vec![],
            pure_dependencies: vec![],
            test_files: vec![],
            read_allowance: IndexMap::new(),
            composition_roots: vec![],
        }
    }
}
pub fn declares_libraries(rules: &BoundaryRules) -> bool {
    !rules.library_types.is_empty()
        || !rules.libraries.is_empty()
        || !rules.library_roots.is_empty()
        || !rules.world_libraries.is_empty()
        || !rules.allow_import_names.is_empty()
}
pub fn declares_deployables(rules: &BoundaryRules) -> bool {
    !rules.across_deployables.is_empty()
}
pub fn declares_read_allowance(rules: &BoundaryRules) -> bool {
    !rules.read_allowance.is_empty()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    PerFeature,
    Port,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoneName {
    Index,
    Ports,
    Application,
    Driving,
    Driven,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PortZoneName {
    Ports,
    Application,
    Driving,
    Driven,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ZoneImport {
    ApplicationImportsAdapter,
    DrivingReachesDriven,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneRule {
    pub imports: Option<ZoneImport>,
    pub may_be_impure: bool,
    pub open_to_features: bool,
    pub open_to_outside: bool,
    pub library_zone: Option<ImportedFrom>,
    pub touches_bindings: bool,
    pub exports_only: bool,
    pub import_allowlist: Option<&'static [ZoneName]>,
}
const CLOSED: ZoneRule = ZoneRule {
    imports: None,
    may_be_impure: true,
    open_to_features: false,
    open_to_outside: false,
    library_zone: None,
    touches_bindings: false,
    exports_only: false,
    import_allowlist: None,
};
static INDEX: ZoneRule = ZoneRule {
    may_be_impure: false,
    open_to_features: true,
    open_to_outside: true,
    exports_only: true,
    ..CLOSED
};
static PORTS: ZoneRule = ZoneRule {
    may_be_impure: false,
    ..CLOSED
};
static APPLICATION: ZoneRule = ZoneRule {
    imports: Some(ZoneImport::ApplicationImportsAdapter),
    may_be_impure: false,
    import_allowlist: Some(&[ZoneName::Ports, ZoneName::Application]),
    ..CLOSED
};
static DRIVING: ZoneRule = ZoneRule {
    imports: Some(ZoneImport::DrivingReachesDriven),
    may_be_impure: false,
    open_to_outside: true,
    ..CLOSED
};
static DRIVEN: ZoneRule = ZoneRule {
    open_to_outside: true,
    library_zone: Some(ImportedFrom::Driven),
    touches_bindings: true,
    ..CLOSED
};
static UNKNOWN: ZoneRule = CLOSED;
static PORT_PORTS: ZoneRule = ZoneRule {
    open_to_outside: true,
    ..PORTS
};
static PORT_APPLICATION: ZoneRule = ZoneRule {
    open_to_outside: true,
    ..APPLICATION
};
const FEATURE_ZONES: &[(&str, ZoneName)] = &[
    ("index.ts", ZoneName::Index),
    ("ports.ts", ZoneName::Ports),
    ("application", ZoneName::Application),
    ("adapters/driving", ZoneName::Driving),
    ("adapters/driven", ZoneName::Driven),
];
const PORT_ZONES: &[(&str, PortZoneName)] = &[
    ("application/driving-ports", PortZoneName::Ports),
    ("application/driven-ports", PortZoneName::Ports),
    ("application", PortZoneName::Application),
    ("driving-adapters", PortZoneName::Driving),
    ("driven-adapters", PortZoneName::Driven),
];
fn port_folders() -> &'static [&'static str] {
    static FOLDERS: OnceLock<Vec<&'static str>> = OnceLock::new();
    FOLDERS
        .get_or_init(|| {
            PORT_ZONES
                .iter()
                .map(|(folder, _)| folder.split('/').next().expect("a zone has a root"))
                .collect::<IndexSet<_>>()
                .into_iter()
                .collect()
        })
        .as_slice()
}
pub static DRIVEN_HOMES: LazyLock<String> = LazyLock::new(|| {
    let feature = FEATURE_ZONES
        .iter()
        .filter(|(_, zone)| *zone == ZoneName::Driven)
        .map(|(folder, _)| format!("src/<feature>/{folder}/ (per-feature layout)"));
    let port = PORT_ZONES
        .iter()
        .filter(|(_, zone)| *zone == PortZoneName::Driven)
        .map(|(folder, _)| format!("src/{folder}/ (port layout)"));
    feature.chain(port).collect::<Vec<_>>().join(" or ")
});
fn is_port_folder(folder: &JsString) -> bool {
    port_folders().iter().any(|name| folder == *name)
}
fn join(values: &[&JsString], separator: &str) -> JsString {
    let mut units = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend_from_slice(value.units());
    }
    JsString::from_units(units)
}
fn interpolate(parts: &[JsString]) -> JsString {
    join(&parts.iter().collect::<Vec<_>>(), "")
}
pub fn layout_issue(scope: &JsString, folders: &[JsString]) -> Option<JsString> {
    let port = folders
        .iter()
        .filter(|folder| is_port_folder(folder))
        .collect::<Vec<_>>();
    if port.is_empty() {
        return None;
    }
    let features = folders
        .iter()
        .filter(|folder| !is_port_folder(folder))
        .collect::<Vec<_>>();
    let whole = port_folders().join(", ");
    if !features.is_empty() {
        return Some(interpolate(&[
            "\"features\" in \"".into(),
            scope.clone(),
            "\" lists the port-layout folder(s) ".into(),
            join(&port, ", "),
            " and the feature folder(s) ".into(),
            join(&features, ", "),
            format!(": a scope is one layout, so list only {whole}, or only feature folders.")
                .into(),
        ]));
    }
    let left = port_folders()
        .iter()
        .filter(|name| !port.iter().any(|folder| **folder == **name))
        .copied()
        .collect::<Vec<_>>();
    if left.is_empty() {
        return None;
    }
    Some(interpolate(&["\"features\" in \"".into(), scope.clone(), "\" lists the port-layout folder(s) ".into(), join(&port, ", "), format!(" and leaves out {}: the port layout is one hexagon of {whole}, so list all three, or only feature folders.", left.join(", ")).into()]))
}
pub fn unlisted_port_folder_issue(
    scope: &JsString,
    folders: &[JsString],
    held: &[JsString],
) -> Option<JsString> {
    let left = port_folders()
        .iter()
        .filter(|name| {
            held.iter().any(|folder| folder == *name)
                && !folders.iter().any(|folder| folder == *name)
        })
        .copied()
        .collect::<Vec<_>>();
    if left.is_empty() {
        return None;
    }
    Some(interpolate(&[
        "\"features\" in \"".into(),
        scope.clone(),
        format!(
            "\" leaves out the port-layout folder(s) {} that ",
            left.join(", ")
        )
        .into(),
        in_scope(scope, &"src".into()),
        format!(
            "/ holds: list {} together, or rename the folder(s).",
            port_folders().join(", ")
        )
        .into(),
    ]))
}
#[derive(Clone, Debug, Serialize)]
pub struct Zone<N = ZoneName> {
    pub name: N,
    pub entry: JsString,
    pub rule: &'static ZoneRule,
    pub adapter: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "layout", rename_all = "kebab-case")]
pub enum FeatureFile {
    PerFeature {
        feature: JsString,
        zone: Zone,
    },
    Port {
        feature: JsString,
        zone: Zone<PortZoneName>,
    },
}
#[derive(Clone, Debug, Serialize)]
pub struct ScopeZoning {
    pub layout: Layout,
    pub scope: JsString,
    pub features: IndexSet<JsString>,
    pub lib: IndexSet<JsString>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZoningError;
impl std::fmt::Display for ZoningError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("folders.some is not a function")
    }
}
impl std::error::Error for ZoningError {}
pub fn scope_zoning(rules: &BoundaryRules, scope: &JsString) -> Result<ScopeZoning, ZoningError> {
    let folders = rules.features.get(scope);
    if folders.is_none() && crate::text::has_object_prototype_property(scope) {
        return Err(ZoningError);
    }
    let folders = folders.map_or(&[][..], Vec::as_slice);
    Ok(ScopeZoning {
        layout: if folders.iter().any(is_port_folder) {
            Layout::Port
        } else {
            Layout::PerFeature
        },
        scope: scope.clone(),
        features: folders.iter().cloned().collect(),
        lib: rules.lib.iter().cloned().collect(),
    })
}
fn under(path: &[u16], folder: &str) -> bool {
    let folder = folder.encode_utf16().collect::<Vec<_>>();
    path == folder || (path.starts_with(&folder) && path.get(folder.len()) == Some(&47))
}
fn joined(path: &[&[u16]]) -> JsString {
    let mut units = Vec::new();
    for (index, part) in path.iter().enumerate() {
        if index > 0 {
            units.push(47);
        }
        units.extend_from_slice(part);
    }
    JsString::from_units(units)
}
fn feature_rule(name: ZoneName) -> &'static ZoneRule {
    match name {
        ZoneName::Index => &INDEX,
        ZoneName::Ports => &PORTS,
        ZoneName::Application => &APPLICATION,
        ZoneName::Driving => &DRIVING,
        ZoneName::Driven => &DRIVEN,
        ZoneName::Unknown => &UNKNOWN,
    }
}
pub fn feature_file_of(file: &JsString, zoning: &ScopeZoning) -> Option<FeatureFile> {
    let path = file.units().split(|unit| *unit == 47).collect::<Vec<_>>();
    if path.len() < 3 || path[0] != [115, 114, 99] {
        return None;
    }
    let top = JsString::from_units(path[1].to_vec());
    if !zoning.features.contains(&top) {
        return None;
    }
    let rest = &path[2..];
    match zoning.layout {
        Layout::PerFeature => {
            let adapter =
                rest.len() > 1 && rest[0] == "adapters".encode_utf16().collect::<Vec<_>>();
            let inside = joined(rest);
            let home = FEATURE_ZONES
                .iter()
                .find(|(folder, _)| under(inside.units(), folder));
            let (entry, name) = home.map_or_else(
                || {
                    (
                        joined(&rest[..if adapter { 2 } else { 1 }]),
                        ZoneName::Unknown,
                    )
                },
                |(folder, name)| ((*folder).into(), *name),
            );
            Some(FeatureFile::PerFeature {
                feature: top,
                zone: Zone {
                    name,
                    entry,
                    rule: feature_rule(name),
                    adapter,
                },
            })
        }
        Layout::Port => {
            let inside = joined(&path[1..]);
            let (folder, name) = PORT_ZONES
                .iter()
                .find(|(folder, _)| under(inside.units(), folder))?;
            let rule = match name {
                PortZoneName::Ports => &PORT_PORTS,
                PortZoneName::Application => &PORT_APPLICATION,
                PortZoneName::Driving => &DRIVING,
                PortZoneName::Driven => &DRIVEN,
            };
            let adapter = path.len() > 2 && (top == "driving-adapters" || top == "driven-adapters");
            Some(FeatureFile::Port {
                feature: zoning.scope.clone(),
                zone: Zone {
                    name: *name,
                    entry: (*folder).into(),
                    rule,
                    adapter,
                },
            })
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Place {
    Feature(FeatureFile),
    Lib,
    Elsewhere,
}
pub fn place_of(file: &JsString, zoning: &ScopeZoning) -> Place {
    if let Some(feature) = feature_file_of(file, zoning) {
        return Place::Feature(feature);
    }
    let path = file.units().split(|unit| *unit == 47).collect::<Vec<_>>();
    if path.len() >= 3
        && path[0] == [115, 114, 99]
        && zoning.lib.contains(&JsString::from_units(path[1].to_vec()))
    {
        Place::Lib
    } else {
        Place::Elsewhere
    }
}
pub fn in_scope(scope: &JsString, file: &JsString) -> JsString {
    if scope == "." {
        file.clone()
    } else {
        interpolate(&[scope.clone(), "/".into(), file.clone()])
    }
}
