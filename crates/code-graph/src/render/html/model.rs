use crate::{
    project::{Collation, CollationError, CollationInput},
    schema::{FunctionNode, Graph, ModuleNode, PlanRow, Severity, Smell, Summary},
    smells::plan::{PlanAxis, rank_plan},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{borrow::Cow, collections::BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HtmlSeverity {
    None,
    Warn,
    High,
}
impl HtmlSeverity {
    pub(super) fn color(self) -> &'static str {
        match self {
            Self::None => "#2e9e57",
            Self::Warn => "#d99a1c",
            Self::High => "#d24545",
        }
    }
}
fn worst(smells: &[Smell]) -> HtmlSeverity {
    smells
        .iter()
        .map(|smell| match smell.severity {
            Severity::High => HtmlSeverity::High,
            Severity::Warn => HtmlSeverity::Warn,
        })
        .max()
        .unwrap_or(HtmlSeverity::None)
}
fn kinds<'a>(smells: impl Iterator<Item = &'a Smell>) -> Vec<&'static str> {
    // The canonical SmellKind vocabulary is ASCII; source Array.sort is ordinal here.
    smells
        .map(|smell| smell.kind.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TreemapNode<'g> {
    Directory {
        name: Cow<'g, JsString>,
        children: Vec<TreemapNode<'g>>,
    },
    #[serde(rename_all = "camelCase")]
    File {
        name: &'g str,
        loc: usize,
        severity: HtmlSeverity,
        file: &'g str,
        smell_kinds: Vec<&'static str>,
    },
}
struct Directory<'g> {
    name: Cow<'g, JsString>,
    dirs: IndexMap<&'g str, Directory<'g>>,
    leaves: Vec<TreemapNode<'g>>,
}
impl<'g> Directory<'g> {
    fn new(name: Cow<'g, JsString>) -> Self {
        Self {
            name,
            dirs: IndexMap::new(),
            leaves: vec![],
        }
    }
    fn finish(self, collation: &Collation) -> Result<TreemapNode<'g>, CollationError> {
        let mut dirs = self
            .dirs
            .into_values()
            .map(|dir| CollationInput::from_utf16(dir.name.units()).map(|key| (dir, key)))
            .collect::<Result<Vec<_>, _>>()?;
        dirs.sort_by(|a, b| collation.compare(&a.1, &b.1));
        let mut leaves = self
            .leaves
            .into_iter()
            .map(|leaf| {
                let TreemapNode::File { name, .. } = &leaf else {
                    unreachable!("directory leaves")
                };
                CollationInput::from_text(name).map(|key| (leaf, key))
            })
            .collect::<Result<Vec<_>, _>>()?;
        leaves.sort_by(|a, b| collation.compare(&a.1, &b.1));
        let mut children = dirs
            .into_iter()
            .map(|(dir, _)| dir.finish(collation))
            .collect::<Result<Vec<_>, _>>()?;
        children.extend(leaves.into_iter().map(|(leaf, _)| leaf));
        Ok(TreemapNode::Directory {
            name: self.name,
            children,
        })
    }
}
fn treemap<'g>(graph: &'g Graph, collation: &Collation) -> Result<TreemapNode<'g>, CollationError> {
    let mut by_file: IndexMap<&str, Vec<&FunctionNode>> = IndexMap::new();
    for function in &graph.functions {
        by_file.entry(&function.file).or_default().push(function);
    }
    let name = if graph.root.is_empty() {
        Cow::Owned(JsString::from("."))
    } else {
        Cow::Borrowed(&graph.root)
    };
    let mut root = Directory::new(name);
    for module in &graph.modules {
        let segments: Vec<_> = module
            .file
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let basename = segments.last().copied().unwrap_or(&module.file);
        let mut cursor = &mut root;
        for segment in &segments[..segments.len().saturating_sub(1)] {
            cursor = cursor
                .dirs
                .entry(segment)
                .or_insert_with(|| Directory::new(Cow::Owned(JsString::from(*segment))));
        }
        let functions = by_file
            .get(module.file.as_str())
            .map_or(&[][..], Vec::as_slice);
        let severity = functions
            .iter()
            .map(|function| worst(&function.smells))
            .fold(worst(&module.smells), Ord::max);
        cursor
            .leaves
            .push(file_node(module, basename, functions, severity));
    }
    root.finish(collation)
}
fn file_node<'g>(
    module: &'g ModuleNode,
    name: &'g str,
    functions: &[&FunctionNode],
    severity: HtmlSeverity,
) -> TreemapNode<'g> {
    TreemapNode::File {
        name,
        loc: module.loc,
        severity,
        file: &module.file,
        smell_kinds: kinds(
            module
                .smells
                .iter()
                .chain(functions.iter().flat_map(|function| function.smells.iter())),
        ),
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode<'g> {
    pub id: &'g str,
    pub label: &'g str,
    pub file: &'g str,
    pub start_line: usize,
    pub end_line: usize,
    pub loc: usize,
    pub complexity: usize,
    pub fan_in: usize,
    pub call_chain_depth: usize,
    pub severity: HtmlSeverity,
    pub smell_kinds: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct GraphEdge<'g> {
    pub source: &'g str,
    pub target: &'g str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlGraph<'g> {
    pub nodes: Vec<GraphNode<'g>>,
    pub edges: Vec<GraphEdge<'g>>,
    pub hidden_count: usize,
}
fn fan_in(function: &FunctionNode) -> usize {
    function
        .edges
        .as_ref()
        .map_or(0, |edges| edges.called_by.len())
}
fn call_graph<'g>(
    graph: &'g Graph,
    collation: &Collation,
) -> Result<HtmlGraph<'g>, CollationError> {
    let by_id: IndexMap<&str, &FunctionNode> = graph
        .functions
        .iter()
        .map(|function| (function.id.as_str(), function))
        .collect();
    let targets: Vec<_> = graph
        .functions
        .iter()
        .filter(|function| !function.smells.is_empty() || fan_in(function) >= 3)
        .collect();
    let mut included: IndexMap<&str, bool> = IndexMap::new();
    for function in &targets {
        included.insert(&function.id, true);
    }
    for function in &targets {
        if let Some(edges) = &function.edges {
            for call in &edges.calls {
                if let Ok(text) = call.callee_id.to_utf8()
                    && let Some((id, _)) = by_id.get_key_value(text.as_str())
                {
                    included.entry(*id).or_insert(false);
                }
            }
            for caller in &edges.called_by {
                if let Some((id, _)) = by_id.get_key_value(caller.caller_id.as_str()) {
                    included.entry(*id).or_insert(false);
                }
            }
        }
    }
    let mut nodes = included
        .iter()
        .map(|(id, target)| {
            let function = by_id[id];
            CollationInput::from_text(id).map(|key| {
                (
                    GraphNode {
                        id: &function.id,
                        label: &function.name,
                        file: &function.file,
                        start_line: function.start_line,
                        end_line: function.end_line,
                        loc: function.loc,
                        complexity: function.complexity,
                        fan_in: fan_in(function),
                        call_chain_depth: function
                            .edges
                            .as_ref()
                            .map_or(0, |edges| edges.call_chain_depth),
                        severity: worst(&function.smells),
                        smell_kinds: kinds(function.smells.iter()),
                        hidden: (!target).then_some(true),
                    },
                    key,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    nodes.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let mut seen = IndexSet::new();
    let mut edges = vec![];
    for id in included.keys() {
        if let Some(calls) = &by_id[id].edges {
            for call in &calls.calls {
                let Ok(text) = call.callee_id.to_utf8() else {
                    continue;
                };
                let Some((target, _)) = included.get_key_value(text.as_str()) else {
                    continue;
                };
                if seen.insert(format!("{id} {target}")) {
                    edges.push(GraphEdge { source: id, target });
                }
            }
        }
    }
    let mut edges = edges
        .into_iter()
        .map(|edge| {
            Ok((
                CollationInput::from_text(edge.source)?,
                CollationInput::from_text(edge.target)?,
                edge,
            ))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    edges.sort_by(|a, b| {
        collation
            .compare(&a.0, &b.0)
            .then_with(|| collation.compare(&a.1, &b.1))
    });
    Ok(HtmlGraph {
        nodes: nodes.into_iter().map(|(node, _)| node).collect(),
        edges: edges.into_iter().map(|(_, _, edge)| edge).collect(),
        hidden_count: graph.functions.len() - included.len(),
    })
}
#[derive(Debug, Serialize)]
pub struct HtmlModel<'g> {
    pub summary: &'g Summary,
    pub treemap: TreemapNode<'g>,
    pub graph: HtmlGraph<'g>,
    pub plan: Vec<PlanRow>,
}
pub fn build_html_model<'g>(
    graph: &'g Graph,
    collation: &Collation,
) -> Result<HtmlModel<'g>, CollationError> {
    Ok(HtmlModel {
        summary: &graph.summary,
        treemap: treemap(graph, collation)?,
        graph: call_graph(graph, collation)?,
        plan: rank_plan(&graph.functions, PlanAxis::Rot),
    })
}
