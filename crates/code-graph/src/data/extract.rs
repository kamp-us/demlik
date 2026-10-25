use super::alias_scope::AliasScopes;
use crate::{
    syntax::file::{NodeRef, SyntaxFile},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Site<'a, D> {
    pub decl: &'a D,
    pub method: Option<JsString>,
    pub sql: Option<JsString>,
    pub line: usize,
    pub column: usize,
}
fn env_receiver(node: NodeRef<'_>) -> bool {
    if node.kind() == "Identifier" {
        return node.string("name") == Some("env");
    }
    node.kind() == "MemberExpression"
        && node.boolean("computed") != Some(true)
        && node.node("property").is_some_and(|property| {
            property.kind() == "Identifier" && property.string("name") == Some("env")
        })
}
fn key_name(holder: NodeRef<'_>, key: Option<NodeRef<'_>>) -> Option<JsString> {
    let key = key?;
    if holder.boolean("computed") != Some(true) {
        return (key.kind() == "Identifier")
            .then(|| key.string("name").unwrap_or("undefined").into());
    }
    if key.kind() != "Literal" {
        return None;
    }
    key.string_units("value")
        .map(|units| JsString::from_units(units.into_owned()))
}
fn member_name(node: NodeRef<'_>) -> Option<JsString> {
    key_name(node, node.node("property"))
}
fn env_binding<'a, D>(node: NodeRef<'_>, bindings: &'a IndexMap<JsString, D>) -> Option<&'a D> {
    if node.kind() != "MemberExpression" || !env_receiver(node.node("object")?) {
        return None;
    }
    bindings.get(&member_name(node)?)
}
fn local_name(node: Option<NodeRef<'_>>) -> Option<&str> {
    let node = node?;
    let node = if node.kind() == "AssignmentPattern" {
        node.node("left")?
    } else {
        node
    };
    (node.kind() == "Identifier").then(|| node.string("name").unwrap_or("undefined"))
}
fn declare_aliases<'a, D>(
    node: NodeRef<'_>,
    bindings: &'a IndexMap<JsString, D>,
    aliases: &mut AliasScopes<'a, D>,
) {
    if node.kind() != "VariableDeclarator" {
        return;
    }
    let (Some(id), Some(init)) = (node.node("id"), node.node("init")) else {
        return;
    };
    if id.kind() == "ObjectPattern" && env_receiver(init) {
        for property in id.nodes("properties") {
            if property.kind() != "Property" {
                continue;
            }
            if let (Some(decl), Some(local)) = (
                key_name(property, property.node("key")).and_then(|key| bindings.get(&key)),
                local_name(property.node("value")),
            ) {
                aliases.bind(local, decl);
            }
        }
    } else if id.kind() == "Identifier"
        && let Some(decl) = env_binding(init, bindings)
    {
        aliases.bind(id.string("name").unwrap_or("undefined"), decl);
    }
}
fn alias_initializer(node: NodeRef<'_>) -> bool {
    node.parent().is_some_and(|parent| {
        parent.kind() == "VariableDeclarator"
            && parent.node("init") == Some(node)
            && parent
                .node("id")
                .is_some_and(|id| id.kind() == "Identifier")
    })
}
fn alias_use(node: NodeRef<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        "MemberExpression" => parent.node("object") == Some(node),
        "CallExpression" | "NewExpression" => parent.nodes("arguments").contains(&node),
        _ => false,
    }
}
fn referenced_binding<'a, D>(
    node: NodeRef<'_>,
    bindings: &'a IndexMap<JsString, D>,
    aliases: &AliasScopes<'a, D>,
) -> Option<&'a D> {
    match node.kind() {
        "MemberExpression" if !alias_initializer(node) => env_binding(node, bindings),
        "Identifier" if alias_use(node) => {
            aliases.resolve(node.string("name").unwrap_or("undefined"))
        }
        _ => None,
    }
}
fn literal_text(node: NodeRef<'_>) -> Option<JsString> {
    match node.kind() {
        "Literal" => node.string_units("value"),
        "TemplateLiteral" => node
            .nodes("quasis")
            .first()?
            .string_units_path(&["value", "cooked"]),
        _ => None,
    }
    .map(|units| JsString::from_units(units.into_owned()))
}
fn first_argument_text(member: NodeRef<'_>) -> Option<JsString> {
    let call = member.parent()?;
    if call.kind() != "CallExpression" || call.node("callee") != Some(member) {
        return None;
    }
    literal_text(*call.nodes("arguments").first()?)
}
fn site_at<'a, D>(node: NodeRef<'_>, decl: &'a D) -> Site<'a, D> {
    let member = node.parent().filter(|parent| {
        parent.kind() == "MemberExpression" && parent.node("object") == Some(node)
    });
    Site {
        decl,
        method: member.and_then(member_name),
        sql: member.and_then(first_argument_text),
        line: node.start_line(),
        column: node.start_column(),
    }
}
pub fn binding_sites<'a, D>(
    syntax: &SyntaxFile,
    bindings: &'a IndexMap<JsString, D>,
) -> Vec<Site<'a, D>> {
    fn enter<'a, D>(
        node: NodeRef<'_>,
        bindings: &'a IndexMap<JsString, D>,
        aliases: &mut AliasScopes<'a, D>,
        sites: &mut Vec<Site<'a, D>>,
    ) {
        let opened = aliases.enter(node);
        declare_aliases(node, bindings, aliases);
        if let Some(decl) = referenced_binding(node, bindings, aliases) {
            sites.push(site_at(node, decl));
        }
        for child in node.children() {
            enter(child, bindings, aliases, sites);
        }
        aliases.leave(opened);
    }
    let mut aliases = AliasScopes::new();
    let mut sites = Vec::new();
    enter(syntax.root(), bindings, &mut aliases, &mut sites);
    sites
}
