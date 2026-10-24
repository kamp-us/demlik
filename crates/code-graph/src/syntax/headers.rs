use serde::Serialize;

use super::NodeRef;
use crate::extract::functions::{js_space, name_text};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverloadSignature {
    pub start_line: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FunctionHeader {
    pub text: String,
    pub overloads: Vec<OverloadSignature>,
}

fn export_wrapper(node: NodeRef<'_>) -> bool {
    matches!(
        node.kind(),
        "ExportNamedDeclaration" | "ExportDefaultDeclaration"
    )
}
fn callable_of(node: NodeRef<'_>) -> NodeRef<'_> {
    if matches!(
        node.kind(),
        "MethodDefinition" | "TSAbstractMethodDefinition" | "Property"
    ) {
        node.node("value").unwrap_or(node)
    } else {
        node
    }
}

fn retreat_over_trivia(node: NodeRef<'_>, start: usize, end: usize) -> usize {
    let syntax = node.syntax();
    let mut at = end;
    loop {
        while at > start
            && syntax
                .text_units()
                .get(at - 1)
                .and_then(|ch| char::from_u32(u32::from(*ch)))
                .is_some_and(js_space)
        {
            at -= 1;
        }
        match syntax.comment_start_ending_at(at) {
            Some(comment) if comment >= start => at = comment,
            _ => return at,
        }
    }
}

fn signature_end(node: NodeRef<'_>, start: usize, end: usize) -> usize {
    let at = retreat_over_trivia(node, start, end);
    if at > 0 && matches!(node.syntax().text_units().get(at - 1), Some(59 | 44)) {
        retreat_over_trivia(node, start, at - 1)
    } else {
        at
    }
}

fn declaration_of(node: NodeRef<'_>) -> NodeRef<'_> {
    if export_wrapper(node) {
        node.node("declaration").unwrap_or(node)
    } else {
        node
    }
}
fn declared_name(node: NodeRef<'_>) -> Option<&str> {
    node.node("id").and_then(|id| id.string("name"))
}

fn member_key(node: NodeRef<'_>) -> String {
    let name = node
        .node("key")
        .map_or_else(String::new, |key| name_text(node, key));
    let is_static = match node.boolean("static") {
        Some(true) => "true",
        Some(false) => "false",
        None => "undefined",
    };
    format!(
        "{is_static}:{}:{name}",
        node.string("kind").unwrap_or("undefined")
    )
}

fn same_signature(node: NodeRef<'_>, candidate: NodeRef<'_>) -> bool {
    match node.kind() {
        "FunctionDeclaration" => {
            let declaration = declaration_of(candidate);
            declaration.kind() == "TSDeclareFunction"
                && declared_name(declaration) == declared_name(node)
        }
        "MethodDefinition" => {
            candidate.kind() == "MethodDefinition"
                && candidate
                    .node("value")
                    .is_some_and(|value| value.kind() == "TSEmptyBodyFunctionExpression")
                && member_key(candidate) == member_key(node)
        }
        _ => false,
    }
}

fn overloads_of(node: NodeRef<'_>) -> Vec<OverloadSignature> {
    if callable_of(node).node("body").is_none()
        || !matches!(node.kind(), "FunctionDeclaration" | "MethodDefinition")
    {
        return Vec::new();
    }
    let Some(parent) = node.parent() else {
        return Vec::new();
    };
    let at = if export_wrapper(parent) { parent } else { node };
    let Some(container) = at.parent() else {
        return Vec::new();
    };
    let siblings = container.children();
    let Some(index) = siblings.iter().position(|sibling| *sibling == at) else {
        return Vec::new();
    };
    let mut run = Vec::new();
    for candidate in siblings[..index].iter().rev().copied() {
        if !same_signature(node, candidate) {
            break;
        }
        run.push(declaration_of(candidate));
    }
    run.into_iter()
        .rev()
        .map(|signature| OverloadSignature {
            start_line: signature.start_line(),
            text: signature.syntax().slice(
                signature.ts_start(),
                signature_end(signature, signature.ts_start(), signature.end()),
            ),
        })
        .collect()
}

pub fn function_header(node: NodeRef<'_>) -> FunctionHeader {
    let start = node.ts_start();
    let end = match callable_of(node).node("body") {
        Some(body) => retreat_over_trivia(node, start, body.start()),
        None => signature_end(node, start, node.end()),
    };
    FunctionHeader {
        text: node.syntax().slice(start, end),
        overloads: overloads_of(node),
    }
}
