use crate::{
    boundaries::violation::{BoundaryViolation, False},
    extract::wrangler_config::BindingCatalog,
    project::locale_compare_units,
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
pub fn worker_graph(catalog: &BindingCatalog) -> WorkerGraph {
    let known: IndexSet<_> = catalog
        .manifests
        .iter()
        .map(|manifest| &manifest.service)
        .collect();
    let mut workers: Vec<_> = known.iter().map(|name| (*name).clone()).collect();
    workers.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
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
    WorkerGraph {
        workers,
        edges,
        unresolved,
    }
}
fn join(parts: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut result = JsString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            result.push_str(separator);
        }
        result.extend(&part);
    }
    result
}
pub fn worker_cycles(graph: &WorkerGraph) -> Vec<BoundaryViolation> {
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
    let mut rows: Vec<_> = scc_members(&graph.workers, &components)
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|mut members| {
            let inside: IndexSet<_> = members.iter().collect();
            let mut written: Vec<_> = graph
                .edges
                .iter()
                .filter(|edge| inside.contains(&edge.from) && inside.contains(&edge.to))
                .map(|edge| {
                    let mut text = edge.from.clone();
                    text.push_str(".");
                    text.extend(&edge.binding);
                    text.push_str(" -> ");
                    text.extend(&edge.to);
                    text
                })
                .collect();
            written.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
            members.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
            (join(members, ", "), join(written, "; "))
        })
        .collect();
    rows.sort_by(|(a, _), (b, _)| locale_compare_units(a.units(), b.units()));
    rows.into_iter()
        .map(|(from, specifier)| BoundaryViolation::WorkerCallCycle {
            from,
            to: (),
            specifier,
            type_only: False,
        })
        .collect()
}
