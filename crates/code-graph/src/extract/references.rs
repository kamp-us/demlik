use super::ResolveError;
use super::functions::is_test_file;
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeNode, NativeSymbol, TsgoError};
use crate::project::{Collation, CollationError, CollationInput};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

const MODULE_SCOPE: &str = "<module-scope>";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceResult {
    pub references_by_id: IndexMap<String, Vec<String>>,
    pub module_scope_roots: Vec<String>,
    pub test_module_scope_roots: Vec<String>,
    pub identifier_files: IndexMap<String, Vec<String>>,
}
#[derive(Default)]
struct Accum {
    references: IndexMap<String, IndexSet<String>>,
    module_roots: IndexSet<String>,
    test_roots: IndexSet<String>,
    identifier_files: IndexMap<String, IndexSet<String>>,
}
fn owner_id(node: &NativeNode, ids: &IndexMap<NativeNode, String>) -> Result<String, TsgoError> {
    let mut current = node.parent()?;
    while let Some(node) = current {
        if let Some(id) = ids.get(&node) {
            return Ok(id.clone());
        }
        current = node.parent()?;
    }
    Ok(MODULE_SCOPE.into())
}
fn module_clause(node: &NativeNode) -> Result<bool, TsgoError> {
    let mut current = Some(node.clone());
    while let Some(node) = current {
        if node.is_kind("ImportDeclaration") || node.is_kind("ExportDeclaration") {
            return Ok(true);
        }
        if node.is_statement() {
            return Ok(false);
        }
        current = node.parent()?;
    }
    Ok(false)
}
fn declaration_name(node: &NativeNode) -> Result<bool, TsgoError> {
    Ok(if let Some(parent) = node.parent()? {
        parent.node("name")?.as_ref() == Some(node)
    } else {
        false
    })
}
fn callee_position(node: &NativeNode) -> Result<bool, TsgoError> {
    let Some(parent) = node.parent()? else {
        return Ok(false);
    };
    if parent.is_kind("CallExpression") {
        return Ok(parent.node("expression")?.as_ref() == Some(node));
    }
    if parent.is_kind("PropertyAccessExpression")
        && parent.node("name")?.as_ref() == Some(node)
        && let Some(grand) = parent.parent()?
    {
        return Ok(
            grand.is_kind("CallExpression") && grand.node("expression")?.as_ref() == Some(&parent)
        );
    }
    Ok(false)
}
fn candidates(
    context: &mut TypeContext<'_, '_>,
    node: &NativeNode,
) -> Result<Vec<NativeSymbol>, TsgoError> {
    let Some(symbol) = context.symbol_of(node)? else {
        return Ok(Vec::new());
    };
    Ok(vec![context.aliased_symbol(&symbol)?.unwrap_or(symbol)])
}
fn id_of_declaration(
    node: &NativeNode,
    ids: &IndexMap<NativeNode, String>,
) -> Result<Option<String>, TsgoError> {
    if let Some(id) = ids.get(node) {
        return Ok(Some(id.clone()));
    }
    if node.is_kind("VariableDeclaration")
        || node.is_kind("PropertyAssignment")
        || node.is_kind("PropertyDeclaration")
    {
        return Ok(node
            .node("initializer")?
            .and_then(|node| ids.get(&node).cloned()));
    }
    Ok(None)
}
fn referenced_id(
    context: &mut TypeContext<'_, '_>,
    node: &NativeNode,
) -> Result<Option<String>, TsgoError> {
    for symbol in candidates(context, node)? {
        for declaration in context.declarations_of(&symbol)? {
            if let Some(id) = id_of_declaration(&declaration, &context.node_to_id)? {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}
fn add(accum: &mut Accum, owner: String, target: String, test: bool) {
    if owner == MODULE_SCOPE {
        if test {
            accum.test_roots.insert(target);
        } else {
            accum.module_roots.insert(target);
        }
    } else {
        accum.references.entry(owner).or_default().insert(target);
    }
}
fn sorted(values: IndexSet<String>, collation: &Collation) -> Result<Vec<String>, CollationError> {
    let mut values = values
        .into_iter()
        .map(|value| CollationInput::from_text(&value).map(|key| (value, key)))
        .collect::<Result<Vec<_>, _>>()?;
    values.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(values.into_iter().map(|(value, _)| value).collect())
}
fn freeze(
    values: IndexMap<String, IndexSet<String>>,
    collation: &Collation,
) -> Result<IndexMap<String, Vec<String>>, CollationError> {
    let mut values = values
        .into_iter()
        .map(|(id, rows)| CollationInput::from_text(&id).map(|key| (id, rows, key)))
        .collect::<Result<Vec<_>, _>>()?;
    values.sort_by(|a, b| collation.compare(&a.2, &b.2));
    values
        .into_iter()
        .map(|(id, rows, _)| Ok((id, sorted(rows, collation)?)))
        .collect()
}

pub fn resolve_references(
    context: &mut TypeContext<'_, '_>,
    known_names: &IndexSet<String>,
    exports_by_file: &IndexMap<String, Vec<String>>,
    collation: &Collation,
) -> Result<ReferenceResult, ResolveError> {
    let mut accum = Accum::default();
    let mut methods_by_class: IndexMap<NativeNode, Vec<String>> = IndexMap::new();
    for (node, id) in &context.node_to_id {
        if let Some(parent) = node.parent()?
            && (parent.is_kind("ClassDeclaration") || parent.is_kind("ClassExpression"))
        {
            methods_by_class.entry(parent).or_default().push(id.clone());
        }
    }
    for file in context.files.clone() {
        let test = is_test_file(&file.unit.file);
        let nodes = file.source.root().descendants()?;
        let identifiers: Vec<_> = nodes
            .iter()
            .filter(|node| node.is_kind("Identifier"))
            .cloned()
            .collect();
        context.prefetch_symbols(&identifiers)?;
        for node in nodes {
            if node.is_kind("CallExpression") {
                let owner = owner_id(&node, &context.node_to_id)?;
                if context.text(&node.required_node("expression")?)? == "import" {
                    if let Some(literal) = node
                        .nodes("arguments")?
                        .first()
                        .filter(|node| node.is_kind("StringLiteral"))
                        && let Some(symbol) = context.symbol_of(literal)?
                        && let Some(declaration) = context.declarations_of(&symbol)?.first()
                    {
                        let target = context.relative_path(&declaration.source_file());
                        for id in exports_by_file.get(&target).into_iter().flatten() {
                            add(&mut accum, owner.clone(), id.clone(), test);
                        }
                    }
                } else {
                    for argument in node.nodes("arguments")? {
                        if let Some(id) = context.node_to_id.get(&argument) {
                            add(&mut accum, owner.clone(), id.clone(), test);
                            continue;
                        }
                        for descendant in argument.descendants()? {
                            if let Some(id) = context.node_to_id.get(&descendant) {
                                add(&mut accum, owner.clone(), id.clone(), test);
                            }
                        }
                    }
                }
            } else if node.is_kind("Identifier") {
                let name = context.text(&node)?;
                let owner = owner_id(&node, &context.node_to_id)?;
                if owner == MODULE_SCOPE {
                    for symbol in candidates(context, &node)? {
                        for declaration in context.declarations_of(&symbol)? {
                            for id in methods_by_class.get(&declaration).into_iter().flatten() {
                                add(&mut accum, MODULE_SCOPE.into(), id.clone(), test);
                            }
                        }
                    }
                }
                if !known_names.contains(&name) {
                    continue;
                }
                accum
                    .identifier_files
                    .entry(name)
                    .or_default()
                    .insert(file.unit.file.clone());
                if module_clause(&node)?
                    || declaration_name(&node)?
                    || owner != MODULE_SCOPE && callee_position(&node)?
                {
                    continue;
                }
                if let Some(id) = referenced_id(context, &node)? {
                    add(&mut accum, owner, id, test);
                }
            } else if let Some(id) = context.node_to_id.get(&node)
                && let Some(parent) = node.parent()?
            {
                let member = parent.is_kind("ObjectLiteralExpression")
                    || parent.is_kind("PropertyAssignment")
                        && parent
                            .parent()?
                            .is_some_and(|grand| grand.is_kind("ObjectLiteralExpression"));
                if member {
                    add(
                        &mut accum,
                        owner_id(&node, &context.node_to_id)?,
                        id.clone(),
                        test,
                    );
                }
            }
        }
    }
    Ok(ReferenceResult {
        references_by_id: freeze(accum.references, collation)?,
        module_scope_roots: sorted(accum.module_roots, collation)?,
        test_module_scope_roots: sorted(accum.test_roots, collation)?,
        identifier_files: freeze(accum.identifier_files, collation)?,
    })
}
