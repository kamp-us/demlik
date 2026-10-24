use super::discover::DiscoveredDeclaration;
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeFile, NativeNode, NativeSymbol, TsgoError, native_flag};
use crate::project::locale_compare;
use crate::schema::{DeclarationKind, UseSite};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationUses {
    pub uses_by_id: IndexMap<String, Vec<UseSite>>,
    pub unjoined: Vec<String>,
}
fn top_level(
    context: &TypeContext<'_, '_>,
    statement: &NativeNode,
) -> Result<Vec<(NativeNode, DeclarationKind, String)>, TsgoError> {
    if statement.is_kind("VariableStatement") {
        let list = statement.required_node("declarationList")?;
        if list.flags() & native_flag("BlockScoped") != native_flag("Const") {
            return Ok(Vec::new());
        }
        let mut constants = Vec::new();
        for declaration in list.nodes("declarations")? {
            let name = declaration.required_node("name")?;
            if !name.is_kind("Identifier")
                || declaration.node("initializer")?.is_some_and(|node| {
                    node.is_kind("ArrowFunction") || node.is_kind("FunctionExpression")
                })
            {
                continue;
            }
            constants.push((declaration, DeclarationKind::Constant, context.text(&name)?));
        }
        return Ok(constants);
    }
    let kind = if statement.is_kind("TypeAliasDeclaration") {
        DeclarationKind::TypeAlias
    } else if statement.is_kind("InterfaceDeclaration") {
        DeclarationKind::Interface
    } else if statement.is_kind("EnumDeclaration") {
        DeclarationKind::Enum
    } else if statement.is_kind("ClassDeclaration") {
        DeclarationKind::Class
    } else {
        return Ok(Vec::new());
    };
    let name = statement
        .node("name")?
        .map(|name| context.text(&name))
        .transpose()?
        .unwrap_or_else(|| "default".into());
    Ok(vec![(statement.clone(), kind, name)])
}
fn join(
    context: &TypeContext<'_, '_>,
    declarations: &[DiscoveredDeclaration],
) -> Result<IndexMap<NativeNode, String>, TsgoError> {
    let mut wanted: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
    for declaration in declarations {
        wanted
            .entry(&declaration.file)
            .or_default()
            .insert(&declaration.join_key, &declaration.id);
    }
    let mut joined = IndexMap::new();
    for file in &context.files {
        let Some(by_key) = wanted.get(file.unit.file.as_str()) else {
            continue;
        };
        let mut seen = HashMap::new();
        for statement in file.source.root().nodes("statements")? {
            for (node, kind, name) in top_level(context, &statement)? {
                let key = format!("{}:{name}", kind.as_str());
                let ordinal = seen.entry(key.clone()).or_insert(0usize);
                if let Some(id) = by_key.get(format!("{key}#{ordinal}").as_str()) {
                    joined.insert(node, (*id).to_owned());
                }
                *ordinal += 1;
            }
        }
    }
    Ok(joined)
}
fn imported_names(
    context: &TypeContext<'_, '_>,
    source: &NativeFile,
) -> Result<Vec<String>, TsgoError> {
    let mut names = Vec::new();
    for statement in source.root().nodes("statements")? {
        if statement.is_kind("ImportEqualsDeclaration") {
            names.push(context.text(&statement.required_node("name")?)?);
        }
        if !statement.is_kind("ImportDeclaration") {
            continue;
        }
        let Some(clause) = statement.node("importClause")? else {
            continue;
        };
        if let Some(name) = clause.node("name")? {
            names.push(context.text(&name)?);
        }
        if let Some(bindings) = clause.node("namedBindings")? {
            if bindings.is_kind("NamespaceImport") {
                names.push(context.text(&bindings.required_node("name")?)?);
            } else {
                for element in bindings.nodes("elements")? {
                    names.push(context.text(&element.required_node("name")?)?);
                }
            }
        }
    }
    Ok(names)
}
fn resolved_symbol(
    context: &mut TypeContext<'_, '_>,
    identifier: &NativeNode,
) -> Result<Option<NativeSymbol>, TsgoError> {
    let symbol = if let Some(parent) = identifier.parent()?
        && parent.is_kind("ShorthandPropertyAssignment")
        && parent.node("name")?.as_ref() == Some(identifier)
    {
        context.shorthand_value_symbol(&parent)?
    } else {
        context.symbol_of(identifier)?
    };
    let Some(symbol) = symbol else {
        return Ok(None);
    };
    Ok(Some(context.aliased_symbol(&symbol)?.unwrap_or(symbol)))
}
pub fn resolve_declaration_uses(
    context: &mut TypeContext<'_, '_>,
    declarations: &[DiscoveredDeclaration],
) -> Result<DeclarationUses, TsgoError> {
    let node_to_id = join(context, declarations)?;
    let mut sites: IndexMap<String, IndexMap<String, UseSite>> = node_to_id
        .values()
        .map(|id| (id.clone(), IndexMap::new()))
        .collect();
    let declared_names: IndexSet<_> = declarations
        .iter()
        .map(|declaration| declaration.name.clone())
        .collect();
    for file in context.files.clone() {
        let mut names = declared_names.clone();
        names.extend(imported_names(context, &file.source)?);
        let mut identifiers = Vec::new();
        for node in file.source.root().descendants()? {
            if node.is_kind("Identifier") && names.contains(&context.text(&node)?) {
                identifiers.push(node);
            }
        }
        context.prefetch_symbols(&identifiers)?;
        for identifier in identifiers {
            let Some(symbol) = resolved_symbol(context, &identifier)? else {
                continue;
            };
            for declaration in context.declarations_of(&symbol)? {
                let Some(id) = node_to_id.get(&declaration) else {
                    continue;
                };
                if declaration.node("name")?.as_ref() == Some(&identifier) {
                    continue;
                }
                let line = context.start_line(&identifier)?;
                sites
                    .get_mut(id)
                    .expect("joined declaration bucket")
                    .insert(
                        format!("{}:{line}", file.unit.file),
                        UseSite {
                            file: file.unit.file.clone(),
                            line,
                        },
                    );
            }
        }
    }
    let uses_by_id: IndexMap<_, _> = sites
        .into_iter()
        .map(|(id, sites)| {
            let mut sites: Vec<_> = sites.into_values().collect();
            sites.sort_by(|left, right| {
                locale_compare(&left.file, &right.file).then_with(|| left.line.cmp(&right.line))
            });
            (id, sites)
        })
        .collect();
    let unjoined = declarations
        .iter()
        .filter(|declaration| !uses_by_id.contains_key(&declaration.id))
        .map(|declaration| declaration.id.clone())
        .collect();
    Ok(DeclarationUses {
        uses_by_id,
        unjoined,
    })
}
