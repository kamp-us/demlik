use super::rules::{CompiledRule, matching_rules};
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeNode, TsgoError};
use crate::project::locale_compare_units;
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};

pub type RuleMap = IndexMap<String, Vec<JsString>>;
fn base_class_name(
    context: &TypeContext<'_, '_>,
    method: &NativeNode,
) -> Result<Option<String>, TsgoError> {
    let Some(owner) = method
        .parent()?
        .filter(|node| node.is_kind("ClassDeclaration") || node.is_kind("ClassExpression"))
    else {
        return Ok(None);
    };
    for clause in owner.nodes("heritageClauses")? {
        if !clause.is_extends_clause() {
            continue;
        }
        let Some(heritage) = clause.nodes("types")?.into_iter().next() else {
            return Ok(None);
        };
        let text = context.text(&heritage.required_node("expression")?)?;
        return Ok(Some(text.rsplit('.').next().unwrap_or(&text).into()));
    }
    Ok(None)
}
fn public_instance_method(method: &NativeNode) -> Result<bool, TsgoError> {
    for modifier in method.nodes("modifiers")? {
        if modifier.is_kind("StaticKeyword")
            || modifier.is_kind("PrivateKeyword")
            || modifier.is_kind("ProtectedKeyword")
        {
            return Ok(false);
        }
    }
    Ok(!method.required_node("name")?.is_kind("PrivateIdentifier"))
}
pub fn public_method_rules_by_base_class(
    context: &TypeContext<'_, '_>,
    rules: &[CompiledRule],
) -> Result<RuleMap, TsgoError> {
    let mut out = RuleMap::new();
    for (node, id) in &context.node_to_id {
        if !node.is_kind("MethodDeclaration") || !public_instance_method(node)? {
            continue;
        }
        let Some(base) = base_class_name(context, node)? else {
            continue;
        };
        let keys = matching_rules(rules, &base.into());
        if !keys.is_empty() {
            out.insert(id.clone(), keys);
        }
    }
    Ok(out)
}
fn owning_object_literal(node: &NativeNode) -> Result<Option<NativeNode>, TsgoError> {
    let Some(parent) = node.parent()? else {
        return Ok(None);
    };
    if node.is_kind("MethodDeclaration") && parent.is_kind("ObjectLiteralExpression") {
        return Ok(Some(parent));
    }
    if !(node.is_kind("ArrowFunction") || node.is_kind("FunctionExpression"))
        || !parent.is_kind("PropertyAssignment")
    {
        return Ok(None);
    }
    Ok(parent
        .parent()?
        .filter(|node| node.is_kind("ObjectLiteralExpression")))
}
fn guard_keys(
    context: &TypeContext<'_, '_>,
    literal: &NativeNode,
    rules: &[CompiledRule],
) -> Result<Vec<JsString>, TsgoError> {
    let mut keys = IndexSet::new();
    for property in literal.nodes("properties")? {
        if property.is_kind("PropertyAssignment")
            || property.is_kind("ShorthandPropertyAssignment")
            || property.is_kind("MethodDeclaration")
        {
            keys.extend(matching_rules(
                rules,
                &context.text(&property.required_node("name")?)?.into(),
            ));
        }
    }
    let mut keys: Vec<_> = keys.into_iter().collect();
    keys.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    Ok(keys)
}
pub fn sibling_property_rules(
    context: &TypeContext<'_, '_>,
    rules: &[CompiledRule],
) -> Result<RuleMap, TsgoError> {
    let mut out = RuleMap::new();
    for (node, id) in &context.node_to_id {
        if let Some(literal) = owning_object_literal(node)? {
            let keys = guard_keys(context, &literal, rules)?;
            if !keys.is_empty() {
                out.insert(id.clone(), keys);
            }
        }
    }
    Ok(out)
}
fn property_named(
    context: &TypeContext<'_, '_>,
    literal: &NativeNode,
    name: &str,
) -> Result<Option<NativeNode>, TsgoError> {
    for property in literal.nodes("properties")? {
        if (property.is_kind("PropertyAssignment") || property.is_kind("MethodDeclaration"))
            && context.text(&property.required_node("name")?)? == name
        {
            return Ok(Some(property));
        }
    }
    Ok(None)
}
fn declaration_of(
    context: &mut TypeContext<'_, '_>,
    expression: Option<NativeNode>,
) -> Result<Option<NativeNode>, TsgoError> {
    let Some(expression) = expression.filter(|node| node.is_kind("Identifier")) else {
        return Ok(None);
    };
    let Some(symbol) = context.symbol_of(&expression)? else {
        return Ok(None);
    };
    let target = context.aliased_symbol(&symbol)?.unwrap_or(symbol);
    Ok(context.declarations_of(&target)?.into_iter().next())
}
fn refs_defined_by(
    context: &mut TypeContext<'_, '_>,
    type_config: &NativeNode,
) -> Result<Vec<NativeNode>, TsgoError> {
    let Some(call) = type_config
        .parent()?
        .filter(|node| node.is_kind("CallExpression"))
    else {
        return Ok(Vec::new());
    };
    let callee = call.required_node("expression")?;
    if callee.is_kind("PropertyAccessExpression")
        && context.text(&callee.required_node("name")?)? == "implement"
    {
        return Ok(declaration_of(context, callee.node("expression")?)?
            .into_iter()
            .collect());
    }
    let mut refs = Vec::new();
    if let Some(reference) = declaration_of(context, call.nodes("arguments")?.into_iter().next())? {
        refs.push(reference);
    }
    if let Some(owner) = call
        .parent()?
        .filter(|node| node.is_kind("VariableDeclaration"))
    {
        refs.push(owner);
    }
    Ok(refs)
}
fn type_config_owning(
    context: &TypeContext<'_, '_>,
    fields_property: &NativeNode,
) -> Result<Option<NativeNode>, TsgoError> {
    if !(fields_property.is_kind("PropertyAssignment")
        || fields_property.is_kind("MethodDeclaration"))
        || context.text(&fields_property.required_node("name")?)? != "fields"
    {
        return Ok(None);
    }
    Ok(fields_property
        .parent()?
        .filter(|node| node.is_kind("ObjectLiteralExpression")))
}
fn scoped_type_refs(
    context: &mut TypeContext<'_, '_>,
    rules: &[CompiledRule],
) -> Result<IndexMap<NativeNode, Vec<JsString>>, TsgoError> {
    let mut files = IndexMap::new();
    for node in context.node_to_id.keys() {
        let file = node.source_file();
        files.entry(file.file_name().to_path_buf()).or_insert(file);
    }
    let mut scoped = IndexMap::new();
    for file in files.into_values() {
        for literal in file
            .root()
            .descendants()?
            .into_iter()
            .filter(|node| node.is_kind("ObjectLiteralExpression"))
        {
            if property_named(context, &literal, "fields")?.is_none() {
                continue;
            }
            let keys = guard_keys(context, &literal, rules)?;
            if keys.is_empty() {
                continue;
            }
            for reference in refs_defined_by(context, &literal)? {
                scoped.insert(reference, keys.clone());
            }
        }
    }
    Ok(scoped)
}
fn skips_type_scopes(context: &TypeContext<'_, '_>, node: &NativeNode) -> Result<bool, TsgoError> {
    let Some(literal) = owning_object_literal(node)? else {
        return Ok(false);
    };
    let Some(skip) = property_named(context, &literal, "skipTypeScopes")? else {
        return Ok(false);
    };
    Ok(skip.is_kind("PropertyAssignment")
        && skip.required_node("initializer")?.is_kind("TrueKeyword"))
}
fn type_guard_of(
    context: &mut TypeContext<'_, '_>,
    node: &NativeNode,
    scoped: &IndexMap<NativeNode, Vec<JsString>>,
    rules: &[CompiledRule],
) -> Result<Vec<JsString>, TsgoError> {
    let mut ancestor = node.parent()?;
    while let Some(at) = ancestor {
        if let Some(config) = type_config_owning(context, &at)? {
            return guard_keys(context, &config, rules);
        }
        if at.is_kind("CallExpression") {
            let callee = at.required_node("expression")?;
            if callee.is_kind("PropertyAccessExpression")
                && [
                    "objectField",
                    "objectFields",
                    "interfaceField",
                    "interfaceFields",
                ]
                .contains(&context.text(&callee.required_node("name")?)?.as_str())
            {
                let Some(reference) =
                    declaration_of(context, at.nodes("arguments")?.into_iter().next())?
                else {
                    return Ok(Vec::new());
                };
                return Ok(scoped.get(&reference).cloned().unwrap_or_default());
            }
        }
        ancestor = at.parent()?;
    }
    Ok(Vec::new())
}
pub fn type_scope_rules(
    context: &mut TypeContext<'_, '_>,
    rules: &[CompiledRule],
) -> Result<RuleMap, TsgoError> {
    let scoped = scoped_type_refs(context, rules)?;
    let nodes: Vec<_> = context
        .node_to_id
        .iter()
        .map(|(node, id)| (node.clone(), id.clone()))
        .collect();
    let mut out = RuleMap::new();
    for (node, id) in nodes {
        if !skips_type_scopes(context, &node)? {
            let keys = type_guard_of(context, &node, &scoped, rules)?;
            if !keys.is_empty() {
                out.insert(id, keys);
            }
        }
    }
    Ok(out)
}
pub fn merge_rule_maps<'a>(maps: impl IntoIterator<Item = &'a RuleMap>) -> RuleMap {
    let mut merged: IndexMap<String, IndexSet<JsString>> = IndexMap::new();
    for map in maps {
        for (id, keys) in map {
            merged
                .entry(id.clone())
                .or_default()
                .extend(keys.iter().cloned());
        }
    }
    merged
        .into_iter()
        .map(|(id, keys)| {
            let mut keys: Vec<_> = keys.into_iter().collect();
            keys.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
            (id, keys)
        })
        .collect()
}
