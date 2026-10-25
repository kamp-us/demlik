use super::callee::factory::FactoryResolver;
use super::callee::resolve::resolve_callees;
use super::chain_depth::compute_chain_depths;
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeFile, NativeNode, TsgoError, native_flag};
use crate::project::{locale_compare, locale_compare_units};
use crate::schema::CallSite;
use crate::schema::CallerSite;
use crate::syntax::imports::{ImportEdge, ImportGraph};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeResult {
    pub calls_by_id: IndexMap<String, Vec<CallSite>>,
    pub called_by_id: IndexMap<String, Vec<CallerSite>>,
    pub chain_depth_by_id: IndexMap<String, usize>,
    pub imports_by_file: IndexMap<String, Vec<crate::text::JsString>>,
    pub imported_by_file: IndexMap<String, Vec<String>>,
    pub import_edges_by_file: IndexMap<String, Vec<ImportEdge>>,
}

fn binding_identifiers(
    context: &TypeContext<'_, '_>,
    name: Option<NativeNode>,
    names: &mut IndexSet<String>,
) -> Result<(), TsgoError> {
    let Some(name) = name else {
        return Ok(());
    };
    if name.is_kind("Identifier") {
        names.insert(context.text(&name)?);
        return Ok(());
    }
    for node in name.descendants()? {
        if node.is_kind("BindingElement")
            && let Some(name) = node.node("name")?
            && name.is_kind("Identifier")
        {
            names.insert(context.text(&name)?);
        }
    }
    Ok(())
}
fn const_statement(statement: &NativeNode) -> Result<bool, TsgoError> {
    Ok(statement.is_kind("VariableStatement")
        && statement.required_node("declarationList")?.flags() & native_flag("BlockScoped")
            == native_flag("Const"))
}
fn literal_value(node: &NativeNode) -> Result<bool, TsgoError> {
    if node.is_kind("PrefixUnaryExpression") {
        return Ok(node.required_node("operand")?.is_kind("NumericLiteral"));
    }
    if node.is_kind("AsExpression") {
        return literal_value(&node.required_node("expression")?);
    }
    Ok([
        "NumericLiteral",
        "StringLiteral",
        "NoSubstitutionTemplateLiteral",
        "TrueKeyword",
        "FalseKeyword",
    ]
    .iter()
    .any(|kind| node.is_kind(kind)))
}
pub fn literal_constant_names(
    context: &TypeContext<'_, '_>,
    sources: &[NativeFile],
) -> Result<IndexSet<String>, TsgoError> {
    let mut names = IndexSet::new();
    for source in sources {
        for statement in source.root().nodes("statements")? {
            if !const_statement(&statement)? {
                continue;
            }
            for declaration in statement
                .required_node("declarationList")?
                .nodes("declarations")?
            {
                if let Some(initializer) = declaration.node("initializer")?
                    && literal_value(&initializer)?
                {
                    binding_identifiers(context, declaration.node("name")?, &mut names)?;
                }
            }
        }
    }
    Ok(names)
}
fn module_constant_names(
    context: &TypeContext<'_, '_>,
    source: &NativeFile,
    literals: &IndexSet<String>,
) -> Result<IndexSet<String>, TsgoError> {
    let mut bound = IndexSet::new();
    for statement in source.root().nodes("statements")? {
        if statement.is_kind("ImportDeclaration")
            && let Some(clause) = statement.node("importClause")?
            && !clause.type_only_import_clause()
        {
            if let Some(name) = clause.node("name")? {
                bound.insert(context.text(&name)?);
            }
            if let Some(bindings) = clause.node("namedBindings")? {
                if bindings.is_kind("NamespaceImport") {
                    bound.insert(context.text(&bindings.required_node("name")?)?);
                } else {
                    for named in bindings.nodes("elements")? {
                        if !named.type_only_specifier() {
                            bound.insert(context.text(&named.required_node("name")?)?);
                        }
                    }
                }
            }
        }
        if const_statement(&statement)? {
            for declaration in statement
                .required_node("declarationList")?
                .nodes("declarations")?
            {
                binding_identifiers(context, declaration.node("name")?, &mut bound)?;
            }
        }
    }
    Ok(bound
        .into_iter()
        .filter(|name| literals.contains(name))
        .collect())
}
fn value_position(identifier: &NativeNode) -> Result<bool, TsgoError> {
    let Some(parent) = identifier.parent()? else {
        return Ok(true);
    };
    if parent.is_kind("PropertyAssignment") || parent.is_kind("PropertyAccessExpression") {
        return Ok(parent.node("name")?.as_ref() != Some(identifier));
    }
    if parent.is_kind("CallExpression") || parent.is_kind("NewExpression") {
        return Ok(parent.node("expression")?.as_ref() != Some(identifier));
    }
    Ok(!parent.is_kind("BindingElement") && !parent.is_kind("ImportSpecifier"))
}
fn constant_arguments(
    context: &TypeContext<'_, '_>,
    call: &NativeNode,
    constants: &IndexSet<String>,
) -> Result<Vec<String>, TsgoError> {
    if constants.is_empty() {
        return Ok(Vec::new());
    }
    let mut found = IndexSet::new();
    for argument in call.nodes("arguments")? {
        let identifiers = if argument.is_kind("Identifier") {
            vec![argument]
        } else {
            argument
                .descendants()?
                .into_iter()
                .filter(|node| node.is_kind("Identifier"))
                .collect()
        };
        for identifier in identifiers {
            let text = context.text(&identifier)?;
            if constants.contains(&text) && value_position(&identifier)? {
                found.insert(text);
            }
        }
    }
    let mut names: Vec<_> = found.into_iter().collect();
    names.sort_by(|left, right| locale_compare(left, right));
    Ok(names)
}
fn dedup_calls(sites: Vec<CallSite>) -> Vec<CallSite> {
    let mut merged: IndexMap<(usize, crate::text::JsString), CallSite> = IndexMap::new();
    for site in sites {
        let key = (site.line, site.callee_id.clone());
        if let Some(held) = merged.get_mut(&key) {
            let mut names: Vec<_> = held
                .const_args
                .drain(..)
                .chain(site.const_args)
                .collect::<IndexSet<_>>()
                .into_iter()
                .collect();
            names.sort_by(|left, right| locale_compare(left, right));
            held.const_args = names;
        } else {
            merged.insert(key, site);
        }
    }
    let mut sites: Vec<_> = merged.into_values().collect();
    sites.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| locale_compare_units(left.callee_id.units(), right.callee_id.units()))
    });
    sites
}
fn own_calls(
    root: &NativeNode,
    node_to_id: &IndexMap<NativeNode, String>,
) -> Result<Vec<NativeNode>, TsgoError> {
    let mut pending: Vec<_> = root.children()?.into_iter().rev().collect();
    let mut calls = Vec::new();
    while let Some(node) = pending.pop() {
        if node_to_id.contains_key(&node) {
            continue;
        }
        if node.is_kind("CallExpression") {
            calls.push(node.clone());
        }
        pending.extend(node.children()?.into_iter().rev());
    }
    Ok(calls)
}

