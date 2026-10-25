use super::{
    impure::{GLOBAL_OBJECT, impure_bare_new_of, impure_modules_opened, impure_path_of},
    rules::join,
};
use crate::{
    project::locale_compare_units,
    syntax::{
        bindings::pattern_names,
        file::{NodeRef, SyntaxFile},
        imports::ImportEdge,
    },
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImpureUse {
    pub name: JsString,
    pub path: Vec<JsString>,
}
pub struct ImpureFacts<'a> {
    pub impure_uses: &'a [ImpureUse],
    pub import_edges: &'a [ImportEdge],
    pub runtime_specifiers: &'a IndexSet<JsString>,
}
pub fn impure_names_of(file: ImpureFacts<'_>) -> Vec<JsString> {
    file.impure_uses
        .iter()
        .map(|usage| usage.name.clone())
        .chain(impure_modules_opened(
            file.import_edges,
            file.runtime_specifiers,
        ))
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect()
}
fn code_children<'a>(node: NodeRef<'a>) -> impl Iterator<Item = NodeRef<'a>> {
    node.children().into_iter().filter(|node| {
        !node.kind().starts_with("TS")
            || matches!(
                node.kind(),
                "TSAsExpression"
                    | "TSSatisfiesExpression"
                    | "TSNonNullExpression"
                    | "TSTypeAssertion"
                    | "TSInstantiationExpression"
                    | "TSParameterProperty"
                    | "TSModuleDeclaration"
                    | "TSModuleBlock"
                    | "TSExportAssignment"
            )
    })
}
fn bindings_of(node: NodeRef<'_>) -> Vec<String> {
    match node.kind() {
        "VariableDeclaration" => {
            if node.boolean("declare") == Some(true) {
                Vec::new()
            } else {
                node.nodes("declarations")
                    .into_iter()
                    .flat_map(|declaration| pattern_names(declaration.node("id")))
                    .collect()
            }
        }
        "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression" => {
            let mut names = pattern_names(node.node("id"));
            names.extend(
                node.nodes("params")
                    .into_iter()
                    .flat_map(|param| pattern_names(Some(param))),
            );
            names
        }
        "ClassDeclaration" | "ClassExpression" => pattern_names(node.node("id")),
        "CatchClause" => pattern_names(node.node("param")),
        "ImportSpecifier" | "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" => {
            pattern_names(node.node("local"))
        }
        _ => Vec::new(),
    }
}
fn bound_names(syntax: &SyntaxFile) -> IndexSet<JsString> {
    let mut bound = IndexSet::new();
    let mut pending = vec![syntax.root()];
    while let Some(node) = pending.pop() {
        bound.extend(bindings_of(node).into_iter().map(Into::into));
        pending.extend(code_children(node));
    }
    bound
}
#[derive(Clone)]
struct Chain<'a> {
    root: JsString,
    segments: Vec<JsString>,
    open: bool,
    dynamic: Vec<NodeRef<'a>>,
}
fn identifier(node: NodeRef<'_>) -> JsString {
    node.string("name").unwrap_or("undefined").into()
}
fn string_literal(node: NodeRef<'_>) -> Option<JsString> {
    (node.kind() == "Literal")
        .then(|| node.string_units("value"))?
        .map(|units| JsString::from_units(units.into_owned()))
}
fn static_step(member: NodeRef<'_>, property: NodeRef<'_>) -> Option<JsString> {
    if member.boolean("computed") == Some(true) {
        string_literal(property)
    } else {
        (property.kind() == "Identifier").then(|| identifier(property))
    }
}
fn chain_of(node: NodeRef<'_>) -> Option<Chain<'_>> {
    if node.kind() == "Identifier" {
        return Some(Chain {
            root: identifier(node),
            segments: Vec::new(),
            open: true,
            dynamic: Vec::new(),
        });
    }
    if matches!(
        node.kind(),
        "ChainExpression"
            | "ParenthesizedExpression"
            | "TSNonNullExpression"
            | "TSAsExpression"
            | "TSSatisfiesExpression"
            | "TSTypeAssertion"
            | "TSInstantiationExpression"
    ) {
        return node.node("expression").and_then(chain_of);
    }
    if node.kind() != "MemberExpression" {
        return None;
    }
    let mut base = chain_of(node.node("object")?)?;
    let Some(property) = node.node("property") else {
        base.open = false;
        return Some(base);
    };
    let name = base.open.then(|| static_step(node, property)).flatten();
    base.open = name.is_some();
    if let Some(name) = name {
        base.segments.push(name);
    }
    if node.boolean("computed") == Some(true) && string_literal(property).is_none() {
        base.dynamic.push(property);
    }
    Some(base)
}
fn is_name(node: NodeRef<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let computable = match parent.kind() {
        "MemberExpression" => Some("property"),
        "Property" | "MethodDefinition" | "PropertyDefinition" | "AccessorProperty" => Some("key"),
        _ => None,
    };
    if let Some(key) = computable
        && parent.node(key) == Some(node)
    {
        return parent.boolean("computed") != Some(true);
    }
    let plain: &[&str] = match parent.kind() {
        "LabeledStatement" | "BreakStatement" | "ContinueStatement" => &["label"],
        "MetaProperty" => &["meta", "property"],
        "ExportSpecifier" => &["local", "exported"],
        "ExportAllDeclaration" => &["exported"],
        "ImportAttribute" => &["key"],
        "TSModuleDeclaration" => &["id"],
        _ => &[],
    };
    plain.iter().any(|key| parent.node(key) == Some(node))
}
struct Scan {
    bound: IndexSet<JsString>,
    found: IndexMap<JsString, ImpureUse>,
}
impl Scan {
    fn record(&mut self, name: JsString, path: &[JsString]) {
        let mut key = name.clone();
        key.push_str("\0");
        key.extend(&join(&path.iter().collect::<Vec<_>>(), "\0"));
        self.found.insert(
            key,
            ImpureUse {
                name,
                path: path.to_vec(),
            },
        );
    }
    fn record_path(&mut self, path: &[JsString]) {
        if !path.first().is_some_and(|root| self.bound.contains(root))
            && let Some(name) = impure_path_of(path)
        {
            self.record(name, path);
        }
    }
    fn record_chain(&mut self, chain: &Chain<'_>) {
        let mut path = vec![chain.root.clone()];
        path.extend(chain.segments.iter().cloned());
        self.record_path(&path);
        while path.len() > 1
            && path[0] == GLOBAL_OBJECT
            && !self.bound.contains(&JsString::from(GLOBAL_OBJECT))
        {
            path.remove(0);
            self.record_path(&path);
        }
    }
    fn visit(&mut self, node: NodeRef<'_>) {
        if node.kind() == "ImportDeclaration" || is_name(node) {
            return;
        }
        if let Some(chain) = chain_of(node) {
            self.record_chain(&chain);
            for expression in chain.dynamic {
                self.visit(expression);
            }
            return;
        }
        self.record_bare_new(node);
        self.record_destructured(node);
        for child in code_children(node) {
            self.visit(child);
        }
    }
    fn record_bare_new(&mut self, node: NodeRef<'_>) {
        if node.kind() != "NewExpression" || !node.nodes("arguments").is_empty() {
            return;
        }
        let Some(callee) = node
            .node("callee")
            .filter(|callee| callee.kind() == "Identifier")
        else {
            return;
        };
        let ctor = identifier(callee);
        if !self.bound.contains(&ctor)
            && let Some(name) = impure_bare_new_of(&ctor)
        {
            self.record(name.clone(), &[name]);
        }
    }
    fn record_destructured(&mut self, node: NodeRef<'_>) {
        let (pattern, source) = match node.kind() {
            "VariableDeclarator" => ("id", "init"),
            "AssignmentExpression" | "AssignmentPattern" => ("left", "right"),
            _ => return,
        };
        let Some(pattern) = node.node(pattern) else {
            return;
        };
        let Some(base) = node.node(source).and_then(chain_of) else {
            return;
        };
        self.destructure(&base, pattern);
    }
    fn destructure(&mut self, chain: &Chain<'_>, pattern: NodeRef<'_>) {
        if pattern.kind() != "ObjectPattern" || !chain.open {
            return;
        }
        for property in pattern.nodes("properties") {
            if property.kind() != "Property" {
                continue;
            }
            let Some(name) = key_name(property) else {
                continue;
            };
            let mut child = chain.clone();
            child.segments.push(name);
            self.record_chain(&child);
            let target = property.node("value");
            let nested = target.and_then(|target| {
                if target.kind() == "AssignmentPattern" {
                    target.node("left")
                } else {
                    Some(target)
                }
            });
            if let Some(nested) = nested {
                self.destructure(&child, nested);
            }
        }
    }
}
fn key_name(property: NodeRef<'_>) -> Option<JsString> {
    let key = property.node("key")?;
    if property.boolean("computed") != Some(true) && key.kind() == "Identifier" {
        Some(identifier(key))
    } else {
        string_literal(key)
    }
}
pub fn detect_impure_uses(syntax: &SyntaxFile) -> Vec<ImpureUse> {
    let mut scan = Scan {
        bound: bound_names(syntax),
        found: IndexMap::new(),
    };
    for child in code_children(syntax.root()) {
        scan.visit(child);
    }
    let mut found: Vec<_> = scan.found.into_values().collect();
    found.sort_by(|a, b| {
        locale_compare_units(a.name.units(), b.name.units()).then_with(|| {
            let a = join(&a.path.iter().collect::<Vec<_>>(), ".");
            let b = join(&b.path.iter().collect::<Vec<_>>(), ".");
            locale_compare_units(a.units(), b.units())
        })
    });
    found
}
