use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexMap;
use serde::Serialize;

use crate::extract::functions::{exported_local_names, is_test_file};
use crate::project::{Collation, CollationError, CollationInput, SourceUnit};
use crate::schema::{DeclarationKind, DeclarationNode, UseSite};
use crate::syntax::file::NodeRef;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDeclaration {
    pub id: String,
    pub name: String,
    pub kind: DeclarationKind,
    pub file: String,
    pub line: usize,
    pub is_exported: bool,
    pub is_test: bool,
    pub join_key: String,
}

struct Found {
    name: String,
    kind: DeclarationKind,
    line: usize,
    wrapped: bool,
}
fn identifier_name(node: Option<NodeRef<'_>>) -> Option<String> {
    let node = node?;
    (node.kind() == "Identifier").then(|| node.string("name").unwrap_or("undefined").to_owned())
}
fn declared_in(statement: NodeRef<'_>) -> Vec<Found> {
    let wrapped = matches!(
        statement.kind(),
        "ExportNamedDeclaration" | "ExportDefaultDeclaration"
    );
    let Some(inner) = (if wrapped {
        statement.node("declaration")
    } else {
        Some(statement)
    }) else {
        return Vec::new();
    };
    if inner.kind() == "VariableDeclaration" {
        if inner.string("kind") != Some("const") {
            return Vec::new();
        }
        return inner
            .nodes("declarations")
            .into_iter()
            .enumerate()
            .filter_map(|(index, declaration)| {
                let name = identifier_name(declaration.node("id"))?;
                if declaration.node("init").is_some_and(|init| {
                    matches!(
                        init.kind(),
                        "ArrowFunctionExpression" | "FunctionExpression"
                    )
                }) {
                    return None;
                }
                Some(Found {
                    name,
                    kind: DeclarationKind::Constant,
                    line: if index == 0 {
                        inner.start_line()
                    } else {
                        inner.syntax().line_of(declaration.start())
                    },
                    wrapped,
                })
            })
            .collect();
    }
    let kind = match inner.kind() {
        "TSTypeAliasDeclaration" => DeclarationKind::TypeAlias,
        "TSInterfaceDeclaration" => DeclarationKind::Interface,
        "TSEnumDeclaration" => DeclarationKind::Enum,
        "ClassDeclaration" => DeclarationKind::Class,
        _ => return Vec::new(),
    };
    let Some(name) =
        identifier_name(inner.node("id")).or_else(|| wrapped.then(|| "default".into()))
    else {
        return Vec::new();
    };
    vec![Found {
        name,
        kind,
        line: inner.start_line(),
        wrapped,
    }]
}

pub fn discover_declarations(
    source_files: &[Rc<SourceUnit>],
    collation: &Collation,
) -> Result<Vec<DiscoveredDeclaration>, CollationError> {
    let mut discovered = Vec::new();
    for unit in source_files {
        let found: Vec<_> = unit
            .syntax
            .root()
            .nodes("body")
            .into_iter()
            .flat_map(declared_in)
            .collect();
        let exported = exported_local_names(&unit.syntax);
        let mut totals = HashMap::new();
        for declaration in &found {
            *totals
                .entry(format!(
                    "{}:{}",
                    declaration.kind.as_str(),
                    declaration.name
                ))
                .or_insert(0usize) += 1;
        }
        let mut seen = HashMap::new();
        for declaration in found {
            let key = format!("{}:{}", declaration.kind.as_str(), declaration.name);
            let ordinal = seen.entry(key.clone()).or_insert(0usize);
            let suffix = if totals[&key] > 1 {
                format!("#{ordinal}")
            } else {
                String::new()
            };
            let id = format!("{}:{key}{suffix}", unit.file);
            let join_key = format!("{key}#{ordinal}");
            *ordinal += 1;
            let is_exported = declaration.wrapped || exported.contains(&declaration.name);
            discovered.push(DiscoveredDeclaration {
                id,
                name: declaration.name,
                kind: declaration.kind,
                file: unit.file.clone(),
                line: declaration.line,
                is_exported,
                is_test: is_test_file(&unit.file),
                join_key,
            });
        }
    }
    let mut discovered = discovered
        .into_iter()
        .map(|row| {
            let file = CollationInput::from_text(&row.file)?;
            let kind = CollationInput::from_text(row.kind.as_str())?;
            let id = CollationInput::from_text(&row.id)?;
            Ok((row, file, kind, id))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    discovered.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| left.0.line.cmp(&right.0.line))
            .then_with(|| collation.compare(&left.2, &right.2))
            .then_with(|| collation.compare(&left.3, &right.3))
    });
    Ok(discovered.into_iter().map(|(row, _, _, _)| row).collect())
}

pub fn build_declaration_nodes(
    source_files: &[Rc<SourceUnit>],
    uses_by_id: Option<&IndexMap<String, Vec<UseSite>>>,
    collation: &Collation,
) -> Result<Vec<DeclarationNode>, CollationError> {
    Ok(discover_declarations(source_files, collation)?
        .into_iter()
        .map(|declaration| {
            let uses = uses_by_id
                .and_then(|uses| uses.get(&declaration.id))
                .cloned();
            DeclarationNode {
                id: declaration.id,
                name: declaration.name,
                kind: declaration.kind,
                file: declaration.file,
                line: declaration.line,
                is_exported: declaration.is_exported,
                is_test: declaration.is_test,
                uses,
            }
        })
        .collect())
}