pub fn resolve_edges(
    context: &mut TypeContext<'_, '_>,
    imports: ImportGraph,
    ids: &[String],
) -> Result<EdgeResult, TsgoError> {
    resolve_edges_with_cross_runtime(context, imports, ids, None)
}

pub fn resolve_edges_with_cross_runtime(
    context: &mut TypeContext<'_, '_>,
    imports: ImportGraph,
    ids: &[String],
    mut cross_runtime: Option<&mut super::cross_runtime::CrossRuntimeResolver<'_>>,
) -> Result<EdgeResult, TsgoError> {
    let mut calls_by_id: IndexMap<String, Vec<CallSite>> =
        ids.iter().map(|id| (id.clone(), Vec::new())).collect();
    let sources: Vec<_> = context
        .files
        .iter()
        .map(|file| file.source.clone())
        .collect();
    let literals = literal_constant_names(context, &sources)?;
    let mut constants_by_source = std::collections::HashMap::new();
    let mut factories = FactoryResolver::new();
    let mut calls_by_node = IndexMap::new();
    for node in context.node_to_id.keys() {
        calls_by_node.insert(node.clone(), own_calls(node, &context.node_to_id)?);
    }
    let expressions: Vec<_> = calls_by_node
        .values()
        .flatten()
        .map(|call| call.required_node("expression"))
        .collect::<Result<_, _>>()?;
    context.prefetch_symbols(&expressions)?;
    let nodes: Vec<_> = context
        .node_to_id
        .iter()
        .map(|(node, id)| (node.clone(), id.clone()))
        .collect();
    for (node, id) in nodes {
        let source = node.source_file();
        let file = context.relative_path(&source);
        let key = source.file_name().to_path_buf();
        if !constants_by_source.contains_key(&key) {
            constants_by_source.insert(
                key.clone(),
                module_constant_names(context, &source, &literals)?,
            );
        }
        let constants = &constants_by_source[&key];
        let mut sites = Vec::new();
        for call in &calls_by_node[&node] {
            let cross = cross_runtime
                .as_deref_mut()
                .map(|resolver| resolver.resolve(context, call, &id, &file))
                .transpose()?
                .flatten();
            let callees = match cross {
                Some(callee) => vec![callee],
                None => resolve_callees(context, call, &mut factories)?,
            };
            for callee in callees {
                sites.push(CallSite {
                    callee_id: callee.callee_id,
                    declaration: callee.declaration,
                    line: context.start_line(call)?,
                    const_args: constant_arguments(context, call, constants)?,
                });
            }
        }
        let held = calls_by_id.entry(id).or_default();
        let mut accumulated = std::mem::take(held);
        accumulated.extend(sites);
        *held = dedup_calls(accumulated);
    }
    let mut called_by_id: IndexMap<String, Vec<CallerSite>> =
        ids.iter().map(|id| (id.clone(), Vec::new())).collect();
    for (caller, sites) in &calls_by_id {
        for site in sites {
            if let Ok(callee) = site.callee_id.to_utf8()
                && let Some(callers) = called_by_id.get_mut(&callee)
            {
                callers.push(CallerSite {
                    caller_id: caller.clone(),
                    line: site.line,
                });
            }
        }
    }
    for callers in called_by_id.values_mut() {
        let mut seen = HashSet::new();
        callers.retain(|site| seen.insert((site.line, site.caller_id.clone())));
        callers.sort_by(|left, right| {
            left.line
                .cmp(&right.line)
                .then_with(|| locale_compare(&left.caller_id, &right.caller_id))
        });
    }
    let chain_depth_by_id = compute_chain_depths(ids, &calls_by_id);
    Ok(EdgeResult {
        calls_by_id,
        called_by_id,
        chain_depth_by_id,
        imports_by_file: imports.imports_by_file,
        imported_by_file: imports.imported_by_file,
        import_edges_by_file: imports.import_edges_by_file,
    })
}
use std::collections::HashSet;

pub fn distinct_external_callers(id: &str, called_by: &[CallerSite]) -> usize {
    called_by
        .iter()
        .filter(|caller| caller.caller_id != id)
        .map(|caller| caller.caller_id.as_str())
        .collect::<HashSet<_>>()
        .len()
}
pub fn self_recursive_call_count(id: &str, called_by: &[CallerSite]) -> usize {
    called_by
        .iter()
        .filter(|caller| caller.caller_id == id)
        .count()
}
