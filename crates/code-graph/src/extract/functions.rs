use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexSet;
use serde::Serialize;

use crate::project::{SourceUnit, locale_compare};
use crate::syntax::file::{NodeRef, SyntaxFile, is_accessor_kind, is_method_value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FunctionKind {
    Function,
    Method,
    Constructor,
    Getter,
    Setter,
    Arrow,
    FunctionExpression,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFunction {
    #[serde(skip)]
    pub unit: Rc<SourceUnit>,
    #[serde(skip)]
    node_index: usize,
    pub id: String,
    pub name: String,
    pub kind: FunctionKind,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub is_exported: bool,
    pub is_test: bool,
}

impl DiscoveredFunction {
    pub fn node(&self) -> NodeRef<'_> {
        self.unit.syntax.node_at(self.node_index)
    }
}

#[derive(Debug, Serialize)]
pub struct FunctionDiscovery {
    pub functions: Vec<DiscoveredFunction>,
}

pub fn is_test_file(file: &str) -> bool {
    let Some(stem) = file
        .strip_suffix(".ts")
        .or_else(|| file.strip_suffix(".tsx"))
    else {
        return false;
    };
    let stem = stem.strip_suffix("-d").unwrap_or(stem);
    stem.ends_with(".test") || stem.ends_with(".spec")
}

pub fn is_class_field(node: NodeRef<'_>) -> bool {
    matches!(
        node.kind(),
        "PropertyDefinition"
            | "TSAbstractPropertyDefinition"
            | "AccessorProperty"
            | "TSAbstractAccessorProperty"
    )
}

pub fn is_property_assignment(node: NodeRef<'_>) -> bool {
    node.kind() == "Property"
        && node
            .parent()
            .is_some_and(|parent| parent.kind() == "ObjectExpression")
        && node.string("kind") == Some("init")
        && node.boolean("method") != Some(true)
        && node.boolean("shorthand") != Some(true)
}

pub fn name_text(holder: NodeRef<'_>, key: NodeRef<'_>) -> String {
    let syntax = holder.syntax();
    if holder.boolean("computed") == Some(true) {
        let units = syntax.text_units();
        let open = units[..key.start().min(units.len().saturating_sub(1)) + 1]
            .iter()
            .rposition(|ch| *ch == 91)
            .unwrap_or(units.len().saturating_sub(1));
        let close = units[key.end().min(units.len())..]
            .iter()
            .position(|ch| *ch == 93)
            .map_or(0, |offset| key.end() + offset + 1);
        return syntax.slice(open, close);
    }
    if key.kind() == "Identifier" {
        key.string("name").unwrap_or("undefined").to_owned()
    } else {
        key.text()
    }
}

pub fn binding_name_text(id: NodeRef<'_>) -> String {
    if id.kind() == "Identifier" {
        return id.string("name").unwrap_or("undefined").to_owned();
    }
    let end = id
        .node("typeAnnotation")
        .map_or(id.end(), |annotation| annotation.start());
    id.syntax()
        .slice(id.start(), end)
        .trim_end_matches(js_space)
        .to_owned()
}

pub(crate) use crate::text::js_space;

fn name_from_binding(node: NodeRef<'_>) -> Option<String> {
    let parent = node.parent()?;
    if parent.kind() == "VariableDeclarator" {
        return parent.node("id").map(binding_name_text);
    }
    if is_property_assignment(parent) || is_class_field(parent) {
        return parent.node("key").map(|key| name_text(parent, key));
    }
    matches!(
        parent.kind(),
        "ExportDefaultDeclaration" | "TSExportAssignment"
    )
    .then(|| "default".into())
}

fn member_classified(node: NodeRef<'_>) -> (FunctionKind, String) {
    match node.string("kind") {
        Some("constructor") => (FunctionKind::Constructor, "constructor".into()),
        kind => {
            let kind = match kind {
                Some("get") => FunctionKind::Getter,
                Some("set") => FunctionKind::Setter,
                _ => FunctionKind::Method,
            };
            let name = node
                .node("key")
                .map_or_else(String::new, |key| name_text(node, key));
            (kind, name)
        }
    }
}

fn classify_member(node: NodeRef<'_>) -> Option<(FunctionKind, String)> {
    (node.node("value")?.kind() == "FunctionExpression").then(|| member_classified(node))
}

fn classify(node: NodeRef<'_>) -> Option<(FunctionKind, String)> {
    match node.kind() {
        "FunctionDeclaration" => {
            node.node("body")?;
            let name = match node.node("id") {
                Some(id) => id.string("name")?.into(),
                None if node
                    .parent()
                    .is_some_and(|parent| parent.kind() == "ExportDefaultDeclaration") =>
                {
                    "default".into()
                }
                None => return None,
            };
            Some((FunctionKind::Function, name))
        }
        "MethodDefinition" | "TSAbstractMethodDefinition" => classify_member(node),
        "Property"
            if node
                .parent()
                .is_some_and(|parent| parent.kind() == "ObjectExpression")
                && (node.boolean("method") == Some(true) || is_accessor_kind(node)) =>
        {
            classify_member(node)
        }
        "TSMethodSignature" if is_accessor_kind(node) => Some(member_classified(node)),
        "ArrowFunctionExpression" => {
            name_from_binding(node).map(|name| (FunctionKind::Arrow, name))
        }
        "FunctionExpression" if !is_method_value(node) => {
            let name = node
                .node("id")
                .and_then(|id| id.string("name"))
                .map(str::to_owned)
                .or_else(|| name_from_binding(node))?;
            Some((FunctionKind::FunctionExpression, name))
        }
        _ => None,
    }
}

fn identifier_name(node: Option<NodeRef<'_>>) -> Option<String> {
    node.filter(|node| node.kind() == "Identifier")?
        .string("name")
        .map(str::to_owned)
}

pub fn exported_local_names(syntax: &SyntaxFile) -> IndexSet<String> {
    let mut names = IndexSet::new();
    for statement in syntax.root().nodes("body") {
        match statement.kind() {
            "ExportNamedDeclaration" => {
                if statement.node("source").is_none() {
                    for specifier in statement.nodes("specifiers") {
                        if let Some(name) = identifier_name(specifier.node("local")) {
                            names.insert(name);
                        }
                    }
                }
                if let Some(name) = identifier_name(
                    statement
                        .node("declaration")
                        .and_then(|declaration| declaration.node("id")),
                ) {
                    names.insert(name);
                }
            }
            "ExportDefaultDeclaration" => {
                if let Some(name) = identifier_name(statement.node("declaration")) {
                    names.insert(name);
                }
            }
            "TSExportAssignment" => {
                if let Some(name) = identifier_name(statement.node("expression")) {
                    names.insert(name);
                }
            }
            _ => {}
        }
    }
    names
}

fn export_wrapped(node: NodeRef<'_>) -> bool {
    node.parent().is_some_and(|parent| {
        matches!(
            parent.kind(),
            "ExportNamedDeclaration" | "ExportDefaultDeclaration"
        )
    })
}

fn expression_exported(node: NodeRef<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    if matches!(
        parent.kind(),
        "ExportDefaultDeclaration" | "TSExportAssignment"
    ) {
        return true;
    }
    parent.kind() == "VariableDeclarator"
        && parent.parent().is_some_and(|statement| {
            statement.kind() == "VariableDeclaration" && export_wrapped(statement)
        })
}

fn callable_exported(node: NodeRef<'_>, kind: FunctionKind, exported: &IndexSet<String>) -> bool {
    match kind {
        FunctionKind::Arrow | FunctionKind::FunctionExpression => expression_exported(node),
        FunctionKind::Function => {
            export_wrapped(node)
                || (node
                    .parent()
                    .is_some_and(|parent| parent.kind() == "Program")
                    && node
                        .node("id")
                        .and_then(|id| id.string("name"))
                        .is_some_and(|name| exported.contains(name)))
        }
        _ => false,
    }
}

pub fn discover_functions(source_files: &[Rc<SourceUnit>]) -> FunctionDiscovery {
    let mut functions = Vec::new();
    for unit in source_files {
        let mut pending: Vec<_> = unit.syntax.root().children().into_iter().rev().collect();
        let mut raw = Vec::new();
        while let Some(node) = pending.pop() {
            if let Some((kind, name)) = classify(node) {
                raw.push((node, kind, name));
            }
            pending.extend(node.children().into_iter().rev());
        }
        let exported = exported_local_names(&unit.syntax);
        let mut counts = HashMap::<String, usize>::new();
        for (_, _, name) in &raw {
            *counts.entry(format!("{}:{name}", unit.file)).or_default() += 1;
        }
        let mut ordinals = HashMap::<String, usize>::new();
        for (node, kind, name) in raw {
            let base = format!("{}:{name}", unit.file);
            let id = if counts[&base] > 1 {
                let ordinal = ordinals.entry(base.clone()).or_default();
                let id = format!("{base}#{ordinal}");
                *ordinal += 1;
                id
            } else {
                base
            };
            functions.push(DiscoveredFunction {
                unit: unit.clone(),
                node_index: node.index(),
                id,
                name,
                kind,
                file: unit.file.clone(),
                start_line: node.start_line(),
                end_line: node.end_line(),
                is_exported: callable_exported(node, kind, &exported),
                is_test: is_test_file(&unit.file),
            });
        }
    }
    functions.sort_by(|left, right| {
        locale_compare(&left.file, &right.file)
            .then(left.start_line.cmp(&right.start_line))
            .then_with(|| locale_compare(&left.name, &right.name))
            .then_with(|| locale_compare(&left.id, &right.id))
    });
    FunctionDiscovery { functions }
}
