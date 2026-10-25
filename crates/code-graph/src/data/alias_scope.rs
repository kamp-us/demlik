use crate::syntax::{bindings::pattern_names, file::NodeRef};
use indexmap::IndexMap;

fn function_like(node: NodeRef<'_>) -> bool {
    matches!(
        node.kind(),
        "ArrowFunctionExpression" | "FunctionExpression" | "FunctionDeclaration"
    )
}
fn var_scope(node: NodeRef<'_>) -> bool {
    function_like(node) || node.kind() == "StaticBlock"
}
fn declarator_names(declaration: NodeRef<'_>) -> Vec<String> {
    declaration
        .nodes("declarations")
        .into_iter()
        .flat_map(|node| pattern_names(node.node("id")))
        .collect()
}
fn var_names(root: NodeRef<'_>) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if node.kind() == "VariableDeclaration" && node.string("kind") == Some("var") {
            names.extend(declarator_names(node));
        }
        pending.extend(
            node.children()
                .into_iter()
                .rev()
                .filter(|child| !var_scope(*child)),
        );
    }
    names
}
fn lexical_names<'a>(statements: impl IntoIterator<Item = NodeRef<'a>>) -> Vec<String> {
    let mut names = Vec::new();
    for statement in statements {
        let node = if statement.kind().starts_with("Export") {
            statement.node("declaration").unwrap_or(statement)
        } else {
            statement
        };
        match node.kind() {
            "VariableDeclaration" if node.string("kind") != Some("var") => {
                names.extend(declarator_names(node))
            }
            "FunctionDeclaration" | "ClassDeclaration" => {
                names.extend(pattern_names(node.node("id")))
            }
            _ => {}
        }
    }
    names
}
fn var_scope_names(node: NodeRef<'_>) -> Vec<String> {
    let mut names = lexical_names(node.nodes("body"));
    names.extend(var_names(node));
    names
}
fn function_names(node: NodeRef<'_>) -> Vec<String> {
    let mut names = node
        .nodes("params")
        .into_iter()
        .flat_map(|node| pattern_names(Some(node)))
        .collect::<Vec<_>>();
    if node.kind() == "FunctionExpression" {
        names.extend(pattern_names(node.node("id")));
    }
    if let Some(body) = node
        .node("body")
        .filter(|body| body.kind() == "BlockStatement")
    {
        names.extend(var_scope_names(body));
    }
    names
}
fn scope_names(node: NodeRef<'_>) -> Option<Vec<String>> {
    match node.kind() {
        "Program" | "StaticBlock" => Some(var_scope_names(node)),
        "ArrowFunctionExpression" | "FunctionExpression" | "FunctionDeclaration" => {
            Some(function_names(node))
        }
        "BlockStatement" => {
            if node
                .parent()
                .is_some_and(|parent| function_like(parent) && parent.node("body") == Some(node))
            {
                None
            } else {
                Some(lexical_names(node.nodes("body")))
            }
        }
        "ForStatement" => Some(lexical_names(node.node("init"))),
        "ForInStatement" | "ForOfStatement" => Some(lexical_names(node.node("left"))),
        "SwitchStatement" => Some(lexical_names(
            node.nodes("cases")
                .into_iter()
                .flat_map(|case| case.nodes("consequent")),
        )),
        "CatchClause" => Some(pattern_names(node.node("param"))),
        _ => None,
    }
}
pub(super) struct AliasScopes<'a, D> {
    frames: Vec<IndexMap<String, Option<&'a D>>>,
}
impl<'a, D> AliasScopes<'a, D> {
    pub(super) fn new() -> Self {
        Self {
            frames: vec![IndexMap::new()],
        }
    }
    pub(super) fn enter(&mut self, node: NodeRef<'_>) -> bool {
        let Some(names) = scope_names(node) else {
            return false;
        };
        self.frames
            .push(names.into_iter().map(|name| (name, None)).collect());
        true
    }
    pub(super) fn leave(&mut self, opened: bool) {
        if opened {
            self.frames.pop();
        }
    }
    fn declaring(&self, name: &str) -> usize {
        self.frames
            .iter()
            .rposition(|frame| frame.contains_key(name))
            .unwrap_or(self.frames.len() - 1)
    }
    pub(super) fn bind(&mut self, name: &str, decl: &'a D) {
        let scope = self.declaring(name);
        self.frames[scope].insert(name.to_owned(), Some(decl));
    }
    pub(super) fn resolve(&self, name: &str) -> Option<&'a D> {
        let scope = self.declaring(name);
        self.frames[scope].get(name).copied().flatten()
    }
}
