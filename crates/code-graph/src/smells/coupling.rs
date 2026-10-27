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
#[derive(Serialize)]
pub struct Cycle {
    pub members: Vec<String>,
}
#[derive(Serialize)]
pub struct CrossBoundaryGroup {
    pub from: String,
    pub to: String,
    pub edges: Vec<ValueEdge>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRank {
    pub file: String,
    pub cycle_size: usize,
    pub cross_boundary_out_count: usize,
    pub score: usize,
}
pub struct CouplingAnalysis {
    pub cycles: Vec<Cycle>,
    pub cross_boundary: Vec<CrossBoundaryGroup>,
    pub ranked: Vec<ModuleRank>,
    pub coupling: IndexMap<String, CouplingFacts>,
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
    let cycles = cycles_of(modules, &edges);
    coupling_of(modules, &edges, &cycles, package_roots)
}
fn cycles_of(modules: &[ModuleNode], edges: &[ValueEdge]) -> Vec<Cycle> {
    let mut nodes: Vec<_> = modules.iter().map(|module| module.file.clone()).collect();
    nodes.sort_by(|left, right| locale_compare(left, right));
    let mut adjacency: IndexMap<String, Vec<String>> = nodes
        .iter()
        .map(|node| (node.clone(), Vec::new()))
        .collect();
    for edge in edges {
        if let Some(targets) = adjacency.get_mut(&edge.from) {
            targets.push(edge.to.clone());
        }
    }
    let components = strongly_connected_components(&nodes, &adjacency);
    let mut cycles: Vec<_> = scc_members(&nodes, &components)
        .into_values()
        .filter(|members| members.len() >= 2)
        .map(|mut members| {
            members.sort_by(|a, b| locale_compare(a, b));
            Cycle { members }
        })
        .collect();
    cycles.sort_by(|a, b| locale_compare(&a.members[0], &b.members[0]));
    cycles
}
pub fn find_cycles(modules: &[ModuleNode]) -> Vec<Cycle> {
    cycles_of(modules, &value_edges(modules))
}
fn cross_boundary_of(edges: Vec<ValueEdge>, package_roots: &[String]) -> Vec<CrossBoundaryGroup> {
    let mut groups: IndexMap<String, CrossBoundaryGroup> = IndexMap::new();
    for edge in edges {
        let from = boundary_of(&edge.from, package_roots);
        let to = boundary_of(&edge.to, package_roots);
        if from == to {
            continue;
        }
        groups
            .entry(format!("{from}\t{to}"))
            .or_insert_with(|| CrossBoundaryGroup {
                from,
                to,
                edges: vec![],
            })
            .edges
            .push(edge);
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    for group in &mut groups {
        group.edges.sort_by(|a, b| {
            locale_compare(&a.from, &b.from).then_with(|| locale_compare(&a.to, &b.to))
        });
    }
    groups.sort_by(|a, b| {
        locale_compare(&a.from, &b.from).then_with(|| locale_compare(&a.to, &b.to))
    });
    groups
}
pub fn cross_boundary_edges(
    modules: &[ModuleNode],
    package_roots: &[String],
) -> Vec<CrossBoundaryGroup> {
    cross_boundary_of(value_edges(modules), package_roots)
}
fn coupling_of(
    modules: &[ModuleNode],
    edges: &[ValueEdge],
    cycles: &[Cycle],
    package_roots: &[String],
) -> IndexMap<String, CouplingFacts> {
    let mut cycle_sizes = HashMap::new();
    for cycle in cycles {
        for member in &cycle.members {
            cycle_sizes.insert(member.as_str(), cycle.members.len());
        }
    }
    let mut cross_out = HashMap::new();
    for edge in edges {
        if boundary_of(&edge.from, package_roots) != boundary_of(&edge.to, package_roots) {
            *cross_out.entry(edge.from.as_str()).or_insert(0usize) += 1;
        }
    }
    modules
        .iter()
        .map(|module| {
            (
                module.file.clone(),
                CouplingFacts {
                    boundary: boundary_of(&module.file, package_roots),
                    cycle_size: cycle_sizes.get(module.file.as_str()).copied().unwrap_or(0),
                    cross_boundary_out_count: cross_out
                        .get(module.file.as_str())
                        .copied()
                        .unwrap_or(0),
                },
            )
        })
        .collect()
}
fn rank_of(modules: &[ModuleNode], coupling: &IndexMap<String, CouplingFacts>) -> Vec<ModuleRank> {
    let mut ranked: Vec<_> = modules
        .iter()
        .filter_map(|module| {
            let facts = coupling.get(&module.file)?;
            let score = facts.cycle_size + facts.cross_boundary_out_count;
            (score != 0).then(|| ModuleRank {
                file: module.file.clone(),
                cycle_size: facts.cycle_size,
                cross_boundary_out_count: facts.cross_boundary_out_count,
                score,
            })
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| locale_compare(&a.file, &b.file))
    });
    ranked
}
pub fn rank_modules(modules: &[ModuleNode], package_roots: &[String]) -> Vec<ModuleRank> {
    rank_of(modules, &coupling_by_file(modules, package_roots))
}
pub fn analyze_coupling(modules: &[ModuleNode], package_roots: &[String]) -> CouplingAnalysis {
    let edges = value_edges(modules);
    let cycles = cycles_of(modules, &edges);
    let coupling = coupling_of(modules, &edges, &cycles, package_roots);
    let ranked = rank_of(modules, &coupling);
    let cross_boundary = cross_boundary_of(edges, package_roots);
    CouplingAnalysis {
        cycles,
        cross_boundary,
        ranked,
        coupling,
    }
}
