use crate::extract::functions::DiscoveredFunction;
use crate::kinds::conventions::DEFAULT_EXPORT;
use crate::project::{SourceUnit, locale_compare_units};
use crate::syntax::file::NodeRef;
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};
use std::{collections::HashMap, rc::Rc};

fn module_export_name(node: Option<NodeRef<'_>>) -> Option<JsString> {
    let node = node?;
    match node.kind() {
        "Identifier" => node
            .string_units("name")
            .map(|units| JsString::from_units(units.into_owned())),
        "Literal" => node
            .string_units("value")
            .map(|units| JsString::from_units(units.into_owned())),
        _ => None,
    }
}
fn local_export_names(unit: &SourceUnit) -> IndexMap<JsString, Vec<JsString>> {
    let mut out: IndexMap<JsString, Vec<JsString>> = IndexMap::new();
    for statement in unit.syntax.root().nodes("body") {
        if statement.kind() == "ExportDefaultDeclaration" {
            let declaration = statement.node("declaration");
            if declaration.is_some_and(|node| node.kind() == "Identifier")
                && let Some(local) = module_export_name(declaration)
            {
                out.entry(local).or_default().push(DEFAULT_EXPORT.into());
            }
        } else if statement.kind() == "ExportNamedDeclaration" && statement.node("source").is_none()
        {
            for specifier in statement.nodes("specifiers") {
                if let (Some(local), Some(exported)) = (
                    module_export_name(specifier.node("local")),
                    module_export_name(specifier.node("exported")),
                ) {
                    out.entry(local).or_default().push(exported);
                }
            }
        }
    }
    out
}
fn declared(node: NodeRef<'_>) -> (Option<JsString>, Option<JsString>) {
    let parent = node.parent();
    if parent.is_some_and(|node| node.kind() == "ExportDefaultDeclaration") {
        return (Some(DEFAULT_EXPORT.into()), None);
    }
    if node.kind() == "FunctionDeclaration" {
        let id = module_export_name(node.node("id"));
        if parent.is_some_and(|node| node.kind() == "ExportNamedDeclaration") {
            return (id, None);
        }
        return (
            None,
            if parent.is_some_and(|node| node.kind() == "Program") {
                id
            } else {
                None
            },
        );
    }
    let Some(parent) = parent.filter(|node| node.kind() == "VariableDeclarator") else {
        return (None, None);
    };
    let id = module_export_name(parent.node("id"));
    let statement = parent.parent();
    if !statement.is_some_and(|node| node.kind() == "VariableDeclaration") {
        return (None, None);
    }
    let holder = statement.and_then(NodeRef::parent);
    if holder.is_some_and(|node| node.kind() == "ExportNamedDeclaration") {
        (id, None)
    } else {
        (
            None,
            if holder.is_some_and(|node| node.kind() == "Program") {
                id
            } else {
                None
            },
        )
    }
}
pub fn export_names_by_id(functions: &[DiscoveredFunction]) -> IndexMap<String, Vec<JsString>> {
    let mut locals: HashMap<*const SourceUnit, IndexMap<JsString, Vec<JsString>>> = HashMap::new();
    let mut out = IndexMap::new();
    for function in functions {
        let (direct, local) = declared(function.node());
        let mut names = IndexSet::new();
        names.extend(direct);
        if let Some(local) = local {
            names.extend(
                locals
                    .entry(Rc::as_ptr(&function.unit))
                    .or_insert_with(|| local_export_names(&function.unit))
                    .get(&local)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        if names.is_empty() {
            continue;
        }
        let mut names: Vec<_> = names.into_iter().collect();
        names.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
        out.insert(function.id.clone(), names);
    }
    out
}
