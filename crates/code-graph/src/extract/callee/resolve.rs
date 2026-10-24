use super::factory::FactoryResolver;
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{LibraryKind, NativeNode, TsgoError};
use crate::text::JsString;
use indexmap::IndexMap;

pub struct ResolvedCallee {
    pub callee_id: JsString,
    pub declaration: Option<JsString>,
}
pub fn enclosing_id(
    node: &NativeNode,
    node_to_id: &IndexMap<NativeNode, String>,
) -> Result<Option<String>, TsgoError> {
    let mut current = Some(node.clone());
    while let Some(node) = current {
        if let Some(id) = node_to_id.get(&node) {
            return Ok(Some(id.clone()));
        }
        current = node.parent()?;
    }
    Ok(None)
}
fn implementation(declaration: &NativeNode) -> Result<bool, TsgoError> {
    if declaration.is_kind("FunctionDeclaration") || declaration.is_kind("MethodDeclaration") {
        return Ok(declaration.node("body")?.is_some());
    }
    if !declaration.is_kind("VariableDeclaration") {
        return Ok(false);
    }
    Ok(declaration
        .node("initializer")?
        .is_some_and(|node| node.is_kind("ArrowFunction") || node.is_kind("FunctionExpression")))
}
fn workspace_id(
    context: &mut TypeContext<'_, '_>,
    declaration: &NativeNode,
    name: &str,
) -> Result<Option<JsString>, TsgoError> {
    let source = declaration.source_file();
    if source.is_declaration_file()
        || context.library_kind(&source)?.is_some()
        || source
            .file_name()
            .to_string_lossy()
            .contains("/node_modules/")
        || !implementation(declaration)?
    {
        return Ok(None);
    }
    Ok(Some(
        format!("workspace:{}:{name}", context.relative_path(&source)).into(),
    ))
}
fn package_of(file: &str) -> Option<String> {
    let (_, tail) = file.rsplit_once("/node_modules/")?;
    let mut segments = tail.split('/');
    let first = segments.next()?;
    let name = if first.starts_with('@') {
        segments
            .next()
            .map_or_else(|| first.to_owned(), |second| format!("{first}/{second}"))
    } else {
        first.to_owned()
    };
    (!name.is_empty()).then(|| name.strip_prefix("@types/").unwrap_or(&name).to_owned())
}
fn ambient_module_name(declaration: &NativeNode) -> Result<Option<JsString>, TsgoError> {
    let mut current = declaration.parent()?;
    while let Some(ancestor) = current {
        if ancestor.is_kind("ModuleDeclaration")
            && let Some(name) = ancestor.node("name")?
            && name.is_kind("StringLiteral")
        {
            return name.literal_text();
        }
        current = ancestor.parent()?;
    }
    Ok(None)
}
fn origin(
    context: &mut TypeContext<'_, '_>,
    declaration: &NativeNode,
) -> Result<JsString, TsgoError> {
    if let Some(name) = ambient_module_name(declaration)? {
        return Ok(name);
    }
    let source = declaration.source_file();
    if context.library_kind(&source)?.is_some() {
        return Ok("typescript".into());
    }
    Ok(package_of(&source.file_name().to_string_lossy())
        .unwrap_or_else(|| "workspace".into())
        .into())
}
fn owner_name(declaration: &NativeNode) -> Result<Option<JsString>, TsgoError> {
    let Some(parent) = declaration.parent()? else {
        return Ok(None);
    };
    if parent.is_kind("ClassDeclaration")
        || parent.is_kind("ClassExpression")
        || parent.is_kind("InterfaceDeclaration")
    {
        return parent
            .node("name")?
            .map(|name| name.literal_text())
            .transpose()
            .map(Option::flatten);
    }
    if !parent.is_kind("TypeLiteral") {
        return Ok(None);
    }
    let Some(alias) = parent
        .parent()?
        .filter(|node| node.is_kind("TypeAliasDeclaration"))
    else {
        return Ok(None);
    };
    alias.required_node("name")?.literal_text()
}
fn qualified_declaration(
    context: &mut TypeContext<'_, '_>,
    declaration: &NativeNode,
    name: &str,
) -> Result<JsString, TsgoError> {
    let mut qualified = origin(context, declaration)?;
    qualified.push_str(":");
    if let Some(owner) = owner_name(declaration)? {
        qualified.extend(&owner);
        qualified.push_str(".");
    }
    qualified.push_str(name);
    Ok(qualified)
}
pub fn simple_callee_name(
    context: &TypeContext<'_, '_>,
    expression: &NativeNode,
) -> Result<JsString, TsgoError> {
    if expression.is_kind("PropertyAccessExpression") {
        return Ok(context.text(&expression.required_node("name")?)?.into());
    }
    if expression.is_kind("Identifier") {
        return Ok(context.text(expression)?.into());
    }
    if expression.is_kind("ElementAccessExpression")
        && let Some(argument) = expression.node("argumentExpression")?
        && argument.is_kind("StringLiteral")
    {
        return Ok(argument
            .literal_text()?
            .expect("native string literal has text"));
    }
    Ok("(dynamic)".into())
}
fn global_augmentation(declaration: &NativeNode) -> Result<bool, TsgoError> {
    let mut current = declaration.parent()?;
    while let Some(ancestor) = current {
        if ancestor.is_kind("ModuleDeclaration")
            && let Some(name) = ancestor.node("name")?
            && name.is_kind("Identifier")
            && name.literal_text()?.is_some_and(|name| name == "global")
        {
            return Ok(true);
        }
        current = ancestor.parent()?;
    }
    Ok(false)
}
fn merge_rank(
    context: &mut TypeContext<'_, '_>,
    declaration: &NativeNode,
) -> Result<usize, TsgoError> {
    if global_augmentation(declaration)? {
        return Ok(3);
    }
    Ok(match context.library_kind(&declaration.source_file())? {
        Some(LibraryKind::Referenced) => 0,
        None => 1,
        Some(LibraryKind::Root) => 2,
    })
}
fn resolve_callee(
    context: &mut TypeContext<'_, '_>,
    call: &NativeNode,
) -> Result<ResolvedCallee, TsgoError> {
    let expression = call.required_node("expression")?;
    let mut id = JsString::from("external:");
    id.extend(&simple_callee_name(context, &expression)?);
    let mut external = ResolvedCallee {
        callee_id: id,
        declaration: None,
    };
    let Some(symbol) = context.symbol_of(&expression)? else {
        return Ok(external);
    };
    let target = context.aliased_symbol(&symbol)?.unwrap_or(symbol);
    let declarations = context.declarations_of(&target)?;
    for declaration in &declarations {
        if let Some(id) = enclosing_id(declaration, &context.node_to_id)? {
            return Ok(ResolvedCallee {
                callee_id: id.into(),
                declaration: None,
            });
        }
    }
    for declaration in &declarations {
        if let Some(id) = workspace_id(context, declaration, &target.name())? {
            return Ok(ResolvedCallee {
                callee_id: id,
                declaration: None,
            });
        }
    }
    let mut first = None;
    let mut first_rank = usize::MAX;
    for declaration in &declarations {
        let rank = merge_rank(context, declaration)?;
        if rank < first_rank {
            first = Some(declaration);
            first_rank = rank;
        }
    }
    if let Some(first) = first {
        external.declaration = Some(qualified_declaration(context, first, &target.name())?);
    }
    Ok(external)
}
pub fn resolve_callees(
    context: &mut TypeContext<'_, '_>,
    call: &NativeNode,
    factories: &mut FactoryResolver,
) -> Result<Vec<ResolvedCallee>, TsgoError> {
    let forwarded = factories.resolve(context, call)?;
    if forwarded.is_empty() {
        return Ok(vec![resolve_callee(context, call)?]);
    }
    Ok(forwarded
        .into_iter()
        .map(|id| ResolvedCallee {
            callee_id: id.into(),
            declaration: None,
        })
        .collect())
}
