use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeNode, TsgoError};
use crate::project::locale_compare;
use indexmap::IndexSet;
use std::collections::HashMap;

fn declaration_of(
    context: &mut TypeContext<'_, '_>,
    expression: &NativeNode,
) -> Result<Option<NativeNode>, TsgoError> {
    let Some(symbol) = context.symbol_of(expression)? else {
        return Ok(None);
    };
    let target = context.aliased_symbol(&symbol)?.unwrap_or(symbol);
    Ok(context.declarations_of(&target)?.into_iter().next())
}
fn function_like(node: &NativeNode) -> bool {
    [
        "FunctionDeclaration",
        "MethodDeclaration",
        "Constructor",
        "GetAccessor",
        "SetAccessor",
        "ArrowFunction",
        "FunctionExpression",
    ]
    .iter()
    .any(|kind| node.is_kind(kind))
}
fn implementation_of(declaration: &NativeNode) -> Result<Option<NativeNode>, TsgoError> {
    if declaration.node("body")?.is_some() {
        return Ok(Some(declaration.clone()));
    }
    let Some(name) = declaration
        .node("name")?
        .map(|name| name.literal_text())
        .transpose()?
        .flatten()
    else {
        return Ok(None);
    };
    let Some(parent) = declaration.parent()? else {
        return Ok(None);
    };
    for sibling in parent.children()? {
        if sibling.is_kind("FunctionDeclaration")
            && sibling
                .node("name")?
                .map(|name| name.literal_text())
                .transpose()?
                .flatten()
                .as_ref()
                == Some(&name)
            && sibling.node("body")?.is_some()
        {
            return Ok(Some(sibling));
        }
    }
    Ok(None)
}
fn factory_of(declaration: Option<NativeNode>) -> Result<Option<NativeNode>, TsgoError> {
    let Some(declaration) = declaration else {
        return Ok(None);
    };
    if declaration.is_kind("FunctionDeclaration") {
        return Ok(Some(
            implementation_of(&declaration)?.unwrap_or(declaration),
        ));
    }
    if !declaration.is_kind("VariableDeclaration") {
        return Ok(None);
    }
    Ok(declaration
        .node("initializer")?
        .filter(|node| node.is_kind("ArrowFunction") || node.is_kind("FunctionExpression")))
}
fn returned_functions(factory: &NativeNode) -> Result<Vec<NativeNode>, TsgoError> {
    let Some(body) = factory.node("body")? else {
        return Ok(Vec::new());
    };
    if body.is_kind("ArrowFunction") || body.is_kind("FunctionExpression") {
        return Ok(vec![body]);
    }
    let mut pending: Vec<_> = body.children()?.into_iter().rev().collect();
    let mut returned = Vec::new();
    while let Some(node) = pending.pop() {
        if function_like(&node) {
            continue;
        }
        if node.is_kind("ReturnStatement")
            && let Some(expression) = node.node("expression")?
            && (expression.is_kind("ArrowFunction") || expression.is_kind("FunctionExpression"))
        {
            returned.push(expression);
        }
        pending.extend(node.children()?.into_iter().rev());
    }
    Ok(returned)
}
struct ForwardedMember {
    parameter: usize,
    member: String,
}
fn forwarded_members(
    context: &mut TypeContext<'_, '_>,
    factory: &NativeNode,
) -> Result<Vec<ForwardedMember>, TsgoError> {
    let parameters = factory
        .nodes("parameters")?
        .into_iter()
        .map(|parameter| parameter.required_node("name"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut forwarded = Vec::new();
    for returned in returned_functions(factory)? {
        for call in returned
            .descendants()?
            .into_iter()
            .filter(|node| node.is_kind("CallExpression"))
        {
            let callee = call.required_node("expression")?;
            if !callee.is_kind("PropertyAccessExpression") {
                continue;
            }
            let receiver = declaration_of(context, &callee.required_node("expression")?)?;
            let mut parameter_index = None;
            for (index, name) in parameters.iter().enumerate() {
                if name.parent()? == receiver {
                    parameter_index = Some(index);
                    break;
                }
            }
            if let Some(parameter) = parameter_index {
                forwarded.push(ForwardedMember {
                    parameter,
                    member: context.text(&callee.required_node("name")?)?,
                });
            }
        }
    }
    Ok(forwarded)
}
fn member_implementation(
    context: &TypeContext<'_, '_>,
    config: Option<&NativeNode>,
    member: &str,
) -> Result<Option<NativeNode>, TsgoError> {
    let Some(config) = config.filter(|node| node.is_kind("ObjectLiteralExpression")) else {
        return Ok(None);
    };
    for property in config.nodes("properties")? {
        if let Some(name) = property.node("name")?
            && context.text(&name)? == member
        {
            if property.is_kind("MethodDeclaration") {
                return Ok(Some(property));
            }
            return if property.is_kind("PropertyAssignment") {
                property.node("initializer")
            } else {
                Ok(None)
            };
        }
    }
    Ok(None)
}

#[derive(Default)]
pub struct FactoryResolver {
    members_by_factory: HashMap<NativeNode, Vec<ForwardedMember>>,
}
impl FactoryResolver {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn resolve(
        &mut self,
        context: &mut TypeContext<'_, '_>,
        call: &NativeNode,
    ) -> Result<Vec<String>, TsgoError> {
        let Some(produced) = declaration_of(context, &call.required_node("expression")?)? else {
            return Ok(Vec::new());
        };
        if !produced.is_kind("VariableDeclaration") {
            return Ok(Vec::new());
        }
        let Some(construction) = produced
            .node("initializer")?
            .filter(|node| node.is_kind("CallExpression"))
        else {
            return Ok(Vec::new());
        };
        let Some(factory) = factory_of(declaration_of(
            context,
            &construction.required_node("expression")?,
        )?)?
        else {
            return Ok(Vec::new());
        };
        if !self.members_by_factory.contains_key(&factory) {
            let members = forwarded_members(context, &factory)?;
            self.members_by_factory.insert(factory.clone(), members);
        }
        let arguments = construction.nodes("arguments")?;
        let mut ids = IndexSet::new();
        for forwarded in &self.members_by_factory[&factory] {
            if let Some(implementation) = member_implementation(
                context,
                arguments.get(forwarded.parameter),
                &forwarded.member,
            )? && let Some(id) = context.node_to_id.get(&implementation)
            {
                ids.insert(id.clone());
            }
        }
        let mut ids: Vec<_> = ids.into_iter().collect();
        ids.sort_by(|left, right| locale_compare(left, right));
        Ok(ids)
    }
}
