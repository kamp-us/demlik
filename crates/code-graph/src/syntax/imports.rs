use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::{fs, io};

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

use super::file::{NodeRef, SyntaxFile};
use crate::api::real_path;
use crate::engine::oxc::create_module_resolver;
use crate::project::{
    SourceUnit, locale_compare, locale_compare_units, relative_path_text_from, to_relative,
};
use crate::text::JsString;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportKind {
    Static,
    ExportFrom,
    Dynamic,
}
impl ImportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Static => "static",
            Self::ExportFrom => "export-from",
            Self::Dynamic => "dynamic",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedNames {
    pub names: IndexSet<JsString>,
    pub unreadable: bool,
}
impl ImportedNames {
    fn unreadable() -> Self {
        Self {
            names: IndexSet::new(),
            unreadable: true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLiteral {
    pub specifier: JsString,
    pub kind: ImportKind,
    pub type_only: bool,
    pub runtime: bool,
    pub imported: ImportedNames,
    pub start: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEdge {
    pub specifier: JsString,
    pub kind: ImportKind,
    pub type_only: bool,
    pub target: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportGraph {
    pub imports_by_file: IndexMap<String, Vec<JsString>>,
    pub imported_by_file: IndexMap<String, Vec<String>>,
    pub import_edges_by_file: IndexMap<String, Vec<ImportEdge>>,
}

fn string_value(node: Option<NodeRef<'_>>) -> Option<JsString> {
    let node = node?;
    let units = match node.kind() {
        "Literal" => node.string_units("value")?,
        "TemplateLiteral" if node.nodes("expressions").is_empty() => node
            .nodes("quasis")
            .first()?
            .string_units_path(&["value", "cooked"])?,
        _ => return None,
    };
    Some(JsString::from_units(units.into_owned()))
}

pub fn is_relative_name(name: &str) -> bool {
    let tail = name.strip_prefix("..").or_else(|| name.strip_prefix('.'));
    tail.is_some_and(|tail| tail.is_empty() || tail.starts_with(['/', '\\']))
}
pub(crate) fn is_relative_units(name: &JsString) -> bool {
    let units = name.units();
    if units.first() != Some(&46) {
        return false;
    }
    let rest = if units.get(1) == Some(&46) {
        &units[2..]
    } else {
        &units[1..]
    };
    rest.is_empty() || matches!(rest.first(), Some(47 | 92))
}

fn literal_of(
    source: Option<NodeRef<'_>>,
    kind: ImportKind,
    type_only: bool,
    runtime: bool,
    imported: ImportedNames,
    ambient: bool,
) -> Vec<ImportLiteral> {
    let Some(source) = source else {
        return Vec::new();
    };
    let Some(specifier) = string_value(Some(source)) else {
        return Vec::new();
    };
    if specifier.is_empty() || (ambient && is_relative_units(&specifier)) {
        return Vec::new();
    }
    vec![ImportLiteral {
        specifier,
        kind,
        type_only,
        runtime: runtime && !ambient,
        imported,
        start: source.start(),
    }]
}

fn module_export_name(node: Option<NodeRef<'_>>) -> Option<JsString> {
    let node = node?;
    node.string("name")
        .map(JsString::from)
        .or_else(|| string_value(Some(node)))
}
fn imported_by(statement: NodeRef<'_>) -> ImportedNames {
    let specifiers = statement.nodes("specifiers");
    if specifiers.is_empty() {
        return ImportedNames::unreadable();
    }
    let mut imported = ImportedNames {
        names: IndexSet::new(),
        unreadable: false,
    };
    for specifier in specifiers {
        let name = match specifier.kind() {
            "ImportSpecifier" => module_export_name(specifier.node("imported")),
            "ExportSpecifier" => module_export_name(specifier.node("local")),
            _ => None,
        };
        if let Some(name) = name {
            imported.names.insert(name);
        } else {
            imported.unreadable = true;
        }
    }
    imported
}

fn declaration_literals(
    statement: NodeRef<'_>,
    kind: ImportKind,
    type_field: &str,
    ambient: bool,
) -> Vec<ImportLiteral> {
    let type_only = statement.string(type_field) == Some("type");
    let specifiers = statement.nodes("specifiers");
    let names_only_types = !specifiers.is_empty()
        && specifiers
            .iter()
            .all(|specifier| specifier.string(type_field) == Some("type"));
    literal_of(
        statement.node("source"),
        kind,
        type_only,
        !type_only && !names_only_types,
        imported_by(statement),
        ambient,
    )
}

fn statement_literals(statement: NodeRef<'_>, ambient: bool) -> Vec<ImportLiteral> {
    match statement.kind() {
        "ImportDeclaration" => {
            declaration_literals(statement, ImportKind::Static, "importKind", ambient)
        }
        "ExportNamedDeclaration" | "ExportAllDeclaration" => {
            declaration_literals(statement, ImportKind::ExportFrom, "exportKind", ambient)
        }
        "TSImportEqualsDeclaration" => {
            let Some(reference) = statement
                .node("moduleReference")
                .filter(|reference| reference.kind() == "TSExternalModuleReference")
            else {
                return Vec::new();
            };
            literal_of(
                reference.node("expression"),
                ImportKind::Static,
                false,
                statement.string("importKind") != Some("type"),
                ImportedNames::unreadable(),
                ambient,
            )
        }
        "TSModuleDeclaration"
            if statement
                .node("id")
                .is_some_and(|id| id.kind() == "Literal")
                && (ambient || statement.boolean("declare") == Some(true)) =>
        {
            statement
                .node("body")
                .into_iter()
                .flat_map(|body| body.nodes("body"))
                .flat_map(|statement| statement_literals(statement, true))
                .collect()
        }
        _ => Vec::new(),
    }
}

pub fn import_literals(syntax: &SyntaxFile) -> Vec<ImportLiteral> {
    let mut literals: Vec<_> = syntax
        .root()
        .nodes("body")
        .into_iter()
        .flat_map(|statement| statement_literals(statement, false))
        .collect();
    let mut pending = vec![syntax.root()];
    while let Some(node) = pending.pop() {
        match node.kind() {
            "ImportExpression" => literals.extend(literal_of(
                node.node("source"),
                ImportKind::Dynamic,
                false,
                true,
                ImportedNames::unreadable(),
                false,
            )),
            "TSImportType" => literals.extend(literal_of(
                node.node("source"),
                ImportKind::Static,
                false,
                false,
                ImportedNames::unreadable(),
                false,
            )),
            _ => {}
        }
        pending.extend(node.children().into_iter().rev());
    }
    literals
}

pub fn runtime_specifiers(syntax: &SyntaxFile) -> IndexSet<JsString> {
    import_literals(syntax)
        .into_iter()
        .filter(|literal| literal.runtime)
        .map(|literal| literal.specifier)
        .collect()
}
pub fn imported_names_of(syntax: &SyntaxFile) -> IndexMap<JsString, ImportedNames> {
    let mut by_specifier: IndexMap<JsString, ImportedNames> = IndexMap::new();
    for literal in import_literals(syntax) {
        if let Some(held) = by_specifier.get_mut(&literal.specifier) {
            held.names.extend(literal.imported.names);
            held.unreadable |= literal.imported.unreadable;
        } else {
            by_specifier.insert(literal.specifier, literal.imported);
        }
    }
    by_specifier
}

fn sorted_names(values: impl IntoIterator<Item = JsString>) -> Vec<JsString> {
    let mut values: Vec<_> = values
        .into_iter()
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    values.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    values
}
pub fn import_declaration_specifiers(syntax: &SyntaxFile) -> Vec<JsString> {
    sorted_names(
        syntax
            .root()
            .nodes("body")
            .into_iter()
            .filter(|statement| statement.kind() == "ImportDeclaration")
            .filter_map(|statement| string_value(statement.node("source"))),
    )
}

fn is_external_module(syntax: &SyntaxFile) -> bool {
    if syntax.root().nodes("body").iter().any(|statement| {
        matches!(
            statement.kind(),
            "ImportDeclaration"
                | "ExportNamedDeclaration"
                | "ExportDefaultDeclaration"
                | "ExportAllDeclaration"
                | "TSExportAssignment"
        ) || statement.kind() == "TSImportEqualsDeclaration"
            && statement
                .node("moduleReference")
                .is_some_and(|reference| reference.kind() == "TSExternalModuleReference")
    }) {
        return true;
    }
    let mut pending = vec![syntax.root()];
    while let Some(node) = pending.pop() {
        if node.kind() == "MetaProperty"
            && node.node("meta").unwrap_or(node).string("name") == Some("import")
        {
            return true;
        }
        pending.extend(node.children());
    }
    false
}

pub fn resolve_imports(
    root: &Path,
    source_files: &[Rc<SourceUnit>],
    ts_config: &Path,
) -> ImportGraph {
    resolve(
        ImportRoot::Native {
            logical: root,
            real: fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()),
        },
        source_files,
        ts_config,
    )
    .expect("native Path comparisons do not have the text branch's working-directory failure")
}
pub(crate) fn resolve_imports_text(
    root: &JsString,
    source_files: &[Rc<SourceUnit>],
    ts_config: &Path,
) -> io::Result<ImportGraph> {
    resolve(
        ImportRoot::Text {
            logical: root,
            real: real_path(root).unwrap_or_else(|_| root.clone()),
        },
        source_files,
        ts_config,
    )
}
enum ImportRoot<'a> {
    Native {
        logical: &'a Path,
        real: PathBuf,
    },
    Text {
        logical: &'a JsString,
        real: JsString,
    },
}
fn resolve(
    root: ImportRoot<'_>,
    source_files: &[Rc<SourceUnit>],
    ts_config: &Path,
) -> io::Result<ImportGraph> {
    let resolver = create_module_resolver(ts_config);
    let units: IndexMap<_, _> = source_files
        .iter()
        .map(|unit| (unit.file.as_str(), unit))
        .collect();
    let modules: HashSet<_> = source_files
        .iter()
        .filter(|unit| is_external_module(&unit.syntax))
        .map(|unit| unit.file.as_str())
        .collect();
    let in_scope = |resolved: &Path| -> io::Result<Option<String>> {
        let file = match &root {
            ImportRoot::Native { logical, real } => {
                let direct = to_relative(logical, resolved);
                if units.contains_key(direct.as_str()) {
                    direct
                } else {
                    to_relative(
                        real,
                        &fs::canonicalize(resolved).unwrap_or_else(|_| resolved.to_path_buf()),
                    )
                }
            }
            ImportRoot::Text { logical, real } => {
                let resolved: JsString = resolved.to_string_lossy().as_ref().into();
                let direct = relative_path_text_from(logical, &resolved)?;
                match direct.to_utf8() {
                    Ok(direct) if units.contains_key(direct.as_str()) => direct,
                    _ => {
                        let resolved_real = real_path(&resolved).unwrap_or(resolved);
                        let relative = relative_path_text_from(real, &resolved_real)?;
                        let Ok(file) = relative.to_utf8() else {
                            return Ok(None);
                        };
                        file
                    }
                }
            }
        };
        Ok((units.contains_key(file.as_str()) && modules.contains(file.as_str())).then_some(file))
    };
    let mut imports_by_file = IndexMap::new();
    let mut import_edges_by_file = IndexMap::new();
    let mut imported_by_file: IndexMap<String, Vec<String>> = source_files
        .iter()
        .map(|unit| (unit.file.clone(), Vec::new()))
        .collect();
    for unit in source_files {
        let mut edges = Vec::new();
        let mut seen = HashSet::new();
        for literal in import_literals(&unit.syntax) {
            let target = match resolver.resolve(&unit.absolute_path, &literal.specifier.to_lossy())
            {
                Some(resolved) => in_scope(&resolved)?,
                None => None,
            };
            if let Some(file) = &target {
                imported_by_file
                    .get_mut(file)
                    .expect("in-scope loaded file")
                    .push(unit.file.clone());
            }
            if seen.insert((literal.specifier.clone(), literal.kind, literal.type_only)) {
                edges.push(ImportEdge {
                    specifier: literal.specifier,
                    kind: literal.kind,
                    type_only: literal.type_only,
                    target,
                });
            }
        }
        imports_by_file.insert(
            unit.file.clone(),
            sorted_names(edges.iter().map(|edge| edge.specifier.clone())),
        );
        edges.sort_by(|left, right| {
            locale_compare_units(left.specifier.units(), right.specifier.units())
                .then_with(|| locale_compare(left.kind.as_str(), right.kind.as_str()))
                .then_with(|| left.type_only.cmp(&right.type_only))
        });
        import_edges_by_file.insert(unit.file.clone(), edges);
    }
    for values in imported_by_file.values_mut() {
        let mut dedup: Vec<_> = values
            .drain(..)
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        dedup.sort_by(|left, right| locale_compare(left, right));
        *values = dedup;
    }
    Ok(ImportGraph {
        imports_by_file,
        imported_by_file,
        import_edges_by_file,
    })
}
