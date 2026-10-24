use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

use super::functions::{DiscoveredFunction, is_class_field, is_property_assignment};
use crate::syntax::file::{NodeRef, SyntaxFile, is_accessor_kind};
use crate::syntax::trivia::CommentRange;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionMetrics {
    pub loc: usize,
    pub comment_lines: usize,
    pub nesting_depth: usize,
    pub complexity: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommentSpan {
    pub pos: usize,
    pub end: usize,
    pub text: String,
}

fn complexity_node(node: NodeRef<'_>) -> bool {
    matches!(
        node.kind(),
        "IfStatement"
            | "ConditionalExpression"
            | "ForStatement"
            | "ForInStatement"
            | "ForOfStatement"
            | "WhileStatement"
            | "DoWhileStatement"
            | "CatchClause"
    ) || node.kind() == "SwitchCase" && node.node("test").is_some()
        || node.kind() == "LogicalExpression"
            && matches!(node.string("operator"), Some("&&" | "||" | "??"))
}

fn bound_expression(node: NodeRef<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    parent.kind() == "VariableDeclarator"
        || is_property_assignment(parent)
        || is_class_field(parent)
        || matches!(
            parent.kind(),
            "ExportDefaultDeclaration" | "TSExportAssignment"
        )
        || node.kind() == "FunctionExpression" && node.node("id").is_some()
}

fn named_callable(node: NodeRef<'_>) -> bool {
    match node.kind() {
        "FunctionDeclaration" => node.node("id").is_some(),
        "MethodDefinition" | "TSAbstractMethodDefinition" => true,
        "Property" => {
            node.parent()
                .is_some_and(|parent| parent.kind() == "ObjectExpression")
                && (node.boolean("method") == Some(true) || is_accessor_kind(node))
        }
        "TSMethodSignature" => is_accessor_kind(node),
        "ArrowFunctionExpression" | "FunctionExpression" => bound_expression(node),
        _ => false,
    }
}

fn depth_increasing(node: NodeRef<'_>) -> bool {
    match node.kind() {
        "BlockStatement" => node
            .parent()
            .is_some_and(|parent| parent.kind() == "IfStatement"),
        "ForStatement" | "ForInStatement" | "ForOfStatement" | "WhileStatement"
        | "DoWhileStatement" | "SwitchStatement" | "CatchClause" => true,
        "ArrowFunctionExpression" | "FunctionExpression" => !named_callable(node),
        _ => false,
    }
}

fn walk_body(root: NodeRef<'_>) -> (usize, usize) {
    let mut complexity = 1;
    let mut max_depth = 0;
    let mut pending = Vec::new();
    for child in root.ts_children() {
        complexity += usize::from(complexity_node(child));
        let depth = usize::from(depth_increasing(child));
        max_depth = max_depth.max(depth);
        pending.push((child, depth));
    }
    while let Some((node, depth)) = pending.pop() {
        for child in node.ts_children() {
            if named_callable(child) {
                continue;
            }
            complexity += usize::from(complexity_node(child));
            let child_depth = depth + usize::from(depth_increasing(child));
            max_depth = max_depth.max(child_depth);
            pending.push((child, child_depth));
        }
    }
    (complexity, max_depth)
}

fn token_starts(node: NodeRef<'_>) -> Vec<usize> {
    let trivia = node.syntax().trivia();
    match node.kind() {
        "LogicalExpression" | "BinaryExpression" | "AssignmentExpression" => node
            .node("left")
            .map_or_else(Vec::new, |left| vec![trivia.next_token_start(left.end())]),
        "ConditionalExpression" => match (node.node("test"), node.node("consequent")) {
            (Some(test), Some(consequent)) => vec![
                trivia.next_token_start(test.end()),
                trivia.next_token_start(consequent.end()),
            ],
            _ => Vec::new(),
        },
        "ArrowFunctionExpression" => node.node("body").map_or_else(Vec::new, |body| {
            vec![trivia.previous_token_end(body.start()).saturating_sub(2)]
        }),
        _ => node
            .nodes("decorators")
            .last()
            .map_or_else(Vec::new, |last| vec![trivia.next_token_start(last.end())]),
    }
}

fn token_ends(node: NodeRef<'_>, starts: &[usize]) -> Vec<usize> {
    starts
        .iter()
        .map(|start| {
            let ch = node.syntax().text_units().get(*start).copied();
            if matches!(ch, Some(63 | 58)) {
                start + 1
            } else if node.kind() == "ArrowFunctionExpression" {
                start + 2
            } else {
                start + node.string("operator").map_or(0, str::len)
            }
        })
        .collect()
}

fn has_ts_start(node: NodeRef<'_>) -> bool {
    if matches!(node.kind(), "TSTypeAnnotation" | "ClassBody") {
        return false;
    }
    !matches!(
        node.kind(),
        "FunctionDeclaration"
            | "TSDeclareFunction"
            | "ClassDeclaration"
            | "TSInterfaceDeclaration"
            | "TSTypeAliasDeclaration"
            | "TSEnumDeclaration"
            | "TSModuleDeclaration"
            | "TSImportEqualsDeclaration"
    ) || node.ts_start() == node.start()
}

fn visit_boundaries(root: NodeRef<'_>, mut visit: impl FnMut(bool, usize)) {
    for node in root.ts_descendants() {
        if has_ts_start(node) {
            visit(true, node.start());
        }
        visit(false, node.end());
        let starts = token_starts(node);
        for start in &starts {
            visit(true, *start);
        }
        for end in token_ends(node, &starts) {
            visit(false, end);
        }
    }
}

pub fn comment_line_span(syntax: &SyntaxFile, span: CommentRange) -> (usize, usize) {
    (syntax.line_of(span.pos), syntax.line_of(span.end))
}

pub fn comment_line_numbers(syntax: &SyntaxFile, ranges: &[CommentRange]) -> IndexSet<usize> {
    ranges
        .iter()
        .flat_map(|range| {
            let (start, end) = comment_line_span(syntax, *range);
            start..=end
        })
        .collect()
}

pub fn count_comment_lines(syntax: &SyntaxFile, ranges: &[CommentRange]) -> usize {
    comment_line_numbers(syntax, ranges).len()
}

pub fn compute_function_metrics(function: &DiscoveredFunction) -> FunctionMetrics {
    let node = function.node();
    let syntax = &function.unit.syntax;
    let trivia = syntax.trivia();
    let start = node.ts_start();
    let end = node.end();
    let mut ranges = trivia.leading_at(start);
    visit_boundaries(node, |leading, position| {
        let found = if leading {
            trivia.leading_at(position)
        } else {
            trivia.trailing_at(position)
        };
        ranges.extend(
            found
                .into_iter()
                .filter(|range| range.pos >= start && range.pos < end),
        );
    });
    let (complexity, nesting_depth) = walk_body(node);
    FunctionMetrics {
        loc: node.end_line() - node.start_line() + 1,
        comment_lines: count_comment_lines(syntax, &ranges),
        nesting_depth,
        complexity,
    }
}

fn closing_token_starts(node: NodeRef<'_>) -> Vec<usize> {
    let syntax = node.syntax();
    let mut out = Vec::new();
    if node.end() > 0
        && matches!(
            syntax.text_units().get(node.end() - 1),
            Some(125 | 41 | 93 | 59)
        )
    {
        out.push(node.end() - 1);
    }
    if matches!(node.kind(), "ImportDeclaration" | "ExportNamedDeclaration")
        && let Some(last) = node.nodes("specifiers").last()
    {
        let mut at = syntax.trivia().next_token_start(last.end());
        if syntax.text_units().get(at) == Some(&44) {
            at = syntax.trivia().next_token_start(at + 1);
        }
        if syntax.text_units().get(at) == Some(&125) {
            out.push(at);
        }
    }
    out
}

pub fn collect_module_comment_ranges(syntax: &SyntaxFile) -> Vec<CommentSpan> {
    let mut spans = IndexMap::<usize, CommentSpan>::new();
    let mut add = |ranges: Vec<CommentRange>| {
        for range in ranges {
            spans.entry(range.pos).or_insert_with(|| CommentSpan {
                pos: range.pos,
                end: range.end,
                text: syntax.slice(range.pos, range.end),
            });
        }
    };
    let trivia = syntax.trivia();
    visit_boundaries(syntax.root(), |leading, position| {
        add(if leading {
            trivia.leading_at(position)
        } else {
            trivia.trailing_at(position)
        })
    });
    for node in syntax.root().ts_descendants() {
        for start in closing_token_starts(node) {
            add(trivia.leading_at(start));
        }
        if node.kind() == "JSXExpressionContainer"
            && node
                .node("expression")
                .is_some_and(|expression| expression.kind() == "JSXEmptyExpression")
        {
            let pos = node.start() + 1;
            let end = node.end().saturating_sub(1);
            if end > pos {
                add(vec![CommentRange { pos, end }]);
            }
        }
    }
    add(trivia.leading_at(syntax.text_units().len()));
    add(trivia.trailing_at(syntax.text_units().len()));
    let mut spans: Vec<_> = spans.into_values().collect();
    spans.sort_by_key(|span| span.pos);
    spans
}

pub fn module_comment_lines(syntax: &SyntaxFile) -> usize {
    count_comment_lines(
        syntax,
        &collect_module_comment_ranges(syntax)
            .iter()
            .map(|span| CommentRange {
                pos: span.pos,
                end: span.end,
            })
            .collect::<Vec<_>>(),
    )
}

pub fn module_loc(syntax: &SyntaxFile) -> usize {
    syntax.line_count()
}
