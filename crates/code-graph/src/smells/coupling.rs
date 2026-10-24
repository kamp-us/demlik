use crate::extract::scc::{scc_members, strongly_connected_components};
use crate::project::locale_compare;
use crate::schema::ModuleNode;
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplingFacts {
    pub boundary: String,
    pub cycle_size: usize,
    pub cross_boundary_out_count: usize,
}
#[derive(Serialize)]
pub struct ValueEdge {
    pub from: String,
    pub to: String,
}
pub fn boundary_of(file: &str, package_roots: &[String]) -> String {
    let mut best = "";
    for root in package_roots {
        if !root.is_empty()
            && (file == root
                || file
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with('/')))
            && root.len() > best.len()
        {
            best = root;
        }
    }
    best.into()
}
pub fn value_edges(modules: &[ModuleNode]) -> Vec<ValueEdge> {
    value_edges_of(modules.iter())
}
pub(crate) fn value_edges_of<'a>(modules: impl Iterator<Item = &'a ModuleNode>) -> Vec<ValueEdge> {
    let modules: Vec<_> = modules.collect();
    let known: HashSet<_> = modules.iter().map(|module| module.file.as_str()).collect();
    let mut seen = HashSet::new();
    let mut edges = Vec::new();
    for module in &modules {
        for edge in &module.import_edges {
            let Some(target) = &edge.target else {
                continue;
            };
            if edge.type_only
                || target == &module.file
                || !known.contains(target.as_str())
                || !seen.insert(format!("{}\t{target}", module.file))
            {
                continue;
            }
            edges.push(ValueEdge {
                from: module.file.clone(),
                to: target.clone(),
            });
        }
    }
    edges.sort_by(|left, right| {
        locale_compare(&left.from, &right.from).then_with(|| locale_compare(&left.to, &right.to))
    });
    edges
}
pub fn coupling_by_file(
    modules: &[ModuleNode],
    package_roots: &[String],
) -> IndexMap<String, CouplingFacts> {
    let edges = value_edges(modules);
    let mut nodes: Vec<_> = modules.iter().map(|module| module.file.clone()).collect();
    nodes.sort_by(|left, right| locale_compare(left, right));
    let mut adjacency: IndexMap<String, Vec<String>> = nodes
        .iter()
        .map(|node| (node.clone(), Vec::new()))
        .collect();
    for edge in &edges {
        if let Some(targets) = adjacency.get_mut(&edge.from) {
            targets.push(edge.to.clone());
        }
    }
    let components = strongly_connected_components(&nodes, &adjacency);
    let mut cycle_sizes = HashMap::new();
    for members in scc_members(&nodes, &components).into_values() {
        if members.len() < 2 {
            continue;
        }
        for member in &members {
            cycle_sizes.insert(member.clone(), members.len());
        }
    }
    let mut cross_out = HashMap::new();
    for edge in edges {
        if boundary_of(&edge.from, package_roots) != boundary_of(&edge.to, package_roots) {
            *cross_out.entry(edge.from).or_insert(0usize) += 1;
        }
    }
    modules
        .iter()
        .map(|module| {
            (
                module.file.clone(),
                CouplingFacts {
                    boundary: boundary_of(&module.file, package_roots),
                    cycle_size: cycle_sizes.get(&module.file).copied().unwrap_or(0),
                    cross_boundary_out_count: cross_out.get(&module.file).copied().unwrap_or(0),
                },
            )
        })
        .collect()
}
