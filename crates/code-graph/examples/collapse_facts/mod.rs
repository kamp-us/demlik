use demlik_code_graph::{
    schema::{CallSite, CallerSite, Edges, FunctionKind, FunctionNode, NodeKind},
    text::JsString,
};
use serde::Deserialize;
fn loc() -> usize {
    10
}
fn line() -> usize {
    1
}
fn end_line() -> usize {
    10
}
fn complexity() -> usize {
    2
}
fn nesting() -> usize {
    1
}
fn function() -> KindInput {
    KindInput::Function
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum KindInput {
    Function,
    Method,
    Arrow,
    FunctionExpression,
    Constructor,
    Getter,
    Setter,
}
impl From<KindInput> for FunctionKind {
    fn from(value: KindInput) -> Self {
        match value {
            KindInput::Function => Self::Function,
            KindInput::Method => Self::Method,
            KindInput::Arrow => Self::Arrow,
            KindInput::FunctionExpression => Self::FunctionExpression,
            KindInput::Constructor => Self::Constructor,
            KindInput::Getter => Self::Getter,
            KindInput::Setter => Self::Setter,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct NodeInput {
    id: String,
    name: String,
    file: String,
    #[serde(default = "line")]
    start_line: usize,
    #[serde(default = "end_line")]
    end_line: usize,
    #[serde(default = "loc")]
    loc: usize,
    #[serde(default = "complexity")]
    complexity: usize,
    #[serde(default = "nesting")]
    nesting_depth: usize,
    #[serde(default = "function")]
    kind: KindInput,
    #[serde(default)]
    is_test: bool,
    #[serde(default)]
    no_edges: bool,
    #[serde(default)]
    calls: Vec<CallInput>,
    #[serde(default)]
    callers: Vec<String>,
    #[serde(default)]
    effect: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CallInput {
    callee_id: JsString,
    #[serde(default = "line")]
    line: usize,
    #[serde(default)]
    const_args: Vec<String>,
}
impl NodeInput {
    pub(super) fn into_function(self) -> FunctionNode {
        FunctionNode {
            id: self.id,
            name: self.name,
            file: self.file,
            start_line: self.start_line,
            end_line: self.end_line,
            loc: self.loc,
            complexity: self.complexity,
            nesting_depth: self.nesting_depth,
            kind: self.kind.into(),
            is_test: self.is_test,
            is_exported: true,
            comment_lines: 0,
            edges: (!self.no_edges).then_some(Edges {
                calls: self
                    .calls
                    .into_iter()
                    .map(|c| CallSite {
                        callee_id: c.callee_id,
                        line: c.line,
                        const_args: c.const_args,
                        declaration: None,
                    })
                    .collect(),
                called_by: self
                    .callers
                    .into_iter()
                    .map(|caller_id| CallerSite { caller_id, line: 1 })
                    .collect(),
                call_chain_depth: 0,
            }),
            node_kind: self.effect.then_some(NodeKind::Effect { evidence: vec![] }),
            smells: vec![],
            header: None,
        }
    }
}
