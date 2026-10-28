use crate::{
    boundaries::violation::{BoundaryViolation, False},
    extract::wrangler_config::BindingCatalog,
    project::{Collation, CollationError, CollationInput},
    scc::{scc_members, strongly_connected_components},
    schema::BindingKind,
    text::JsString,
};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerEdge {
    pub from: JsString,
    pub binding: JsString,
    pub to: JsString,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WorkerGraph {
    pub workers: Vec<JsString>,
    pub edges: Vec<WorkerEdge>,
    pub unresolved: usize,
}
pub fn worker_graph(
    catalog: &BindingCatalog,
    collation: &Collation,
) -> Result<WorkerGraph, CollationError> {
    let mut workers = catalog
        .manifests
        .iter()
        .map(|manifest| &manifest.service)
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(|name| CollationInput::from_utf16(name.units()).map(|key| (name.clone(), key)))
        .collect::<Result<Vec<_>, _>>()?;
    workers.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let workers: Vec<_> = workers.into_iter().map(|(name, _)| name).collect();
    let known: IndexSet<_> = workers.iter().collect();
    let mut edges = Vec::new();
    let mut unresolved = 0;
    for manifest in &catalog.manifests {
        for declaration in &manifest.bindings {
            if declaration.kind != BindingKind::Service {
                continue;
            }
            if !known.contains(&declaration.target_service) {
                unresolved += 1;
            } else if declaration.target_service != manifest.service {
                edges.push(WorkerEdge {
                    from: manifest.service.clone(),
                    binding: declaration.binding.clone(),
                    to: declaration.target_service.clone(),
                });
            }
        }
    }
    Ok(WorkerGraph {
        workers,
        edges,
        unresolved,
    })
}
fn join<'a>(parts: impl IntoIterator<Item = &'a JsString>, separator: &str) -> JsString {
    let mut result = JsString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            result.push_str(separator);
        }
        result.extend(part);
    }
    result
}
pub fn worker_cycles(
    graph: &WorkerGraph,
    collation: &Collation,
) -> Result<Vec<BoundaryViolation>, CollationError> {
    let mut adjacency: HashMap<_, Vec<_>> = graph
        .workers
        .iter()
        .cloned()
        .map(|worker| (worker, vec![]))
        .collect();
    for edge in &graph.edges {
        if let Some(adjacent) = adjacency.get_mut(&edge.from) {
            adjacent.push(edge.to.clone());
        }
    }
    let components = strongly_connected_components(&graph.workers, &adjacency);
    let mut rows = Vec::new();
    for members in scc_members(&graph.workers, &components)
        .into_values()
        .filter(|members| members.len() > 1)
    {
        let inside: IndexSet<_> = members.iter().collect();
        let edges: Vec<_> = graph
            .edges
            .iter()
            .filter(|edge| inside.contains(&edge.from) && inside.contains(&edge.to))
            .collect();
        let mut presentation = members
            .iter()
            .map(|name| CollationInput::from_utf16(name.units()).map(|key| (name, key)))
            .collect::<Result<Vec<_>, _>>()?;
        presentation.sort_by(|a, b| collation.compare(&a.1, &b.1));
        let from = join(presentation.iter().map(|(name, _)| *name), ", ");
        let mut written = edges
            .into_iter()
            .map(|edge| {
                let mut text = edge.from.clone();
                text.push_str(".");
                text.extend(&edge.binding);
                text.push_str(" -> ");
                text.extend(&edge.to);
                CollationInput::from_utf16(text.units()).map(|key| (text, key))
            })
            .collect::<Result<Vec<_>, _>>()?;
        written.sort_by(|a, b| collation.compare(&a.1, &b.1));
        let specifier = join(written.iter().map(|(text, _)| text), "; ");
        let key = CollationInput::from_utf16(from.units())?;
        rows.push((from, specifier, key));
    }
    rows.sort_by(|a, b| collation.compare(&a.2, &b.2));
    Ok(rows
        .into_iter()
        .map(|(from, specifier, _)| BoundaryViolation::WorkerCallCycle {
            from,
            to: (),
            specifier,
            type_only: False,
        })
        .collect())
}
